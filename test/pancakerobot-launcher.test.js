import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const launcher = path.join(repoRoot, 'bin', 'pancakerobot');

function hasVolta() {
  return spawnSync('command', ['-v', 'volta'], { shell: true }).status === 0;
}

// Run the launcher and capture its planned command without installing deps or
// actually executing anything (PANCAKE_PLAN_ONLY=1 stops after Node resolution).
function plan(args, extraEnv = {}) {
  const out = execFileSync(launcher, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PANCAKE_PLAN_ONLY: '1', ...extraEnv },
  });
  const fields = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^PANCAKE_PLAN (\w+)=(.*)$/);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

test('`test -- <file>` forwards the file to the test runner (no double --)', () => {
  const p = plan(['test', '--', 'test/magic-release-browsy-recordings.test.js']);
  assert.equal(p.command, 'test');
  assert.equal(p.run, 'npm test -- test/magic-release-browsy-recordings.test.js');
});

test('arbitrary args after -- are passed through in order', () => {
  const p = plan([
    'test',
    '--',
    'test/a.test.js',
    'test/b.test.js',
    '--concurrency',
    '2',
  ]);
  assert.equal(p.run, 'npm test -- test/a.test.js test/b.test.js --concurrency 2');
});

test('`test <file>` works without an explicit -- separator', () => {
  const p = plan(['test', 'test/a.test.js']);
  assert.equal(p.run, 'npm test -- test/a.test.js');
});

test('wrong active Node resolves to Node 22.22.2 via Volta, or fails with a clear Pancake error', () => {
  // Force the resolver past the active shell Node, with no repo-local runtime and
  // downloads disabled, so the only way to succeed is Volta.
  const emptyRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-rt-'));
  const baseEnv = {
    PANCAKE_FORCE_RESOLVE: '1',
    PANCAKE_RUNTIME_DIR: emptyRuntime,
    PANCAKE_DISABLE_DOWNLOAD: '1',
  };

  try {
    if (hasVolta()) {
      const p = plan(['test', '--', 'test/a.test.js'], baseEnv);
      assert.equal(p.node_source, 'volta');
      assert.equal(p.node_version, 'v22.22.2');
      assert.equal(p.run, 'npm test -- test/a.test.js');
    } else {
      const res = spawnSync(launcher, ['test', '--', 'test/a.test.js'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ...baseEnv, PANCAKE_PLAN_ONLY: '1', PANCAKE_DISABLE_VOLTA: '1' },
      });
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /\[Pancake Robot\] Could not provide Node v22\.22\.2/);
      assert.match(res.stderr, /\.\/bin\/pancakerobot/);
    }
  } finally {
    fs.rmSync(emptyRuntime, { recursive: true, force: true });
  }
});

test('with Volta disabled and no runtime, the launcher emits a clear Pancake error', () => {
  const emptyRuntime = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-rt-'));
  try {
    const res = spawnSync(launcher, ['test', '--', 'test/a.test.js'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PANCAKE_FORCE_RESOLVE: '1',
        PANCAKE_RUNTIME_DIR: emptyRuntime,
        PANCAKE_DISABLE_DOWNLOAD: '1',
        PANCAKE_DISABLE_VOLTA: '1',
        PANCAKE_PLAN_ONLY: '1',
      },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Could not provide Node v22\.22\.2/);
    assert.match(res.stderr, /\.\/bin\/pancakerobot test -- test\/<file>\.test\.js/);
  } finally {
    fs.rmSync(emptyRuntime, { recursive: true, force: true });
  }
});

test('--help documents the blessed commands and runs on any Node', () => {
  const out = execFileSync(launcher, ['--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // Help must work even when the active shell Node is wrong: force-resolve would
    // otherwise be irrelevant since help short-circuits before Node resolution.
    env: { ...process.env, PANCAKE_FORCE_RESOLVE: '1', PANCAKE_DISABLE_VOLTA: '1', PANCAKE_DISABLE_DOWNLOAD: '1' },
  });
  assert.match(out, /\.\/bin\/pancakerobot web/);
  assert.match(out, /\.\/bin\/pancakerobot test -- test\/<file>\.test\.js/);
  assert.match(out, /PANCAKE_DISABLE_NGROK=true \.\/bin\/pancakerobot web/);
});
