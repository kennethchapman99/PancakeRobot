import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createReleaseAutomationSupervisor } from '../src/shared/release-automation-supervisor.js';
import { DISTROKID_RUN_EVENT_PREFIX } from '../scripts/distrokid/lib.mjs';

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test('login-required event marks run blocked without finalizing immediately', () => {
  const child = createFakeChild();
  const events = [];
  const supervisor = createReleaseAutomationSupervisor({
    child,
    runId: 'run_blocked',
    action: 'distrokid_preview',
    command: 'node upload-release.mjs --dry-run',
    script: 'scripts/distrokid/upload-release.mjs',
    releaseType: 'single',
    releaseId: 'SONG_BLOCKED',
    logPath: 'output/release-packages/SONG_BLOCKED/distrokid-run/run-log.json',
    logEvent: (status, message, payload) => events.push({ status, message, payload }),
  });

  child.stdout.write(`${DISTROKID_RUN_EVENT_PREFIX}${JSON.stringify({
    status: 'blocked',
    code: 'distrokid_login_required',
    message: 'DistroKid login required. Complete login in the browser, then resume.',
    latest_run_log_path: 'output/release-packages/SONG_BLOCKED/distrokid-run/run-log.json',
  })}\n`);

  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'blocked');
  assert.equal(events[0].payload.active, true);
  assert.equal(supervisor.state.finalized, false);
  assert.deepEqual(child.killCalls, []);
});

test('unexpected child close becomes failed instead of remaining running', () => {
  const child = createFakeChild();
  const events = [];
  createReleaseAutomationSupervisor({
    child,
    runId: 'run_failed',
    action: 'distrokid_preview',
    command: 'node upload-release.mjs --dry-run',
    script: 'scripts/distrokid/upload-release.mjs',
    releaseType: 'single',
    releaseId: 'SONG_FAILED',
    logPath: 'output/release-packages/SONG_FAILED/distrokid-run/run-log.json',
    logEvent: (status, message, payload) => events.push({ status, message, payload }),
  });

  child.emit('exit', 1, null);
  child.emit('close', 1, null);

  assert.equal(events.at(-1).status, 'failed');
  assert.match(events.at(-1).message, /exited unexpectedly/i);
  assert.equal(events.at(-1).payload.active, false);
});

test('cancelled supervisor run persists cancelled status', () => {
  const child = createFakeChild();
  const events = [];
  const supervisor = createReleaseAutomationSupervisor({
    child,
    runId: 'run_cancelled',
    action: 'distrokid_preview',
    command: 'node upload-release.mjs --dry-run',
    script: 'scripts/distrokid/upload-release.mjs',
    releaseType: 'single',
    releaseId: 'SONG_CANCELLED',
    logPath: 'output/release-packages/SONG_CANCELLED/distrokid-run/run-log.json',
    logEvent: (status, message, payload) => events.push({ status, message, payload }),
  });

  supervisor.cancel();
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');

  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(events.at(-1).status, 'cancelled');
  assert.equal(events.at(-1).payload.signal, 'SIGTERM');
});
