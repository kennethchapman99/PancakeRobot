import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-release-distrokid-browsy-panel').slug;
process.env.PANCAKE_DISTROKID_AUTOMATION_STUB = '1';

const repoRoot = path.resolve(import.meta.dirname, '..');
const songIds = new Set();
const albumIds = new Set();

test.after(() => {
  cleanupTestOutputArtifacts({ songIds: [...songIds], albumIds: [...albumIds] });
});

const { upsertSong, createReleaseBrowsyRecording, createAlbum, assignSongsToAlbum, getReleaseCockpitLogs } = await import('../src/shared/db.js');
const { evaluateBrowsyContractCompleteness } = await import('../src/shared/browsy-client.js');
const { createMagicReleaseCampaign } = await import('../src/shared/magic-release.js');
const { buildReleaseCockpitViewModel } = await import('../src/shared/release-cockpit.js');
const { app } = await import('../src/web/server.js');

const SUBMIT_TASK = 'distrokid_submit_dry_run';

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function startServer() {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

function writeSongAsset(songId, relativePath, content = 'test') {
  const filePath = path.join(repoRoot, 'output', 'songs', songId, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function seedSong() {
  const id = uniqueId('DKBROWSY');
  songIds.add(id);
  upsertSong({
    id,
    title: `Browsy Panel ${id}`,
    brand_profile_id: 'default',
    release_date: '2026-09-01',
    is_test: true,
  });
  writeSongAsset(id, 'audio.mp3', 'fake-audio');
  writeSongAsset(id, 'reference/base-image.png', 'fake-art');
  return id;
}

function seedAlbum() {
  const songId = seedSong();
  const albumId = createAlbum({
    id: uniqueId('DKBROWSY_ALBUM'),
    album_title: 'Browsy Panel Album',
    release_date: '2026-09-01',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [songId]);
  return albumId;
}

function contractFor(workflowId, { tabs = 1, steps = 1, uploads = 1, checkpoints = 1, required = ['album', 'tracks'] } = {}) {
  const fill = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  return {
    workflowRef: `pancake-robot/${workflowId}@1.0.0`,
    workflowId,
    appId: 'pancake-robot',
    runEndpoint: `/api/apps/pancake-robot/workflows/${workflowId}/runs`,
    requiredPayloadFields: required,
    tabs: fill(tabs, () => ({ id: 'distrokidUpload', siteId: 'distrokid', requiresAuth: true })),
    recordedSteps: fill(steps, i => ({ id: `step${i}`, action: 'click' })),
    fileUploadBindings: fill(uploads, () => ({ id: 'artworkPath' })),
    humanApprovalCheckpoints: fill(checkpoints, () => ({ id: 'beforeFinalSubmit' })),
    auth: [{ siteId: 'distrokid' }],
    expectedOutputs: [{ id: 'distrokidReviewState' }],
  };
}

function completeContract(workflowId) { return contractFor(workflowId); }
function scaffoldContract(workflowId) { return contractFor(workflowId, { tabs: 0, steps: 0, uploads: 0, checkpoints: 0, required: [] }); }
function incompleteContract(workflowId) { return contractFor(workflowId, { tabs: 1, steps: 1, uploads: 0, checkpoints: 0 }); }

function seedCampaign(releaseType, releaseId) {
  const created = createMagicReleaseCampaign({ releaseType, releaseId });
  const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
  return { campaignId: created.campaign.id, submitTask };
}

function workflowIdFor(releaseType) {
  return releaseType === 'album' ? 'distrokid-album-submit' : 'distrokid-single-submit';
}

function seedRecording(releaseType, releaseId, { contract, recording_status = 'imported', last_error = null } = {}) {
  const { campaignId, submitTask } = seedCampaign(releaseType, releaseId);
  const workflowId = workflowIdFor(releaseType);
  createReleaseBrowsyRecording({
    campaign_id: campaignId,
    task_id: submitTask.id,
    task_key: SUBMIT_TASK,
    release_type: releaseType,
    release_id: releaseId,
    workflow_id: workflowId,
    recording_status,
    last_error,
    contract_snapshot: contract || null,
    contract_completeness: contract ? evaluateBrowsyContractCompleteness(contract, workflowId) : null,
  });
  return campaignId;
}

async function fetchDetailHtml(releaseType, releaseId) {
  const server = await startServer();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/releases/${releaseType}/${encodeURIComponent(releaseId)}`);
    assert.equal(res.status, 200);
    return await res.text();
  } finally {
    server.close();
  }
}

// 1. Album release detail page renders the Browsy DistroKid workflow panel with every control.
test('album release detail renders the Browsy DistroKid workflow panel with all lifecycle controls', async () => {
  const albumId = seedAlbum();
  seedRecording('album', albumId, { contract: completeContract('distrokid-album-submit') });
  const html = await fetchDetailHtml('album', albumId);

  assert.match(html, /data-distrokid-browsy-panel/);
  assert.match(html, /Browsy DistroKid workflow/);
  assert.match(html, /pancake-robot\.distrokid-album-submit/);
  assert.match(html, /data-distrokid-browsy-readiness/);
  // Authoring starts in the setup wizard; the cockpit no longer blindly launches the recorder.
  assert.match(html, /Open Automation Setup Wizard/);
  assert.doesNotMatch(html, /Start Recording Browser/);
  assert.doesNotMatch(html, /<button[^>]*>Launch Recorder<\/button>/);
  assert.match(html, /Stop Recording/);
  assert.match(html, /Import Recording/);
  assert.match(html, /Refresh Contract/);
  assert.match(html, /View Contract/);
  assert.match(html, /Run Preview/);
  assert.match(html, /Run Live/);
  // Payload readiness shown separately from contract readiness.
  assert.match(html, /Release payload readiness/);
});

// 2. Legacy local preview card has been removed from the DistroKid section.
test('legacy local preview card is no longer rendered', async () => {
  const albumId = seedAlbum();
  seedRecording('album', albumId, { contract: completeContract('distrokid-album-submit') });
  const html = await fetchDetailHtml('album', albumId);

  assert.doesNotMatch(html, /data-legacy-preview-script/);
  assert.doesNotMatch(html, /Legacy local preview script/);
  assert.doesNotMatch(html, /Run legacy local preview script/);
  // The Browsy panel is still present.
  assert.match(html, /data-distrokid-browsy-panel/);
});

// 3. Scaffold-only contract state.
test('scaffold-only contract is labelled distinctly with Run Live disabled but View/Refresh Contract available', async () => {
  const songId = seedSong();
  seedRecording('single', songId, { contract: scaffoldContract('distrokid-single-submit') });

  const wf = buildReleaseCockpitViewModel('single', songId).distrokidBrowsyWorkflow;
  assert.equal(wf.readinessLabel, 'scaffold-only');
  assert.equal(wf.runLiveEnabled, false);
  assert.match(wf.nextStep.headline, /Workflow shell exists, but no real browser steps/);

  const html = await fetchDetailHtml('single', songId);
  assert.match(html, /scaffold-only/);
  assert.match(html, /data-distrokid-browsy-run-live[^>]*disabled/);
  assert.match(html, /Refresh Contract/);
  assert.match(html, /View Contract/);
});

// 4. Ready contract state enables Preview but keeps Run Live gated until preview passes.
test('ready contract enables Preview and keeps Run Live gated until preview passes', async () => {
  const songId = seedSong();
  seedRecording('single', songId, { contract: completeContract('distrokid-single-submit') });

  const wf = buildReleaseCockpitViewModel('single', songId).distrokidBrowsyWorkflow;
  assert.equal(wf.readinessLabel, 'ready');
  assert.equal(wf.runPreviewEnabled, true);
  assert.equal(wf.runLiveEnabled, false);
  assert.match(wf.nextStep.headline, /Workflow contract is ready/);

  const html = await fetchDetailHtml('single', songId);
  assert.match(html, /data-distrokid-browsy-run-live[^>]*disabled/);
});

// 5. Missing + incomplete contract states.
test('missing state shows clear message and disabled Run Live', async () => {
  const songId = seedSong();
  seedCampaign('single', songId); // campaign only, no recording.

  const wf = buildReleaseCockpitViewModel('single', songId).distrokidBrowsyWorkflow;
  assert.equal(wf.readinessLabel, 'missing');
  assert.equal(wf.hasRecording, false);
  assert.equal(wf.runLiveEnabled, false);
  assert.match(wf.nextStep.headline, /automation is not ready/);

  const html = await fetchDetailHtml('single', songId);
  assert.match(html, /DistroKid Album Submit automation is not ready/);
  assert.match(html, /View Contract/);
  assert.match(html, /Refresh Contract/);
  assert.match(html, /data-distrokid-browsy-run-live[^>]*disabled/);
});

test('incomplete contract lists the missing pieces and keeps Run Live disabled', async () => {
  const songId = seedSong();
  seedRecording('single', songId, { contract: incompleteContract('distrokid-single-submit') });

  const wf = buildReleaseCockpitViewModel('single', songId).distrokidBrowsyWorkflow;
  assert.equal(wf.readinessLabel, 'incomplete');
  assert.equal(wf.runLiveEnabled, false);
  assert.ok(wf.missingAreas.length > 0, 'expected missing contract areas');

  const html = await fetchDetailHtml('single', songId);
  assert.match(html, /Workflow exists but is missing required contract pieces/);
  assert.match(html, /data-distrokid-browsy-run-live[^>]*disabled/);
  // Missing pieces rendered as bullet list.
  for (const area of wf.missingAreas) {
    assert.ok(html.includes(area), `expected missing area "${area}" in HTML`);
  }
});

// 6. Failed + unavailable states.
test('failed recording surfaces the error and a failed readiness state', async () => {
  const songId = seedSong();
  seedRecording('single', songId, {
    contract: scaffoldContract('distrokid-single-submit'),
    recording_status: 'import_failed',
    last_error: 'Browsy import failed: bad selector',
  });

  const wf = buildReleaseCockpitViewModel('single', songId).distrokidBrowsyWorkflow;
  assert.equal(wf.readinessLabel, 'failed');
  assert.equal(wf.runLiveEnabled, false);

  const html = await fetchDetailHtml('single', songId);
  assert.match(html, /bad selector/);
  assert.match(html, /data-distrokid-browsy-run-live[^>]*disabled/);
});

test('unreachable Browsy surfaces an unavailable status, not a blank cockpit', async () => {
  const songId = seedSong();
  seedRecording('single', songId, {
    contract: null,
    recording_status: 'setup_ready',
    last_error: 'Browsy unreachable: ECONNREFUSED',
  });

  const wf = buildReleaseCockpitViewModel('single', songId).distrokidBrowsyWorkflow;
  assert.equal(wf.readinessLabel, 'unavailable');
  assert.equal(wf.runLiveEnabled, false);
  assert.match(wf.nextStep.headline, /cannot be reached/);

  const html = await fetchDetailHtml('single', songId);
  assert.match(html, /unavailable/);
  assert.match(html, /ECONNREFUSED/);
});

// Recording lifecycle next-step messages.
test('recording lifecycle states map to the correct next-step guidance', () => {
  const started = seedSong();
  seedRecording('single', started, { contract: null, recording_status: 'setup_ready' });
  assert.match(buildReleaseCockpitViewModel('single', started).distrokidBrowsyWorkflow.nextStep.headline, /Automation setup exists/);

  const active = seedSong();
  seedRecording('single', active, { contract: null, recording_status: 'recording' });
  assert.match(buildReleaseCockpitViewModel('single', active).distrokidBrowsyWorkflow.nextStep.headline, /Recorder browser opened/);

  const stopped = seedSong();
  seedRecording('single', stopped, { contract: null, recording_status: 'stopped' });
  assert.match(buildReleaseCockpitViewModel('single', stopped).distrokidBrowsyWorkflow.nextStep.headline, /Import it to create\/update/);
});

// 7. Recording lifecycle buttons route correctly.
test('lifecycle buttons post to the expected magic-release routes', async () => {
  const songId = seedSong();
  const recId = `RBREC_TEST_${Date.now()}`;
  const { campaignId, submitTask } = seedCampaign('single', songId);
  createReleaseBrowsyRecording({
    id: recId,
    campaign_id: campaignId,
    task_id: submitTask.id,
    task_key: SUBMIT_TASK,
    release_type: 'single',
    release_id: songId,
    workflow_id: 'distrokid-single-submit',
    recording_status: 'stopped',
  });
  const html = await fetchDetailHtml('single', songId);
  const base = `/releases/single/${songId}/magic-release`;
  assert.ok(html.includes(`/releases/single/${songId}/automation-setup`), 'setup wizard route');
  assert.ok(html.includes(`action="${base}/recordings/${recId}/launch"`), 'launch route');
  assert.ok(html.includes(`action="${base}/recordings/${recId}/stop"`), 'stop route');
  assert.ok(html.includes(`action="${base}/recordings/${recId}/import"`), 'import route');
  assert.ok(html.includes(`action="${base}/recordings/refresh-contract"`), 'refresh-contract route');
  assert.ok(html.includes(`${base}/recordings/contract?workflow_id=`), 'view-contract route');
  assert.ok(html.includes(`action="${base}/tasks/${SUBMIT_TASK}/run"`), 'run route');
});

// 8. Object-style logging regression — failed launch via HTTP writes a correctly-keyed cockpit log.
test('a failed launch route writes an object-style cockpit log with correct release identifiers', async () => {
  const songId = seedSong();
  const { campaignId, submitTask } = seedCampaign('single', songId);
  const recId = `RBREC_LOG_${Date.now()}`;
  createReleaseBrowsyRecording({
    id: recId,
    campaign_id: campaignId,
    task_id: submitTask.id,
    task_key: SUBMIT_TASK,
    release_type: 'single',
    release_id: songId,
    workflow_id: 'distrokid-single-submit',
    recording_status: 'setup_ready',
    recording_session_id: 'sess_unreachable',
  });
  // The launch will fail regardless of whether Browsy is running:
  // - Browsy unreachable → error log (network failure)
  // - Browsy running but not authenticated → warning log (auth preflight blocks the launch)
  // - Browsy running and authenticated → error log (recording session 'sess_unreachable' not found)
  // In every case a browsy_recording log must be written with the correct release identifiers.
  const server = await startServer();
  try {
    const { port } = server.address();
    await fetch(`http://127.0.0.1:${port}/releases/single/${songId}/magic-release/recordings/${recId}/launch`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    });
  } finally {
    server.close();
  }
  const logs = getReleaseCockpitLogs('single', songId, { limit: 50 });
  const failLog = logs.find(l => l.action === 'browsy_recording' && ['error', 'warning'].includes(l.status));
  assert.ok(failLog, 'expected a browsy_recording failure log (error or warning) for the failed launch');
  assert.equal(failLog.release_id, songId);
  assert.equal(failLog.release_type, 'single');
});
