import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

test('mobile dev stack spawns cloudflared with requested http2 protocol', async () => {
  const fixture = createLauncherFixture({
    cloudflaredBody: `
if (process.argv.includes('--version')) {
  console.log('cloudflared version test');
  process.exit(0);
}
fs.writeFileSync(process.env.CLOUDFLARED_ARGS_FILE, process.argv.slice(2).join('\\n'));
console.log('Settings: map[ha-connections:1 protocol:http2 url:http://localhost:3737]');
console.log('Initial protocol http2');
console.log('https://example-test.trycloudflare.com');
console.log('Registered tunnel connection');
setInterval(() => {}, 1000);
`,
  });

  try {
    const child = spawnLauncher(fixture);
    const output = await waitForOutput(child, /PUBLIC_APP_BASE_URL=https:\/\/example-test\.trycloudflare\.com/);
    child.kill('SIGTERM');

    assert.deepEqual(readFileSync(fixture.argsFile, 'utf8').trim().split('\n'), [
      'tunnel',
      '--protocol',
      'http2',
      '--url',
      'http://localhost:3737',
    ]);
    assert.match(output, /\[dev:mobile\] Spawning cloudflared: cloudflared tunnel --protocol http2 --url http:\/\/localhost:3737/);
    assert.doesNotMatch(output, /protocol:quic|Initial protocol quic/i);
  } finally {
    fixture.cleanup();
  }
});

test('mobile dev stack fails if cloudflared reports quic when http2 was requested', async () => {
  const fixture = createLauncherFixture({
    cloudflaredBody: `
if (process.argv.includes('--version')) {
  console.log('cloudflared version test');
  process.exit(0);
}
fs.writeFileSync(process.env.CLOUDFLARED_ARGS_FILE, process.argv.slice(2).join('\\n'));
console.log('Settings: map[ha-connections:1 protocol:quic url:http://localhost:3737]');
console.log('Initial protocol quic');
setInterval(() => {}, 1000);
`,
  });

  try {
    const child = spawnLauncher(fixture);
    const { code, output } = await waitForExit(child);

    assert.equal(code, 1);
    assert.match(output, /cloudflared started with protocol quic, but PANCAKE_CLOUDFLARE_PROTOCOL requested http2/);
    assert.deepEqual(readFileSync(fixture.argsFile, 'utf8').trim().split('\n'), [
      'tunnel',
      '--protocol',
      'http2',
      '--url',
      'http://localhost:3737',
    ]);
  } finally {
    fixture.cleanup();
  }
});

function createLauncherFixture({ cloudflaredBody }) {
  const dir = mkdtempSync(join(tmpdir(), 'pancake-cloudflare-test-'));
  const binDir = join(dir, 'bin');
  const argsFile = join(dir, 'cloudflared-args.txt');
  writeFileSync(join(dir, 'placeholder'), '');
  mkdirSync(binDir);

  writeExecutable(join(binDir, 'cloudflared'), `#!/usr/bin/env node
import fs from 'node:fs';
${cloudflaredBody}
`);

  writeExecutable(join(binDir, 'npm'), `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);

  return {
    argsFile,
    env: {
      ...process.env,
      PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH}`,
      CLOUDFLARED_ARGS_FILE: argsFile,
      PANCAKE_TUNNEL_PROVIDER: 'cloudflare',
      PANCAKE_CLOUDFLARE_PROTOCOL: 'http2',
      WEB_PORT: '3737',
      WORKFLOW_ADMIN_PORT: '3747',
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_ALLOWED_USER_IDS: '1',
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function spawnLauncher(fixture) {
  return spawn(process.execPath, ['src/scripts/run-mobile-dev-stack.js'], {
    cwd: REPO_ROOT,
    env: fixture.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForOutput(child, pattern) {
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out waiting for ${pattern}; output:\n${output}`));
    }, 5000);

    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
    child.stderr.on('data', chunk => {
      output += chunk.toString();
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`launcher exited before expected output with code ${code}; output:\n${output}`));
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForExit(child) {
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out waiting for launcher exit; output:\n${output}`));
    }, 5000);

    child.stdout.on('data', chunk => {
      output += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      output += chunk.toString();
    });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
