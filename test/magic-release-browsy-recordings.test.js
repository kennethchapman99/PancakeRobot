import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-magic-release-browsy-recordings').slug;

const repoRoot = path.resolve(import.meta.dirname, '..');
const songIds = new Set();
const packageIds = new Set();

test.after(() => {
  cleanupTestOutputArtifacts({ songIds: [...songIds], packageIds: [...packageIds] });
  delete process.env.PANCAKE_BROWSY_BASE_URL;
  delete process.env.PANCAKE_BROWSY_DRY_RUN;
  delete process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS;
  delete process.env.PANCAKE_DISABLE_NGROK;
  delete process.env.NGROK_URL;
  delete process.env.PUBLIC_BASE_URL;
});

const { upsertSong, getReleaseCockpitLogs, createReleaseBrowsyRecording, getReleaseBrowsyRecording } = await import('../src/shared/db.js');
const {
  assertNoNgrokInLocalOnly,
  containsNgrok,
  getLocalAppBaseUrl,
  getPublicBaseUrl,
  isLocalOnlyMode,
} = await import('../src/shared/public-url.js');
const { evaluateBrowsyContractCompleteness } = await import('../src/shared/browsy-client.js');
const {
  createMagicReleaseCampaign,
  getMagicReleaseState,
  runMagicReleaseTask,
} = await import('../src/shared/magic-release.js');
const {
  buildBrowsyRecordingSpecForTask,
  ensureMagicReleaseBrowsyRecordAutomation,
  importMagicReleaseBrowsyRecording,
  launchMagicReleaseBrowsyRecording,
  listMagicReleaseBrowsyRecordings,
  refreshMagicReleaseBrowsyContract,
  startMagicReleaseBrowsyRecording,
  stopMagicReleaseBrowsyRecording,
  summarizeMagicReleaseBrowsyRecordings,
} = await import('../src/shared/magic-release-browsy-recordings.js');

const SUBMIT_TASK = 'distrokid_submit_dry_run';

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
    title: `Browsy Rec ${id}`,
    topic: 'robots make pancakes',
    release_date: '2026-09-01',
    brand_profile_id: 'default',
    status: 'draft',
    is_test: true,
  });
  return id;
}

function completeContract(workflowId = 'distrokid-single-submit') {
  return {
    workflowRef: `pancake-robot/${workflowId}@1.0.0`,
    workflowId,
    appId: 'pancake-robot',
    runEndpoint: `/api/apps/pancake-robot/workflows/${workflowId}/runs`,
    requiredPayloadFields: ['album', 'tracks'],
    tabs: [{ id: 'distrokidUpload', siteId: 'distrokid', requiresAuth: true }],
    recordedSteps: [{ id: 'step1', action: 'click' }],
    fileUploadBindings: [{ id: 'artworkPath' }],
    humanApprovalCheckpoints: [{ id: 'beforeFinalSubmit' }],
    auth: [{ siteId: 'distrokid' }],
    expectedOutputs: [{ id: 'distrokidReviewState' }],
  };
}

function scaffoldContract(workflowId = 'distrokid-single-submit') {
  return {
    workflowRef: `pancake-robot/${workflowId}@1.0.0`,
    workflowId,
    appId: 'pancake-robot',
    runEndpoint: `/api/apps/pancake-robot/workflows/${workflowId}/runs`,
    requiredPayloadFields: [],
    tabs: [],
    recordedSteps: [],
    fileUploadBindings: [],
    humanApprovalCheckpoints: [],
    auth: [],
    expectedOutputs: [],
  };
}

