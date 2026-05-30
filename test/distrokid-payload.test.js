import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildBrowsyDistroKidWorkflowPackage,
  buildDistroKidPayloadFromCockpit,
} from '../src/shared/distrokid-payload.js';
import {
  buildBrowsyWorkflowRef,
  startBrowsyWorkflowRun,
  executeBrowsyWorkflowRun,
  categorizeBrowsyStatus,
} from '../src/shared/browsy-client.js';
import { resolveDistroKidArtist } from '../src/shared/brand-profile.js';

test('DistroKid artist resolves from brand profile: default is Pancake Robot, all others are Figment Factory', () => {
  assert.equal(resolveDistroKidArtist(null), 'Pancake Robot');
  assert.equal(resolveDistroKidArtist(''), 'Pancake Robot');
  assert.equal(resolveDistroKidArtist('default'), 'Pancake Robot');
  assert.equal(resolveDistroKidArtist('basement-cypher'), 'Figment Factory');
  assert.equal(resolveDistroKidArtist('gravl-brand-profile'), 'Figment Factory');
});

test('canonical DistroKid payload includes absolute artwork, audio, release metadata, lyrics, and AI fields', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-distrokid-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const artworkPath = path.join(root, 'cover-art.png');
  const audioPath = path.join(root, 'track-01.wav');
  const lyricsPath = path.join(root, 'lyrics.md');
  fs.writeFileSync(artworkPath, 'fake-artwork');
  fs.writeFileSync(audioPath, 'fake-audio');
  fs.writeFileSync(lyricsPath, 'Verse one\nChorus');

  const cockpit = buildSyntheticCockpit({ root, artworkPath, audioPath, lyricsPath });
  const payload = buildDistroKidPayloadFromCockpit(cockpit, {
    repoRoot: root,
    generatedAt: '2026-05-27T12:00:00.000Z',
  });

  assert.equal(payload.schema_version, 'pancake-distrokid-payload-v1');
  assert.equal(payload.releaseType, 'album');
  assert.equal(payload.releaseTitle, 'Two-Headed Wiener Dog');
  assert.equal(payload.artistName, 'Pancake Robot');
  assert.equal(payload.releaseDate, '2026-06-19');
  assert.equal(payload.label, 'Figment Factory');
  assert.equal(payload.primaryGenre, 'Children');
  assert.equal(payload.artworkPath, artworkPath);
  assert.equal(payload.artworkExists, true);
  assert.equal(payload.trackCount, 1);
  assert.equal(payload.tracks[0].songId, 'SONG_TEST_1');
  assert.equal(payload.tracks[0].trackTitle, 'Run Around Pup');
  assert.equal(payload.tracks[0].audioPath, audioPath);
  assert.equal(payload.tracks[0].audioExists, true);
  assert.equal(payload.tracks[0].lyrics, 'Verse one\nChorus');
  assert.equal(payload.tracks[0].explicit, false);
  assert.equal(payload.tracks[0].instrumental, false);
  assert.equal(payload.tracks[0].isAiGenerated, true);
  assert.deepEqual(payload.tracks[0].aiDisclosure, { music: true, lyrics: true, vocals: true });
  assert.equal(payload.validation.ready, true);
});

test('Browsy workflow package and debug payload are produced from the same canonical builder', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-browsy-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const artworkPath = path.join(root, 'cover-art.png');
  const audioPath = path.join(root, 'track-01.wav');
  const lyricsPath = path.join(root, 'lyrics.md');
  fs.writeFileSync(artworkPath, 'fake-artwork');
  fs.writeFileSync(audioPath, 'fake-audio');
  fs.writeFileSync(lyricsPath, 'Verse one\nChorus');

  const cockpit = buildSyntheticCockpit({ root, artworkPath, audioPath, lyricsPath });
  const generatedAt = '2026-05-27T12:00:00.000Z';
  const expectedPayload = buildDistroKidPayloadFromCockpit(cockpit, { repoRoot: root, generatedAt });
  const packageResult = buildBrowsyDistroKidWorkflowPackage({
    cockpit,
    campaign: { id: 'CAMPAIGN_TEST' },
    task: { task_key: 'distrokid_submit_dry_run', source_workflow_id: 'distrokid-album-submit' },
    dryRun: true,
    outputDir: path.join(root, 'workflow-package'),
    repoRoot: root,
    generatedAt,
  });

  assert.deepEqual(packageResult.payload, expectedPayload);
  assert.deepEqual(packageResult.workflowPackage.canonical_payload, expectedPayload);
  assert.equal(packageResult.workflowPackage.workflow_id, 'distrokid-album-submit');
  assert.equal(packageResult.workflowPackage.mode, 'preview');
  assert.equal(packageResult.workflowPackage.payload_path, 'workflow-package/distrokid-payload.json');
  assert.ok(fs.existsSync(packageResult.payloadPath));
  assert.ok(fs.existsSync(packageResult.manifestPath));
  assert.ok(fs.existsSync(packageResult.packagePath));

  const downloadedPayload = JSON.parse(fs.readFileSync(packageResult.payloadPath, 'utf8'));
  assert.deepEqual(downloadedPayload, expectedPayload);
});

