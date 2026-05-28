import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertBrowsyPreviewPassed,
  buildBrowsyPayloadFromContract,
  buildReleaseSourceIndex,
  runBrowsyStage,
  runReleaseBrowsyPipeline,
} from '../src/shared/browsy-release-pipeline.js';
import { classifyBrowsyStatus } from '../src/shared/browsy-client.js';

function canonicalFixture({ artworkPath, audioPath } = {}) {
  return {
    release_type: 'single',
    release_id: 'SONG_1',
    release_title: 'Two-Headed Wiener Dog',
    artist: 'Pancake Robot',
    release_date: '2026-06-19',
    primary_genre: 'Children',
    secondary_genre: 'Pop',
    artwork_path: artworkPath || '/abs/cover.png',
    tracks: [{
      song_id: 'SONG_1',
      track_title: 'Two-Headed Wiener Dog',
      audio_path: audioPath || '/abs/track.wav',
      lyrics: 'woof woof',
      explicit: false,
    }],
  };
}

test('buildReleaseSourceIndex surfaces release- and first-track-level values', () => {
  const index = buildReleaseSourceIndex(canonicalFixture());
  assert.equal(index.release_title, 'Two-Headed Wiener Dog');
  assert.equal(index.artist, 'Pancake Robot');
  assert.equal(index.track_title, 'Two-Headed Wiener Dog');
  assert.equal(index.cover_art, '/abs/cover.png');
  assert.equal(index.audio_file, '/abs/track.wav');
});

test('buildBrowsyPayloadFromContract maps required fields and files by binding name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-pipeline-'));
  const artworkPath = path.join(root, 'cover.png');
  const audioPath = path.join(root, 'track.wav');
  fs.writeFileSync(artworkPath, 'art');
  fs.writeFileSync(audioPath, 'audio');

  const contract = {
    contractVersion: '1.0.0',
    requiredPayloadFields: ['artist', 'release_title', 'track_title', 'primary_genre'],
    optionalPayloadFields: ['secondary_genre', 'lyrics'],
    requiredFiles: ['cover_art'],
    requiredAssets: ['audio_file'],
  };
  const { payload, files } = buildBrowsyPayloadFromContract({
    contract,
    canonical: canonicalFixture({ artworkPath, audioPath }),
  });

  assert.equal(payload.artist, 'Pancake Robot');
  assert.equal(payload.release_title, 'Two-Headed Wiener Dog');
  assert.equal(payload.track_title, 'Two-Headed Wiener Dog');
  assert.equal(payload.primary_genre, 'Children');
  assert.equal(payload.secondary_genre, 'Pop');
  assert.equal(payload.cover_art, artworkPath);
  assert.equal(payload.audio_file, audioPath);
  assert.deepEqual(payload.files, { cover_art: artworkPath, audio_file: audioPath });
  assert.deepEqual(files, { cover_art: artworkPath, audio_file: audioPath });

  fs.rmSync(root, { recursive: true, force: true });
});

test('buildBrowsyPayloadFromContract fails loudly when a required field is unmapped', () => {
  const contract = {
    requiredPayloadFields: ['artist', 'mysterious_unknown_binding'],
  };
  assert.throws(
    () => buildBrowsyPayloadFromContract({ contract, canonical: canonicalFixture() }),
    /unmapped required payload fields: mysterious_unknown_binding/,
  );
});

