import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-magic-release-browsy-http').slug;

const repoRoot = path.resolve(import.meta.dirname, '..');
const songIds = new Set();
const packageIds = new Set();

test.after(() => {
  cleanupTestOutputArtifacts({ songIds: [...songIds], packageIds: [...packageIds] });
  delete process.env.PANCAKE_BROWSY_BASE_URL;
  delete process.env.PANCAKE_BROWSY_DRY_RUN;
  delete process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS;
});

const { upsertSong, getReleaseLinks, listReleaseCampaignRuns } = await import('../src/shared/db.js');
const {
  createMagicReleaseCampaign,
  getMagicReleaseState,
  runMagicReleaseTask,
} = await import('../src/shared/magic-release.js');

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function seedReleaseSong(id) {
  songIds.add(id);
  packageIds.add(id);
  const songDir = path.join(repoRoot, 'output', 'songs', id);
  fs.mkdirSync(path.join(songDir, 'reference'), { recursive: true });
  fs.writeFileSync(path.join(songDir, 'audio.mp3'), 'fake-audio');
  fs.writeFileSync(path.join(songDir, 'reference', 'base-image.png'), 'fake-artwork');
  upsertSong({
    id,
    title: `Browsy HTTP ${id}`,
    topic: 'robots make pancakes',
    release_date: '2026-09-01',
    brand_profile_id: 'default',
    status: 'draft',
    is_test: true,
  });
  return id;
}

function resultJsonFor(campaignId, taskKey) {
  return JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'output', 'release-workflows', campaignId, taskKey, 'result.json'),
    'utf8',
  ));
}

// A complete DistroKid submit contract — a real Browsy that has a recorded and
// imported workflow serves this, so the live-run contract gate passes.
function completeDistroKidContract(workflowId = 'distrokid-single-submit') {
  return {
    workflowRef: `pancake-robot/${workflowId}@1.0.0`,
    workflowId,
    appId: 'pancake-robot',
    runEndpoint: `/api/apps/pancake-robot/workflows/${workflowId}/runs`,
    requiredPayloadFields: ['album', 'tracks'],
    optionalPayloadFields: [],
    tabs: [{ id: 'distrokidUpload', siteId: 'distrokid', requiresAuth: true }],
    recordedSteps: [{ id: 'step1', action: 'click' }],
    fileUploadBindings: [{ id: 'artworkPath' }],
    humanApprovalCheckpoints: [{ id: 'beforeFinalSubmit' }],
    auth: [{ siteId: 'distrokid' }],
    expectedOutputs: [{ id: 'distrokidReviewState' }],
  };
}

function startFakeBrowsy(runStatus, { outputs = {}, contract = completeDistroKidContract() } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && /\/contract(\?|$)/.test(req.url)) {
      if (!contract) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'no contract' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, contract }));
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/runs')) {
      res.writeHead(201);
      res.end(JSON.stringify({ ok: true, runId: 'run_fake_1', status: 'created', run: { runId: 'run_fake_1', status: 'created' } }));
      return;
    }
    if (req.method === 'GET' && /\/api\/runs\/run_fake_1$/.test(req.url)) {
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        run: { runId: 'run_fake_1', status: runStatus },
        result: {
          runId: 'run_fake_1',
          status: runStatus,
          outputs,
          artifacts: { screenshots: [], downloads: [], trace: [], logs: [] },
          checkpoints: [],
          blockingReason: runStatus === 'completed' ? null : 'Waiting on human approval',
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('explicit dry-run produces a clearly-marked dry_run result and completes without live submission', async () => {
  const songId = seedReleaseSong(uniqueId('BROWSY_DRYRUN'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });

  const result = await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'distrokid_submit_dry_run', dryRun: true });
  const resultJson = resultJsonFor(created.campaign.id, 'distrokid_submit_dry_run');

  assert.equal(result.ok, true);
  assert.equal(resultJson.status, 'dry_run_passed');
  assert.equal(resultJson.dry_run, true);
  assert.match(resultJson.note, /dry-run/i);
  const state = getMagicReleaseState('single', songId);
  assert.equal(state.tasks.find(t => t.task_key === 'distrokid_submit_dry_run')?.status, 'complete');
});

test('live run with unreachable Browsy surfaces not_configured instead of fake success', async () => {
  const songId = seedReleaseSong(uniqueId('BROWSY_UNREACHABLE'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });

  process.env.PANCAKE_BROWSY_BASE_URL = 'http://127.0.0.1:9';
  delete process.env.PANCAKE_BROWSY_DRY_RUN;
  try {
    await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'distrokid_submit_dry_run', dryRun: false });
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
  }

  const resultJson = resultJsonFor(created.campaign.id, 'distrokid_submit_dry_run');
  assert.equal(resultJson.status, 'not_configured');
  assert.notEqual(resultJson.status, 'dry_run_passed');
  const state = getMagicReleaseState('single', songId);
  const task = state.tasks.find(t => t.task_key === 'distrokid_submit_dry_run');
  assert.notEqual(task?.status, 'complete');
  const run = listReleaseCampaignRuns(created.campaign.id)[0];
  assert.equal(run.status, 'blocked');
  assert.equal(run.log.reachable, false);
});

test('live run against Browsy completion marks the task complete and harvests captured links', async () => {
  const songId = seedReleaseSong(uniqueId('BROWSY_LIVE_OK'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const fake = await startFakeBrowsy('completed', { outputs: { smart_link_url: 'https://distrokid.com/hyperfollow/live-ok' } });

  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS = '1';
  try {
    await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'distrokid_submit_dry_run', dryRun: false });
  } finally {
    process.env.PANCAKE_BROWSY_BASE_URL && delete process.env.PANCAKE_BROWSY_BASE_URL;
    delete process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS;
    fake.server.close();
  }

  const resultJson = resultJsonFor(created.campaign.id, 'distrokid_submit_dry_run');
  assert.equal(resultJson.status, 'live_run_completed');
  assert.equal(resultJson.browsy_run_id, 'run_fake_1');
  const state = getMagicReleaseState('single', songId);
  assert.equal(state.tasks.find(t => t.task_key === 'distrokid_submit_dry_run')?.status, 'complete');
  assert.ok(getReleaseLinks(songId).some(link => link.url === 'https://distrokid.com/hyperfollow/live-ok'));
});

test('live run paused for approval maps to a needs-Ken gate (no auto submit)', async () => {
  const songId = seedReleaseSong(uniqueId('BROWSY_LIVE_GATE'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const fake = await startFakeBrowsy('waiting_for_approval_to_submit');

  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS = '1';
  try {
    await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'distrokid_submit_dry_run', dryRun: false });
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    delete process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS;
    fake.server.close();
  }

  const resultJson = resultJsonFor(created.campaign.id, 'distrokid_submit_dry_run');
  assert.equal(resultJson.status, 'live_run_gated');
  const state = getMagicReleaseState('single', songId);
  assert.equal(state.tasks.find(t => t.task_key === 'distrokid_submit_dry_run')?.status, 'needs_ken');
});

test('final submit approval gate stays a mandatory human step', async () => {
  const songId = seedReleaseSong(uniqueId('BROWSY_GATE'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });

  const result = await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'distrokid_final_submit_approval', dryRun: false });

  assert.equal(result.needsKen, true);
  const state = getMagicReleaseState('single', songId);
  assert.equal(state.tasks.find(t => t.task_key === 'distrokid_final_submit_approval')?.status, 'needs_ken');
});
