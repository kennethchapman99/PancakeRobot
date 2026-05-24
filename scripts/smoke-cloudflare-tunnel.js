#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const launcher = join(rootDir, 'bin/pancakerobot');
const urlPattern = /\bPUBLIC_APP_BASE_URL=(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\b/i;
const requestedProtocol = 'http2';

const child = spawn(launcher, [], {
  cwd: rootDir,
  env: {
    ...process.env,
    PANCAKE_TUNNEL_PROVIDER: 'cloudflare',
    PANCAKE_CLOUDFLARE_PROTOCOL: 'http2',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let publicUrl = '';
let settled = false;
const recentOutput = [];

child.stdout.on('data', chunk => handleOutput(chunk, false));
child.stderr.on('data', chunk => handleOutput(chunk, true));
child.on('exit', (code, signal) => {
  if (!settled) fail(`launcher exited before smoke completed: exit=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`);
});
child.on('error', error => {
  if (!settled) fail(`failed to start launcher: ${error.message}`);
});

process.once('SIGINT', () => cleanup(130));
process.once('SIGTERM', () => cleanup(143));

const timeout = setTimeout(() => {
  fail('timed out waiting for PUBLIC_APP_BASE_URL from ./bin/pancakerobot');
}, 90000);

function handleOutput(chunk, isError) {
  const text = chunk.toString();
  const stream = isError ? process.stderr : process.stdout;
  stream.write(text);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    recentOutput.push(line);
    if (recentOutput.length > 12) recentOutput.shift();

    const observedProtocol = extractCloudflaredProtocol(line);
    if (observedProtocol && observedProtocol !== requestedProtocol) {
      fail(`cloudflared reported protocol ${observedProtocol}, but ${requestedProtocol} was requested`);
      return;
    }

    if (/Spawning cloudflared:/i.test(line) && !/cloudflared tunnel --protocol http2 --url http:\/\/localhost:3737\b/i.test(line)) {
      fail(`unexpected cloudflared command: ${line}`);
      return;
    }

    const match = line.match(urlPattern);
    if (match && !publicUrl) {
      publicUrl = match[1].replace(/\/+$/, '');
      void probeUntilReady(publicUrl);
    }
  }
}

async function probeUntilReady(url) {
  const deadline = Date.now() + 45000;
  let lastResult = null;

  while (Date.now() < deadline) {
    lastResult = await probe(url);
    if (lastResult.ok) {
      console.log(`[smoke:cloudflare] PASS ${url} responded with HTTP ${lastResult.status}`);
      clearTimeout(timeout);
      settled = true;
      cleanup(0);
      return;
    }
    await delay(1000);
  }

  fail(`public URL did not become reachable: ${url}; last probe: ${formatProbeResult(lastResult)}`);
}

async function probe(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const response = await fetch(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      const body = method === 'GET' ? await response.text().catch(() => '') : '';
      if (response.status === 530 && /error\s*1033|cloudflare tunnel error/i.test(body)) {
        return { ok: false, status: response.status, cloudflare1033: true };
      }
      if (response.status < 500) return { ok: true, status: response.status };
      if (method === 'GET') return { ok: false, status: response.status };
    } catch (error) {
      if (method === 'GET') return { ok: false, error: error.message };
    }
  }
  return { ok: false, error: 'probe failed' };
}

function extractCloudflaredProtocol(line) {
  const text = String(line || '');
  const settingsMatch = text.match(/\bprotocol:([a-z0-9-]+)/i);
  if (settingsMatch) return settingsMatch[1].toLowerCase();

  const initialMatch = text.match(/\bInitial protocol\s+([a-z0-9-]+)/i);
  if (initialMatch) return initialMatch[1].toLowerCase();

  return '';
}

function fail(message) {
  if (settled) return;
  clearTimeout(timeout);
  settled = true;
  console.error(`[smoke:cloudflare] FAIL ${message}`);
  if (recentOutput.length) console.error(`[smoke:cloudflare] recent launcher output: ${recentOutput.join(' | ')}`);
  cleanup(1);
}

function formatProbeResult(result) {
  if (!result) return 'none';
  if (result.cloudflare1033) return `Cloudflare 1033 (status ${result.status})`;
  if (result.status) return `HTTP ${result.status}`;
  return result.error || 'unknown failure';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanup(code) {
  if (!child.killed) child.kill('SIGINT');
  setTimeout(() => process.exit(code), 500);
}