test('buildBrowsyPayloadFromContract fails when a required file is missing on disk', () => {
  const contract = { requiredPayloadFields: [], requiredFiles: ['cover_art'] };
  assert.throws(
    () => buildBrowsyPayloadFromContract({ contract, canonical: canonicalFixture({ artworkPath: '/does/not/exist.png' }) }),
    /required files: cover_art \(file not found/,
  );
});

test('bindingMap override resolves a non-conventional binding name', () => {
  const contract = { requiredPayloadFields: ['weird_title_field'] };
  const { payload } = buildBrowsyPayloadFromContract({
    contract,
    canonical: canonicalFixture(),
    bindingMap: { weird_title_field: 'release_title' },
  });
  assert.equal(payload.weird_title_field, 'Two-Headed Wiener Dog');
});

test('assertBrowsyPreviewPassed enforces completed + no failed steps + captured outputs', () => {
  const contract = { expectedOutputs: ['external_release_url'] };
  assert.doesNotThrow(() => assertBrowsyPreviewPassed({
    status: 'completed',
    failedSteps: [],
    outputs: { external_release_url: { status: 'captured', value: 'https://x', required: true } },
  }, contract));

  assert.throws(() => assertBrowsyPreviewPassed({ status: 'blocked', blockingReason: 'login' }, contract), /did not complete/);
  assert.throws(() => assertBrowsyPreviewPassed({ status: 'completed', failedSteps: ['upload'] }, contract), /failed steps/);
  assert.throws(() => assertBrowsyPreviewPassed({
    status: 'completed',
    failedSteps: [],
    outputs: { external_release_url: { status: 'empty', required: true } },
  }, contract), /did not capture expected outputs/);
});

// --- inline fake BrowsyClients that script run statuses ---------------------

function snapshot(status, result = {}) {
  return { status, result: { status, ...result }, run: { status }, ...classifyBrowsyStatus(status) };
}

test('runBrowsyStage auto-approves an approvable waiting state then completes', async () => {
  const client = {
    starts: [],
    approvals: [],
    async startRun({ mode }) { this.starts.push(mode); return { runId: 'run_live', status: 'running' }; },
    async approve(runId, opts) { this.approvals.push(opts); },
    async pollUntilDone() {
      this._n = (this._n || 0) + 1;
      return this._n === 1 ? snapshot('waiting_for_approval_to_submit') : snapshot('completed');
    },
  };
  const stage = await runBrowsyStage({
    client,
    workflowId: 'w',
    mode: 'live',
    payload: {},
    approvalToken: 'tok',
    autoApprove: true,
  });
  assert.equal(stage.status, 'completed');
  assert.equal(client.approvals.length, 1);
  assert.equal(stage.approvals.length, 1);
});

test('runBrowsyStage surfaces a human-only waiting state without approving', async () => {
  const client = {
    approvals: [],
    async startRun() { return { runId: 'run_live', status: 'running' }; },
    async approve(runId, opts) { this.approvals.push(opts); },
    async pollUntilDone() { return snapshot('waiting_for_2fa'); },
  };
  const stage = await runBrowsyStage({ client, workflowId: 'w', mode: 'live', payload: {}, approvalToken: 'tok', autoApprove: true });
  assert.equal(stage.needsHumanAction, true);
  assert.equal(client.approvals.length, 0);
});

test('runReleaseBrowsyPipeline runs dry_run -> preview, gates, and persists', async () => {
  const contract = {
    contractVersion: '1.0.0',
    supportedModes: ['dry_run', 'preview', 'live'],
    requiredPayloadFields: ['artist', 'release_title'],
    expectedOutputs: [],
  };
  const persisted = [];
  let pollN = 0;
  const client = {
    async getContract() { return contract; },
    async startRun({ mode }) { return { runId: `run_${mode}`, status: 'running' }; },
    async pollUntilDone(runId) {
      pollN += 1;
      return snapshot('completed', { outputs: {}, failedSteps: [] });
    },
    async getArtifacts() { return { artifacts: [], files: [] }; },
  };
  const deps = {
    async buildCanonicalPayload() { return canonicalFixture(); },
    resolveWorkflowId() { return 'distrokid-single-submit'; },
    loadBindingMap() { return {}; },
    async persistBrowsyRun(args) { persisted.push(args); },
  };

  const result = await runReleaseBrowsyPipeline({
    releaseType: 'single',
    releaseId: 'SONG_1',
    stages: ['dry_run', 'preview'],
    client,
    deps,
  });

  assert.equal(result.ok, true);
  assert.equal(result.workflowId, 'distrokid-single-submit');
  assert.equal(result.stages.length, 2);
  assert.equal(result.payload.artist, 'Pancake Robot');
  // Only the real-browser stage (preview) persists; dry_run does not.
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].mode, 'preview');
});

test('runReleaseBrowsyPipeline requires an approvalToken for live', async () => {
  const contract = { supportedModes: ['dry_run', 'preview', 'live'], requiredPayloadFields: [] };
  const client = {
    async getContract() { return contract; },
    async startRun({ mode }) { return { runId: `run_${mode}`, status: 'running' }; },
    async pollUntilDone() { return snapshot('completed'); },
    async getArtifacts() { return { artifacts: [] }; },
  };
  const deps = {
    async buildCanonicalPayload() { return canonicalFixture(); },
    resolveWorkflowId() { return 'distrokid-single-submit'; },
    loadBindingMap() { return {}; },
    async persistBrowsyRun() {},
  };
  await assert.rejects(
    runReleaseBrowsyPipeline({ releaseType: 'single', releaseId: 'SONG_1', stages: ['live'], client, deps }),
    /Live Browsy submission requires an approvalToken/,
  );
});
