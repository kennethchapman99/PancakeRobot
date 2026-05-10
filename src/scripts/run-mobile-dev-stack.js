import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(rootDir, '.env'), override: false });

const WEB_PORT = String(process.env.WEB_PORT || '3737');
const ADMIN_PORT = String(process.env.WORKFLOW_ADMIN_PORT || '3747');
const DISABLE_NGROK = isTruthy(process.env.PANCAKE_DISABLE_NGROK);
const KILL_EXISTING_NGROK = process.env.PANCAKE_KILL_EXISTING_NGROK !== 'false';

const children = [];

main().catch(error => {
  console.error(`[dev:mobile] ${error.message}`);
  shutdown(1);
});

async function main() {
  const caffeinate = startCaffeinate();
  if (caffeinate) children.push(caffeinate);

  let publicBaseUrl = resolveStaticNgrokUrl();
  let ngrokProcess = null;

  if (!DISABLE_NGROK) {
    if (KILL_EXISTING_NGROK) {
      spawnSync('pkill', ['-f', 'ngrok http'], { stdio: 'ignore' });
    }

    ngrokProcess = startNgrok(publicBaseUrl);
    children.push(ngrokProcess);
    publicBaseUrl = await waitForNgrokPublicUrl(publicBaseUrl);
  }

  if (!publicBaseUrl) publicBaseUrl = `http://localhost:${WEB_PORT}`;

  const childEnv = {
    ...process.env,
    PUBLIC_APP_BASE_URL: publicBaseUrl,
    PUBLIC_BASE_URL: publicBaseUrl,
  };

  console.log(`[dev:mobile] PUBLIC_APP_BASE_URL=${publicBaseUrl}`);
  console.log(`[dev:mobile] Web:   http://localhost:${WEB_PORT}`);
  console.log(`[dev:mobile] Admin: http://localhost:${ADMIN_PORT}/workflow-runs`);

  children.push(startNpmScript('web', childEnv));
  children.push(startNpmScript('workflow:admin', childEnv));
  children.push(startNpmScript('telegram', childEnv));

  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
}

function resolveStaticNgrokUrl() {
  const domain = normalizeNgrokDomain(process.env.NGROK_DOMAIN || process.env.NGROK_STATIC_DOMAIN);
  if (domain) return `https://${domain}`;

  // Safety: PUBLIC_APP_BASE_URL may be stale, random, local, or a placeholder. Do not pass it
  // to ngrok as --url unless the operator explicitly opts in.
  if (isTruthy(process.env.PANCAKE_USE_PUBLIC_APP_BASE_URL_FOR_NGROK)) {
    const explicit = normalizeBaseUrl(process.env.PUBLIC_APP_BASE_URL);
    if (explicit && !isLocalUrl(explicit) && !isInvalidStaticNgrokUrl(explicit)) return explicit;
  }

  return '';
}

function normalizeNgrokDomain(value) {
  const domain = String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  if (!domain || domain === 'ngrok-free.app' || domain === 'your-static-domain.ngrok-free.app') return '';
  return domain;
}

function startNgrok(staticUrl) {
  const args = ['http'];
  if (staticUrl) args.push(`--url=${staticUrl}`);
  args.push(WEB_PORT);

  const child = spawn('ngrok', args, {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  prefixStream(child.stdout, 'ngrok');
  prefixStream(child.stderr, 'ngrok');

  child.on('error', error => {
    console.error(`[ngrok] ${error.message}`);
    console.error('[ngrok] Install/auth ngrok or set PANCAKE_DISABLE_NGROK=true for local-only mode.');
  });

  return child;
}

async function waitForNgrokPublicUrl(preferredUrl) {
  const preferred = normalizeBaseUrl(preferredUrl);
  const deadline = Date.now() + 15000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:4040/api/tunnels');
      const data = await response.json();
      const tunnels = Array.isArray(data.tunnels) ? data.tunnels : [];
      const httpsTunnel = tunnels.find(tunnel => tunnel.proto === 'https' && tunnel.public_url);
      if (httpsTunnel?.public_url) return normalizeBaseUrl(httpsTunnel.public_url);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  if (preferred) return preferred;
  throw new Error(`ngrok did not expose a public URL within 15 seconds${lastError ? `: ${lastError.message}` : ''}`);
}

function startNpmScript(scriptName, env) {
  const child = spawn('npm', ['run', scriptName], {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  prefixStream(child.stdout, scriptName);
  prefixStream(child.stderr, scriptName);

  child.on('exit', (code, signal) => {
    if (code && code !== 0) console.error(`[${scriptName}] exited with code ${code}`);
    if (signal) console.error(`[${scriptName}] exited from signal ${signal}`);
  });

  return child;
}

function startCaffeinate() {
  if (process.platform !== 'darwin') return null;
  const child = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], {
    stdio: 'ignore',
  });
  child.on('error', () => {});
  return child;
}

function prefixStream(stream, label) {
  stream.on('data', chunk => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) console.log(`[${label}] ${line}`);
    }
  });
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLocalUrl(value) {
  const normalized = normalizeBaseUrl(value).toLowerCase();
  return normalized.startsWith('http://localhost') || normalized.startsWith('https://localhost') || normalized.startsWith('http://127.0.0.1') || normalized.startsWith('https://127.0.0.1');
}

function isInvalidStaticNgrokUrl(value) {
  const normalized = normalizeBaseUrl(value).toLowerCase();
  return normalized === 'https://ngrok-free.app' || normalized === 'https://your-static-domain.ngrok-free.app';
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shutdown(code) {
  for (const child of children.reverse()) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 250);
}