test('Browsy client posts to documented workflowRef run endpoint and normalizes dry_run to preview', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: JSON.parse(options.body || '{}') });
    return {
      ok: true,
      status: 201,
      statusText: 'Created',
      async text() {
        return JSON.stringify({ ok: true, runId: 'run_test_123', run: { runId: 'run_test_123' } });
      },
    };
  };

  try {
    const workflowRef = buildBrowsyWorkflowRef({
      appId: 'pancake-robot',
      workflowId: 'distrokid-album-submit',
      version: '1.0.0',
    });
    assert.equal(workflowRef, 'pancake-robot.distrokid-album-submit@1.0.0');

    const result = await startBrowsyWorkflowRun({
      workflowId: 'distrokid-album-submit',
      payload: { releaseTitle: 'Two-Headed Wiener Dog' },
      mode: 'dry_run',
      config: {
        baseUrl: 'http://browsy.local',
        appId: 'pancake-robot',
        workflowVersion: '1.0.0',
        timeoutMs: 1000,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.runId, 'run_test_123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://browsy.local/api/workflows/pancake-robot.distrokid-album-submit%401.0.0/runs');
    assert.equal(calls[0].body.mode, 'preview');
    assert.equal(calls[0].body.callerId, 'pancake-robot');
    assert.deepEqual(calls[0].body.payload, { releaseTitle: 'Two-Headed Wiener Dog' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeBrowsyWorkflowRun posts to the run endpoint, polls GET /api/runs/:id, and maps terminal status', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if ((options.method || 'GET') === 'POST') {
      return jsonResponse(201, { ok: true, runId: 'run_poll_1', status: 'created', run: { runId: 'run_poll_1', status: 'created' } });
    }
    // GET /api/runs/:id — first poll is still running, second is completed.
    polls += 1;
    const status = polls < 2 ? 'running' : 'completed';
    return jsonResponse(200, {
      ok: true,
      run: { runId: 'run_poll_1', status },
      result: { runId: 'run_poll_1', status, outputs: { smart_link_url: 'https://distrokid.com/hyperfollow/x' }, artifacts: { screenshots: [], downloads: [], trace: [], logs: [] }, checkpoints: [] },
    });
  };

  try {
    const result = await executeBrowsyWorkflowRun({
      workflowId: 'distrokid-single-submit',
      payload: { releaseId: 'SONG_1' },
      mode: 'live',
      config: { baseUrl: 'http://browsy.local', appId: 'pancake-robot', workflowVersion: '', timeoutMs: 1000, pollIntervalMs: 1, runTimeoutMs: 5000 },
      sleep: async () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.category, 'success');
    assert.equal(result.runId, 'run_poll_1');
    assert.equal(result.result.outputs.smart_link_url, 'https://distrokid.com/hyperfollow/x');
    assert.ok(calls.some(c => c.method === 'POST' && /\/runs$/.test(c.url)));
    assert.ok(calls.some(c => c.method === 'GET' && /\/api\/runs\/run_poll_1$/.test(c.url)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeBrowsyWorkflowRun reports unreachable Browsy instead of fabricating success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const result = await executeBrowsyWorkflowRun({
      workflowId: 'distrokid-single-submit',
      payload: {},
      mode: 'live',
      config: { baseUrl: 'http://127.0.0.1:9', appId: 'pancake-robot', workflowVersion: '', timeoutMs: 200, pollIntervalMs: 1, runTimeoutMs: 1000 },
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.reachable, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('categorizeBrowsyStatus maps Browsy public statuses to Pancake categories', () => {
  assert.equal(categorizeBrowsyStatus('completed'), 'success');
  assert.equal(categorizeBrowsyStatus('waiting_for_auth'), 'blocked_auth');
  assert.equal(categorizeBrowsyStatus('waiting_for_approval_to_submit'), 'blocked_human_approval');
  assert.equal(categorizeBrowsyStatus('waiting_for_file_selection'), 'blocked_validation');
  assert.equal(categorizeBrowsyStatus('failed'), 'failed');
  assert.equal(categorizeBrowsyStatus('canceled'), 'failed');
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async text() { return JSON.stringify(body); },
  };
}

function buildSyntheticCockpit({ root, artworkPath, audioPath, lyricsPath }) {
  return {
    type: 'album',
    id: 'ALBUM_TEST_1',
    title: 'Two-Headed Wiener Dog',
    releaseDate: '2026-06-19',
    brandProfileId: 'pancake-robot',
    distrokidArtwork: { path: artworkPath, ext: 'png', source: 'album_media', blocked: false },
    releaseAssetState: { primaryImage: { path: artworkPath, source: 'album_media' } },
    packageState: {
      path: 'output/release-packages/ALBUM_TEST_1',
      manifestPath: path.join(root, 'manifest.json'),
      manifest: {
        release_type: 'album',
        release_id: 'ALBUM_TEST_1',
        release_title: 'Two-Headed Wiener Dog',
        artist: 'Pancake Robot',
        release_date: '2026-06-19',
        label: 'Figment Factory',
        primary_genre: 'Children',
        cover_art: artworkPath,
        tracks: [{
          song_id: 'SONG_TEST_1',
          track_number: 1,
          track_title: 'Run Around Pup',
          audio_file: audioPath,
          lyrics_file: lyricsPath,
          explicit: false,
          instrumental: false,
          songwriter: 'Kenneth Chapman',
          producer: 'Pancake Robot',
          is_ai_generated: true,
          ai_disclosure: { music: true, lyrics: true, vocals: true },
        }],
      },
    },
    tracks: [{
      id: 'SONG_TEST_1',
      title: 'Run Around Pup',
      topic: 'A two-headed wiener dog running around happily',
      track_number: 1,
      explicit: false,
      instrumental: false,
      songwriter: 'Kenneth Chapman',
      producer: 'Pancake Robot',
      is_ai_generated: true,
      ai_disclosure: { music: true, lyrics: true, vocals: true },
      fsAssets: {
        lyrics: lyricsPath,
        audioFiles: [{ path: audioPath }],
      },
      releaseAudio: {
        selected: { path: audioPath },
      },
    }],
  };
}