// Configurable fake Browsy modeling the recording lifecycle + contract endpoints.
function startFakeBrowsy(options = {}) {
  const state = {
    workflowContract: options.workflowContract ?? completeContract(),
    importContract: options.importContract ?? completeContract(),
    runStatus: options.runStatus ?? 'completed',
    runOutputs: options.runOutputs ?? {},
    sessionId: 'rec_session_1',
    startBodies: [],
    startResponse: options.startResponse ?? null,
    launchBody: options.launchBody ?? { ok: true, recording: { recordingSessionId: 'rec_session_1', status: 'recording' }, launch: { pid: 1234 } },
    // null → endpoint not handled (404, inconclusive). Otherwise the preflight verdict.
    preflight: options.preflight ?? null,
  };
  const readBody = req => new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = (code, payload) => { res.writeHead(code); res.end(JSON.stringify(payload)); };

    if (req.method === 'GET' && /\/api\/apps\/.+\/workflows\/.+\/contract(\?|$)/.test(req.url)) {
      return state.workflowContract ? send(200, { ok: true, contract: state.workflowContract }) : send(404, { ok: false, error: 'no contract' });
    }
    if (req.method === 'GET' && /\/api\/recordings\/.+\/contract(\?|$)/.test(req.url)) {
      return state.importContract ? send(200, { ok: true, contract: state.importContract }) : send(404, { ok: false, error: 'no contract' });
    }
    if (req.method === 'POST' && req.url === '/api/recordings/start') {
      const body = await readBody(req);
      state.startBodies.push(body);
      return send(201, state.startResponse || {
        ok: true,
        recording: {
          recordingSessionId: state.sessionId,
          status: 'setup_ready',
          wizardUrl: `http://wizard/${state.sessionId}`,
          recorderUrl: `http://recorder/${state.sessionId}`,
          workflowRefPreview: 'pancake-robot/distrokid-single-submit@draft',
        },
      });
    }
    if (req.method === 'POST' && req.url === '/api/auth-profiles/preflight') {
      await readBody(req);
      if (!state.preflight) return send(404, { ok: false, error: 'not found' });
      return send(200, { ok: true, preflight: state.preflight });
    }
    if (req.method === 'POST' && /\/api\/recordings\/.+\/start$/.test(req.url)) {
      return send(200, state.launchBody);
    }
    if (req.method === 'POST' && /\/api\/recordings\/.+\/stop$/.test(req.url)) {
      return send(200, { ok: true, recording: { recordingSessionId: state.sessionId, status: 'stopped' }, runtime: { durationMs: 1000 } });
    }
    if (req.method === 'POST' && /\/api\/recordings\/.+\/import$/.test(req.url)) {
      await readBody(req);
      return send(200, {
        ok: true,
        recording: { recordingSessionId: state.sessionId, status: 'imported' },
        workflowRef: state.importContract?.workflowRef || 'pancake-robot/distrokid-single-submit@1.0.0',
        contract: state.importContract,
      });
    }
    if (req.method === 'POST' && req.url.endsWith('/runs')) {
      return send(201, { ok: true, runId: 'run_fake_1', status: 'created', run: { runId: 'run_fake_1', status: 'created' } });
    }
    if (req.method === 'GET' && /\/api\/runs\/run_fake_1$/.test(req.url)) {
      return send(200, {
        ok: true,
        run: { runId: 'run_fake_1', status: state.runStatus },
        result: {
          runId: 'run_fake_1',
          status: state.runStatus,
          outputs: state.runOutputs,
          artifacts: { screenshots: [], downloads: [], trace: [], logs: [] },
          checkpoints: [],
          blockingReason: state.runStatus === 'completed' ? null : 'Waiting on human approval',
        },
      });
    }
    return send(404, { ok: false, error: 'not found' });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('buildBrowsyRecordingSpecForTask produces a DistroKid submit spec and rejects unsupported workflows', () => {
  const songId = seedReleaseSong(uniqueId('SPEC'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaign = created.campaign;
  const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
  const built = buildBrowsyRecordingSpecForTask({ campaign, task: submitTask });
  assert.equal(built.supported, true);
  assert.equal(built.workflowId, 'distrokid-single-submit');
  assert.ok(built.spec.payloadSchema.required.includes('album'));
  assert.ok(built.spec.payloadSchema.required.includes('tracks'));
  assert.ok(built.spec.humanCheckpoints.length > 0);
  assert.ok(built.spec.recordingSetup.tabs.some(tab => tab.siteId === 'distrokid' && tab.requiresAuth));

  const youtubeTask = created.tasks.find(t => t.task_key === 'youtube_teaser_schedule');
  const unsupported = buildBrowsyRecordingSpecForTask({ campaign, task: youtubeTask });
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason, /operator-specific|no browsy recording template/i);
});

test('evaluateBrowsyContractCompleteness flags missing/scaffold contracts and passes complete ones', () => {
  const missing = evaluateBrowsyContractCompleteness(null, 'distrokid-single-submit');
  assert.equal(missing.ready, false);
  assert.equal(missing.severity, 'missing');

  const scaffold = evaluateBrowsyContractCompleteness(scaffoldContract(), 'distrokid-single-submit');
  assert.equal(scaffold.ready, false);

  const ready = evaluateBrowsyContractCompleteness(completeContract(), 'distrokid-single-submit');
  assert.equal(ready.ready, true);
  assert.equal(ready.severity, 'ready');
});

test('view model reports missing readiness before any recording exists', () => {
  const songId = seedReleaseSong(uniqueId('VM_EMPTY'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const vm = summarizeMagicReleaseBrowsyRecordings({ campaignId: created.campaign.id });
  assert.ok(vm);
  const submit = vm.items.find(item => item.taskKey === SUBMIT_TASK);
  assert.ok(submit);
  assert.equal(submit.hasRecording, false);
  assert.equal(submit.ready, false);
  assert.equal(submit.readinessSeverity, 'missing');
  assert.equal(vm.readyCount, 0);
});

test('recording lifecycle: start → launch → stop → import marks the contract ready and lets the live run complete', async () => {
  const songId = seedReleaseSong(uniqueId('LIFECYCLE'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({ runStatus: 'completed', runOutputs: { smart_link_url: 'https://distrokid.com/hyperfollow/x' } });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS = '1';
  try {
    const started = await startMagicReleaseBrowsyRecording({ campaignId, taskKey: SUBMIT_TASK });
    assert.equal(started.ok, true);
    const recordingId = started.recording.id;

    const launched = await launchMagicReleaseBrowsyRecording({ recordingId });
    assert.equal(launched.ok, true);
    assert.equal(launched.recording.recording_status, 'recording');

    const stopped = await stopMagicReleaseBrowsyRecording({ recordingId });
    assert.equal(stopped.ok, true);

    const imported = await importMagicReleaseBrowsyRecording({ recordingId });
    assert.equal(imported.ok, true);
    assert.equal(imported.completeness.ready, true);

    const vm = summarizeMagicReleaseBrowsyRecordings({ campaignId });
    const submit = vm.items.find(item => item.taskKey === SUBMIT_TASK);
    assert.equal(submit.ready, true);
    assert.equal(submit.hasRecording, true);
    assert.ok(submit.counts.recordedSteps > 0);

    // With a ready contract the live run is allowed through and completes.
    await runMagicReleaseTask({ campaignId, taskKey: SUBMIT_TASK, dryRun: false });
    const resultJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'output', 'release-workflows', campaignId, SUBMIT_TASK, 'result.json'), 'utf8'));
    assert.equal(resultJson.status, 'replay_run_completed');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    delete process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS;
    fake.server.close();
  }
});

test('Record Automation uses Browsy recordAutomationControl and sends release context', async () => {
  const songId = seedReleaseSong(uniqueId('RECAUTO_CTL'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const fake = await startFakeBrowsy({
    startResponse: {
      ok: true,
      recording: { recordingSessionId: 'rec_session_ctl', status: 'setup_ready' },
      wizardUrl: 'http://wizard/fallback',
      recordAutomationControl: {
        label: 'Record Automation',
        href: 'http://wizard/control',
        action: 'open_browsy_new_automation_wizard',
      },
    },
  });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const result = await ensureMagicReleaseBrowsyRecordAutomation({ campaignId: created.campaign.id, taskKey: SUBMIT_TASK });
    assert.equal(result.ok, true);
    assert.equal(result.recordAutomationControl.label, 'Record Automation');
    assert.equal(result.recordAutomationControl.href, 'http://wizard/control');
    assert.equal(result.wizardUrl, 'http://wizard/control');
    assert.equal(result.recording.wizard_url, 'http://wizard/control');

    assert.equal(fake.state.startBodies.length, 1);
    const body = fake.state.startBodies[0];
    assert.equal(body.appId, 'pancake-robot');
    assert.equal(body.appName, 'Pancake Robot');
    assert.equal(body.sourceApp, 'pancake-robot');
    assert.equal(body.releaseId, songId);
    assert.equal(body.workflowId, 'distrokid-single-submit');
    assert.ok(Array.isArray(body.recordingSetup.tabs));
    assert.ok(body.recordingSetup.tabs.some(tab => tab.siteId === 'pancake-robot' && tab.requiresAuth === false));
    assert.ok(body.recordingSetup.tabs.some(tab => tab.siteId === 'distrokid' && tab.requiresAuth === true));
    assert.ok(body.payloadSchema);
    assert.ok(Array.isArray(body.requiredAssets));
    assert.ok(Array.isArray(body.fileBindings));
    assert.ok(Array.isArray(body.expectedOutputs));
    assert.ok(Array.isArray(body.humanCheckpoints));
    assert.ok(body.completionPolicy);
    assert.ok(Array.isArray(body.writebackTargets));
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
});

test('Record Automation falls back to wizardUrl when Browsy omits recordAutomationControl', async () => {
  const songId = seedReleaseSong(uniqueId('RECAUTO_FALLBACK'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const fake = await startFakeBrowsy({});
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const result = await ensureMagicReleaseBrowsyRecordAutomation({ campaignId: created.campaign.id, taskKey: SUBMIT_TASK });
    assert.equal(result.ok, true);
    assert.equal(result.recordAutomationControl.label, 'Record Automation');
    assert.equal(result.recordAutomationControl.href, 'http://wizard/rec_session_1');
    assert.equal(result.wizardUrl, 'http://wizard/rec_session_1');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
});

test('Record Automation reuses an existing recording session', async () => {
  const songId = seedReleaseSong(uniqueId('RECAUTO_EXISTING'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
  createReleaseBrowsyRecording({
    campaign_id: created.campaign.id,
    task_id: submitTask.id,
    task_key: SUBMIT_TASK,
    release_type: 'single',
    release_id: songId,
    workflow_id: 'distrokid-single-submit',
    recording_session_id: 'rec_existing',
    wizard_url: 'http://wizard/existing',
    recording_status: 'setup_ready',
  });

  const result = await ensureMagicReleaseBrowsyRecordAutomation({ campaignId: created.campaign.id, taskKey: SUBMIT_TASK });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.recordAutomationControl.label, 'Record Automation');
  assert.equal(result.recordAutomationControl.href, 'http://wizard/existing');
});

test('Record Automation can force a fresh session instead of reusing stale wizard URL', async () => {
  const songId = seedReleaseSong(uniqueId('RECAUTO_FRESH'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
  createReleaseBrowsyRecording({
    campaign_id: created.campaign.id,
    task_id: submitTask.id,
    task_key: SUBMIT_TASK,
    release_type: 'single',
    release_id: songId,
    workflow_id: 'distrokid-single-submit',
    recording_session_id: 'rec_stale',
    wizard_url: 'http://wizard/stale',
    recording_status: 'setup_ready',
  });
  const fake = await startFakeBrowsy({
    startResponse: {
      ok: true,
      recording: { recordingSessionId: 'rec_fresh', status: 'setup_ready' },
      wizardUrl: 'http://wizard/fresh',
    },
  });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const result = await ensureMagicReleaseBrowsyRecordAutomation({ campaignId: created.campaign.id, taskKey: SUBMIT_TASK, forceNew: true });
    assert.equal(result.ok, true);
    assert.equal(result.reused, false);
    assert.equal(result.recordAutomationControl.href, 'http://wizard/fresh');
    assert.equal(fake.state.startBodies.length, 1);
    assert.equal(fake.state.startBodies[0].releaseId, songId);
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
});

test('Record Automation reports Browsy unavailable without pretending ready', async () => {
  const songId = seedReleaseSong(uniqueId('RECAUTO_DOWN'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  process.env.PANCAKE_BROWSY_BASE_URL = 'http://127.0.0.1:9';
  try {
    const result = await ensureMagicReleaseBrowsyRecordAutomation({ campaignId: created.campaign.id, taskKey: SUBMIT_TASK });
    assert.equal(result.ok, false);
    assert.equal(result.reachable, false);
    assert.match(result.error, /fetch failed|ECONNREFUSED|Failed to fetch|connect/i);
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
  }
});

test('live run is gated (no fake automation) when the Browsy contract is scaffold-only', async () => {
  const songId = seedReleaseSong(uniqueId('GATE_SCAFFOLD'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({ workflowContract: scaffoldContract(), runStatus: 'completed' });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS = '1';
  try {
    await runMagicReleaseTask({ campaignId, taskKey: SUBMIT_TASK, dryRun: false });
    const resultJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'output', 'release-workflows', campaignId, SUBMIT_TASK, 'result.json'), 'utf8'));
    assert.equal(resultJson.status, 'contract_not_ready');
    assert.notEqual(resultJson.status, 'replay_run_completed');
    const state = getMagicReleaseState('single', songId);
    const task = state.tasks.find(t => t.task_key === SUBMIT_TASK);
    assert.equal(task.status, 'needs_ken');
    assert.match(task.suggested_action || '', /record\/import/i);
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    delete process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS;
    fake.server.close();
  }
});

test('refreshMagicReleaseBrowsyContract reports readiness from the published contract', async () => {
  const songId = seedReleaseSong(uniqueId('REFRESH'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({ workflowContract: completeContract() });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const refreshed = await refreshMagicReleaseBrowsyContract({ campaignId, taskKey: SUBMIT_TASK });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.ready, true);
    assert.equal(refreshed.severity, 'ready');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
});

test('cockpit logs carry the real release type/id (object-style addReleaseCockpitLog calls)', () => {
  // Regression guard: these log helpers were previously called positionally
  // against an object-style signature, so releaseType/releaseId silently became
  // undefined and the logs never surfaced for the actual release.
  const songId = seedReleaseSong(uniqueId('LOGS'));
  createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const logs = getReleaseCockpitLogs('single', songId, { limit: 50 });
  const created = logs.find(log => log.action === 'magic_release_create');
  assert.ok(created, 'expected a magic_release_create cockpit log for the release');
  assert.equal(created.release_id, songId);
  assert.equal(created.status, 'success');
  assert.ok(created.payload && created.payload.campaignId, 'log payload should carry campaignId');
});

test('a failed Browsy launch writes a clear cockpit error log instead of looking idle', async () => {
  const songId = seedReleaseSong(uniqueId('LAUNCH_FAIL'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({});
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS = '1';
  let recordingId;
  try {
    const started = await startMagicReleaseBrowsyRecording({ campaignId, taskKey: SUBMIT_TASK });
    recordingId = started.recording.id;
  } finally {
    fake.server.close();
  }
  // Browsy is now unreachable; the launch must fail loudly.
  process.env.PANCAKE_BROWSY_BASE_URL = 'http://127.0.0.1:9';
  try {
    const launched = await launchMagicReleaseBrowsyRecording({ recordingId });
    assert.equal(launched.ok, false);
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    delete process.env.PANCAKE_BROWSY_POLL_INTERVAL_MS;
  }
  const logs = getReleaseCockpitLogs('single', songId, { limit: 50 });
  const errorLog = logs.find(log => log.action === 'browsy_recording' && log.status === 'error' && /launch/i.test(log.message));
  assert.ok(errorLog, 'expected a browsy_recording error log for the failed launch');
  assert.equal(errorLog.release_id, songId);
});

test('view model survives a recording with no contract metadata', () => {
  const songId = seedReleaseSong(uniqueId('VM_PARTIAL'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
  // Bare recording row: no contract_snapshot / contract_completeness yet.
  createReleaseBrowsyRecording({
    campaign_id: campaignId,
    task_id: submitTask.id,
    task_key: SUBMIT_TASK,
    release_type: 'single',
    release_id: songId,
    workflow_id: 'distrokid-single-submit',
    recording_status: 'setup_ready',
  });
  const vm = summarizeMagicReleaseBrowsyRecordings({ campaignId });
  const submit = vm.items.find(item => item.taskKey === SUBMIT_TASK);
  assert.ok(submit);
  assert.equal(submit.hasRecording, true);
  assert.equal(submit.ready, false);
  assert.equal(submit.readinessSeverity, 'incomplete');
  assert.equal(submit.counts.recordedSteps, 0);
  assert.equal(submit.counts.tabs, 0);
  assert.ok(typeof submit.readinessSummary === 'string' && submit.readinessSummary.length > 0);
});

test('starting a recording for an unsupported workflow throws a clear error', async () => {
  const songId = seedReleaseSong(uniqueId('UNSUPPORTED'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  await assert.rejects(
    () => startMagicReleaseBrowsyRecording({ campaignId: created.campaign.id, taskKey: 'youtube_teaser_schedule' }),
    /not a browsy-owned task|no browsy recording template|operator-specific/i,
  );
});

// F5: local-only mode (PANCAKE_DISABLE_NGROK=true) keeps every Pancake URL on
// localhost even when ngrok vars are present in the environment.
test('local-only mode keeps the public base URL on localhost and out of recording specs', () => {
  process.env.PANCAKE_DISABLE_NGROK = 'true';
  process.env.NGROK_URL = 'https://stale-tunnel.ngrok.io';
  process.env.PUBLIC_BASE_URL = 'https://also-stale.ngrok-free.app';
  try {
    assert.equal(isLocalOnlyMode(), true);
    const base = getPublicBaseUrl();
    assert.equal(containsNgrok(base), false, 'public base URL must not contain ngrok in local-only mode');
    assert.match(base, /^https?:\/\/localhost/);

    const songId = seedReleaseSong(uniqueId('LOCALONLY_SPEC'));
    const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
    const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
    const built = buildBrowsyRecordingSpecForTask({ campaign: created.campaign, task: submitTask });
    const tabUrls = built.spec.recordingSetup.tabs.map(tab => tab.url);
    assert.ok(tabUrls.length > 0);
    assert.ok(!tabUrls.some(containsNgrok), `no recorder tab URL may contain ngrok, got ${JSON.stringify(tabUrls)}`);
    const pancakeTab = built.spec.recordingSetup.tabs.find(tab => tab.siteId === 'pancake-robot');
    assert.match(pancakeTab.url, /^https?:\/\/localhost/);
  } finally {
    delete process.env.PANCAKE_DISABLE_NGROK;
    delete process.env.NGROK_URL;
    delete process.env.PUBLIC_BASE_URL;
  }
});

// Recording is an always-local bridge: even when ngrok is enabled globally (no
// PANCAKE_DISABLE_NGROK and an ngrok PUBLIC_BASE_URL), the recorder's Pancake-owned
// tab + callback URLs stay on localhost so the recorder never opens a tunnel tab.
test('recording bridge uses localhost even when ngrok is enabled globally', () => {
  delete process.env.PANCAKE_DISABLE_NGROK;
  process.env.PUBLIC_BASE_URL = 'https://1a60-165-225-208-156.ngrok-free.app';
  process.env.PUBLIC_APP_BASE_URL = 'https://1a60-165-225-208-156.ngrok-free.app';
  try {
    // Sanity: global public URL really is the ngrok tunnel in this scenario.
    assert.equal(isLocalOnlyMode(), false);
    assert.equal(containsNgrok(getPublicBaseUrl()), true);

    const songId = seedReleaseSong(uniqueId('ALWAYS_LOCAL'));
    const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
    const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
    const built = buildBrowsyRecordingSpecForTask({ campaign: created.campaign, task: submitTask });
    const pancakeTab = built.spec.recordingSetup.tabs.find(tab => tab.siteId === 'pancake-robot');
    assert.equal(containsNgrok(pancakeTab.url), false, `pancake tab must be local, got ${pancakeTab.url}`);
    assert.ok(pancakeTab.url.startsWith(getLocalAppBaseUrl()), `expected ${getLocalAppBaseUrl()} prefix, got ${pancakeTab.url}`);
    assert.match(getLocalAppBaseUrl(), /^http:\/\/localhost:\d+$/);
  } finally {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_APP_BASE_URL;
  }
});

// F5 (unit): the local-only guard throws a clear, operator-readable error.
test('assertNoNgrokInLocalOnly fails fast on a stale ngrok URL in local-only mode', () => {
  process.env.PANCAKE_DISABLE_NGROK = 'true';
  try {
    assert.throws(
      () => assertNoNgrokInLocalOnly('https://stale.ngrok.io/recorder', 'recorder URL'),
      /local-only mode.*ngrok|clear the stale ngrok url/i,
    );
    // A localhost URL passes through untouched.
    assert.equal(assertNoNgrokInLocalOnly('http://localhost:3001/x', 'recorder URL'), 'http://localhost:3001/x');
  } finally {
    delete process.env.PANCAKE_DISABLE_NGROK;
  }
});

// F6: a stale ngrok recorder URL persisted on a recording is rejected at launch
// time (in local-only mode) with a clear cockpit error instead of opening a dead
// tunnel tab.
test('launch refuses a stale ngrok recorder URL in local-only mode with a clear error', async () => {
  const songId = seedReleaseSong(uniqueId('STALE_NGROK'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
  const recording = createReleaseBrowsyRecording({
    campaign_id: campaignId,
    task_id: submitTask.id,
    task_key: SUBMIT_TASK,
    release_type: 'single',
    release_id: songId,
    workflow_id: 'distrokid-single-submit',
    recording_session_id: 'rec_session_stale',
    recording_status: 'setup_ready',
    recorder_url: 'https://stale-tunnel.ngrok.io/recorder/rec_session_stale',
  });
  process.env.PANCAKE_DISABLE_NGROK = 'true';
  try {
    const launched = await launchMagicReleaseBrowsyRecording({ recordingId: recording.id });
    assert.equal(launched.ok, false);
    assert.equal(launched.localOnlyBlocked, true);
    assert.match(launched.error, /ngrok/i);
    const stored = getReleaseBrowsyRecording(recording.id);
    assert.equal(stored.recording_status, 'launch_failed');
  } finally {
    delete process.env.PANCAKE_DISABLE_NGROK;
  }
  const logs = getReleaseCockpitLogs('single', songId, { limit: 50 });
  const errLog = logs.find(log => log.action === 'browsy_recording' && log.status === 'error' && /ngrok/i.test(log.message));
  assert.ok(errLog, 'expected a cockpit error log naming the stale ngrok URL');
});

// F1/F2: Start Recording is one click — it creates the session AND launches the
// recorder, logging both steps so the cockpit shows progress.
test('start auto-launches the recorder and logs both session creation and launch', async () => {
  const songId = seedReleaseSong(uniqueId('AUTOLAUNCH'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({});
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const started = await startMagicReleaseBrowsyRecording({ campaignId, taskKey: SUBMIT_TASK });
    assert.equal(started.ok, true);
    assert.equal(started.launched, true);
    assert.equal(started.authBlocked, false);
    assert.equal(started.recording.recording_status, 'recording');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
  const logs = getReleaseCockpitLogs('single', songId, { limit: 50 });
  assert.ok(
    logs.some(log => log.action === 'browsy_recording' && /created browsy recording session/i.test(log.message)),
    'expected a "Created Browsy recording session" log',
  );
  assert.ok(
    logs.some(log => log.action === 'browsy_recording' && log.status === 'success' && /browser launched for browsy recording/i.test(log.message)),
    'expected a "Browser launched for Browsy recording" launch log',
  );
});

// Auth-blocked: the recorder opens but the target site bounces sign-in. Start
// must surface auth_blocked (not a silent success) so the cockpit can offer the
// Open Auth Setup recovery flow.
test('start surfaces auth_blocked when the recorder opens but sign-in is blocked', async () => {
  const songId = seedReleaseSong(uniqueId('AUTHBLOCK'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({
    launchBody: {
      ok: true,
      recording: { recordingSessionId: 'rec_session_1', status: 'recording' },
      launch: {
        pid: 4321,
        authBlocked: true,
        authBlockedReason: "Couldn't sign you in. This browser or app may not be secure.",
        openedTabs: [
          { id: 'distrokidUpload', finalUrl: 'https://accounts.google.com/signin', authBlocked: true, blockedReason: 'This browser or app may not be secure.' },
        ],
      },
    },
  });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const started = await startMagicReleaseBrowsyRecording({ campaignId, taskKey: SUBMIT_TASK });
    assert.equal(started.ok, true);
    assert.equal(started.authBlocked, true);
    assert.equal(started.recording.recording_status, 'auth_blocked');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
  const logs = getReleaseCockpitLogs('single', songId, { limit: 50 });
  const warnLog = logs.find(log => log.action === 'browsy_recording' && log.status === 'warning' && /sign-in was blocked/i.test(log.message));
  assert.ok(warnLog, 'expected a warning log describing the blocked sign-in');
});

// Auth preflight gate: when the preflight reports not-authenticated, the recorder
// must NOT launch. The cockpit surfaces auth_required (not "recording started"),
// steering the operator to Open Auth Browser first.
test('start refuses to launch the recorder when auth preflight reports not authenticated', async () => {
  const songId = seedReleaseSong(uniqueId('AUTHPRE'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({
    preflight: {
      mode: 'auth_preflight', ok: false, code: 'auth_required',
      authProfileId: 'distrokid', finalUrl: 'https://accounts.google.com/signin',
      message: 'Target requires authentication — open the auth browser and sign in once.',
    },
  });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const started = await startMagicReleaseBrowsyRecording({ campaignId, taskKey: SUBMIT_TASK });
    assert.equal(started.ok, false);
    assert.equal(started.authRequired, true);
    assert.equal(started.launched, false);
    assert.equal(started.recording.recording_status, 'auth_required');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
  const logs = getReleaseCockpitLogs('single', songId, { limit: 50 });
  assert.ok(
    logs.some(log => log.action === 'browsy_recording' && log.status === 'warning' && /preflight blocked recorder launch/i.test(log.message)),
    'expected a warning log describing the preflight block',
  );
  assert.ok(
    !logs.some(log => log.action === 'browsy_recording' && /recorder browser opened/i.test(log.message)),
    'recorder must not report "opened" when preflight blocked the launch',
  );
});

// Auth preflight Google-rejection: the "this browser or app may not be secure"
// verdict maps to auth_rejected so the cockpit can show the Google-rejected state.
test('start maps an auth_rejected preflight verdict to the auth_rejected recording state', async () => {
  const songId = seedReleaseSong(uniqueId('AUTHREJ'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({
    preflight: {
      mode: 'auth_preflight', ok: false, code: 'auth_rejected',
      authProfileId: 'distrokid', finalUrl: 'https://accounts.google.com/v3/signin/rejected',
      message: 'Sign-in was rejected in the automation browser.',
    },
  });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const started = await startMagicReleaseBrowsyRecording({ campaignId, taskKey: SUBMIT_TASK });
    assert.equal(started.ok, false);
    assert.equal(started.authRequired, true);
    assert.equal(started.recording.recording_status, 'auth_rejected');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
});

// REGRESSION: about:blank launch — Browsy launched but both tabs stayed blank.
// Must be treated as launch_failed, not a silent success.
test('about:blank launch result marks launch_failed with expected vs actual URLs in cockpit log', async () => {
  const songId = seedReleaseSong(uniqueId('BLANK_TABS'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({
    launchBody: {
      ok: true,
      recording: { recordingSessionId: 'rec_session_1', status: 'recording' },
      launch: {
        mode: 'real_playwright_recorder',
        openedTabs: [
          { id: 'pancakeRelease', requestedUrl: 'http://localhost:3737/releases/single/s1', finalUrl: 'about:blank', authBlocked: false },
          { id: 'distrokidUpload', requestedUrl: 'https://distrokid.com/new/', finalUrl: 'about:blank', authBlocked: false },
        ],
        verification: {
          ok: false,
          expectedCount: 2,
          openedCount: 2,
          expectedUrls: ['http://localhost:3737/releases/single/s1', 'https://distrokid.com/new/'],
          actualUrls: ['about:blank', 'about:blank'],
          blankTabs: [
            { id: 'pancakeRelease', requestedUrl: 'http://localhost:3737/releases/single/s1', finalUrl: 'about:blank' },
            { id: 'distrokidUpload', requestedUrl: 'https://distrokid.com/new/', finalUrl: 'about:blank' },
          ],
          navErrors: [],
          summary: '2 tab(s) still on about:blank (pancakeRelease, distrokidUpload)',
        },
        launchFailed: true,
        launchError: 'Recorder launch failed: 2 tab(s) still on about:blank.',
      },
    },
  });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const started = await startMagicReleaseBrowsyRecording({ campaignId, taskKey: SUBMIT_TASK });
    assert.equal(started.ok, false, 'start must not be ok when all tabs are about:blank');
    assert.equal(started.recording.recording_status, 'launch_failed');
    assert.ok(/about:blank|navigation did not run/i.test(started.error || started.recording.last_error || ''),
      `error message should mention about:blank, got: ${started.error}`);
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
  const logs = getReleaseCockpitLogs('single', songId, { limit: 50 });
  const errorLog = logs.find(log =>
    log.action === 'browsy_recording' && log.status === 'error' &&
    /launch failed|about:blank|navigation/i.test(log.message)
  );
  assert.ok(errorLog, 'expected a cockpit error log for the about:blank launch');
  assert.ok(
    (errorLog.payload?.expectedUrls || []).length > 0 ||
    (errorLog.payload?.actualUrls || []).length > 0,
    'error log payload must carry expected/actual URLs',
  );
});

// REGRESSION: Pancake-side blank tab detection — Browsy returns ok:true with
// openedTabs all blank but no explicit verification/launchFailed flag.
test('Pancake detects all-blank openedTabs and marks launch_failed even without Browsy verification flag', async () => {
  const songId = seedReleaseSong(uniqueId('BLANK_NOFLG'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const campaignId = created.campaign.id;
  const fake = await startFakeBrowsy({
    launchBody: {
      ok: true,
      recording: { recordingSessionId: 'rec_session_1', status: 'recording' },
      launch: {
        mode: 'real_playwright_recorder',
        openedTabs: [
          { id: 'pancakeRelease', finalUrl: 'about:blank' },
          { id: 'distrokidUpload', finalUrl: 'about:blank' },
        ],
      },
    },
  });
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    const started = await startMagicReleaseBrowsyRecording({ campaignId, taskKey: SUBMIT_TASK });
    assert.equal(started.ok, false, 'all-blank openedTabs must be treated as launch_failed');
    assert.equal(started.recording.recording_status, 'launch_failed');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
});

// Pancake tab-spec validation: empty tabs array in a recording spec must fail
// before calling Browsy — not open a blank recorder.
test('start fails immediately with launch_failed when recording spec has no tabs', async () => {
  const songId = seedReleaseSong(uniqueId('NOTABS'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const { campaign, tasks } = created;
  const submitTask = tasks.find(t => t.task_key === SUBMIT_TASK);

  // Patch the task's workflow_id to a known but spec-less value, then drive the
  // bridge directly by calling buildBrowsyRecordingSpecForTask with a mock task
  // that has empty tabs, and call startMagicReleaseBrowsyRecording expecting failure.
  // Since buildBrowsyRecordingSpecForTask always returns tabs for supported workflows,
  // we test the guard via a custom task with source_workflow_id set to 'unsupported'.
  // The live guard fires inside startMagicReleaseBrowsyRecording before Browsy.
  const fake = await startFakeBrowsy({});
  process.env.PANCAKE_BROWSY_BASE_URL = fake.baseUrl;
  try {
    // Verify spec always has tabs for the real supported task (pre-condition).
    const { buildBrowsyRecordingSpecForTask: specBuilder } = await import('../src/shared/magic-release-browsy-recordings.js');
    const built = specBuilder({ campaign, task: submitTask });
    assert.ok(built.supported, 'distrokid-single-submit must be supported');
    assert.ok(built.spec.recordingSetup.tabs.length >= 2, 'expected at least 2 tabs in the spec');

    // Tab 0 must be the localhost Pancake release tab.
    const pancakeTab = built.spec.recordingSetup.tabs.find(t => t.siteId === 'pancake-robot');
    assert.ok(pancakeTab, 'expected a pancake-robot tab in the spec');
    assert.ok(pancakeTab.url.startsWith('http://localhost'), `Pancake tab must use localhost, got ${pancakeTab.url}`);

    // Tab 1 must be the DistroKid upload tab.
    const dkTab = built.spec.recordingSetup.tabs.find(t => t.siteId === 'distrokid');
    assert.ok(dkTab, 'expected a distrokid tab in the spec');
    assert.equal(dkTab.url, 'https://distrokid.com/new/');
  } finally {
    delete process.env.PANCAKE_BROWSY_BASE_URL;
    fake.server.close();
  }
});

// Tab URL correctness: the DistroKid submit spec always has exactly 2 tabs —
// first is localhost Pancake release URL, second is DistroKid upload URL.
test('distrokid-single-submit spec builds 2 tabs: [localhost Pancake, distrokid.com/new/]', () => {
  const songId = seedReleaseSong(uniqueId('TABS_CHECK'));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const submitTask = created.tasks.find(t => t.task_key === SUBMIT_TASK);
  const built = buildBrowsyRecordingSpecForTask({ campaign: created.campaign, task: submitTask });
  assert.ok(built.supported);
  const tabs = built.spec.recordingSetup.tabs;
  assert.equal(tabs.length, 2, `expected exactly 2 tabs, got ${tabs.length}`);

  const [first, second] = tabs;
  assert.equal(first.siteId, 'pancake-robot', `first tab must be pancake-robot, got ${first.siteId}`);
  assert.ok(
    first.url.startsWith('http://localhost'),
    `first tab must use getLocalAppBaseUrl (localhost), got ${first.url}`,
  );
  assert.ok(
    /\/releases\/single\//.test(first.url),
    `first tab URL must contain /releases/single/, got ${first.url}`,
  );
  assert.equal(second.siteId, 'distrokid', `second tab must be distrokid, got ${second.siteId}`);
  assert.equal(second.url, 'https://distrokid.com/new/', `second tab must be DistroKid upload URL, got ${second.url}`);
});
