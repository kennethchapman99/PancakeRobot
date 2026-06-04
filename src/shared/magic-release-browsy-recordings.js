// Magic Release → Browsy recording management.
//
// Pancake Robot owns the release/payload context and decides *what* workflow it
// wants Browsy to record. Browsy owns the browser recorder, auth profile,
// selectors, replay, and the resulting workflow contract. This module is the
// bridge: it builds canonical recording specs from Magic Release tasks, drives
// the Browsy recording lifecycle over HTTP, and persists durable state so the
// Release Cockpit can show operator-readable readiness.
//
// No DistroKid selectors or DistroKid browser automation live here.

import {
  addReleaseCockpitLog,
  createReleaseBrowsyRecording,
  getLatestReleaseBrowsyRecordingForTask,
  getReleaseBrowsyRecording,
  getReleaseCampaignById,
  getReleaseCampaignTaskByKey,
  listReleaseBrowsyRecordingsForCampaign,
  listReleaseCampaignTasks,
  updateReleaseBrowsyRecording,
  upsertReleaseCampaignTask,
} from './db.js';
import {
  BROWSY_AUTH_PREFLIGHT_DEFAULT_RULES,
  evaluateBrowsyContractCompleteness,
  getBrowsyConfig,
  getBrowsyRecordingContract,
  getBrowsyWorkflowContract,
  importBrowsyRecordingSession,
  launchBrowsyRecordingSession,
  prepareBrowsyAuthProfile,
  runBrowsyAuthPreflight,
  startBrowsyRecordingSession,
  stopBrowsyRecordingSession,
} from './browsy-client.js';
import {
  assertNoNgrokInLocalOnly,
  containsNgrok,
  getLocalAppBaseUrl,
  isLocalOnlyMode,
} from './public-url.js';
import {
  buildDistroKidAlbumWorkflowContext,
  DISTROKID_TARGET_URL,
  validateDistroKidAlbumWorkflowContext,
} from './automation-workflow-presets.js';

// Stable, app/workflow-scoped persistent auth profile name. Combined with the
// Browsy appId (pancake-robot) this yields the persistent profile path
// output/auth-profiles/pancake-robot/distrokid — reused across launches.
const DISTROKID_AUTH_PROFILE_ID = 'distrokid';
const DISTROKID_UPLOAD_URL = DISTROKID_TARGET_URL;

// Generic auth-preflight rules Pancake hands to Browsy for DistroKid workflows.
// These describe the "automation browser bounced to Google SSO / login" and the
// Google "this browser or app may not be secure" rejection — no DistroKid login
// automation, just generic URL/text matchers Browsy evaluates.
const DISTROKID_AUTH_PREFLIGHT_RULES = BROWSY_AUTH_PREFLIGHT_DEFAULT_RULES;

// Derive the generic auth-preflight config from a recording spec's tabs: the
// auth-required target tab supplies the URL to probe; rules come from the spec's
// recordingSetup.authPreflight (app-provided) or the DistroKid defaults.
function authPreflightForSpec(spec) {
  const setup = spec?.recordingSetup || {};
  const tabs = Array.isArray(setup.tabs) ? setup.tabs : [];
  const targetTab = tabs.find(tab => tab.requiresAuth) || tabs.find(tab => tab.role === 'target') || tabs[tabs.length - 1];
  const targetUrl = setup.authPreflight?.targetUrl || targetTab?.url || null;
  if (!targetUrl) return null;
  return {
    targetUrl,
    rules: Array.isArray(setup.authPreflight?.rules) && setup.authPreflight.rules.length
      ? setup.authPreflight.rules
      : DISTROKID_AUTH_PREFLIGHT_RULES,
    authProfileId: setup.authProfileId || targetTab?.authProfileId || DISTROKID_AUTH_PROFILE_ID,
  };
}

const WORKFLOW_NAMES = Object.freeze({
  'distrokid-album-submit': 'DistroKid Album Submit',
  'distrokid-single-submit': 'DistroKid Single Submit',
  'distrokid-hyperfollow-capture': 'DistroKid HyperFollow Capture',
  'distrokid-hyperfollow-enrich': 'DistroKid HyperFollow Enrich',
  'platform-link-harvest': 'Platform Link Harvest',
});

// ─────────────────────────────────────────────
// SPEC BUILDER (pure — no network/DB)
// ─────────────────────────────────────────────

export function buildBrowsyRecordingSpecForTask({ campaign, task, release = null, config = getBrowsyConfig(), workflowContext = null } = {}) {
  if (!task) throw new Error('A Magic Release task is required to build a Browsy recording spec.');
  const workflowId = String(task.source_workflow_id || '').trim();
  if (!workflowId) {
    return { supported: false, reason: `Task ${task.task_key} has no Browsy workflow id.`, workflowId: null, spec: null };
  }
  const releaseType = campaign?.release_type || release?.type || 'single';
  const releaseId = String(campaign?.release_id || release?.id || '');
  // Recording is a local-only bridge: the recorder browser and Browsy both reach
  // Pancake on this machine, so this tab always uses localhost (never ngrok),
  // independent of PANCAKE_DISABLE_NGROK.
  const releaseTabUrl = `${getLocalAppBaseUrl()}/releases/${encodeURIComponent(releaseType)}/{releaseId}`;
  const appId = config.appId;
  const appName = 'Pancake Robot';
  const base = { appId, appName, workflowId, workflowName: WORKFLOW_NAMES[workflowId] || workflowId, releaseType, releaseId };

  if (/distrokid-(album|single)-submit/.test(workflowId)) {
    return { supported: true, reason: '', workflowId, spec: distrokidSubmitSpec({ base, releaseTabUrl, single: /single/.test(workflowId), workflowContext, config }) };
  }
  if (/hyperfollow-capture/.test(workflowId)) {
    return { supported: true, reason: '', workflowId, spec: hyperfollowCaptureSpec({ base, releaseTabUrl }) };
  }
  if (/hyperfollow-enrich/.test(workflowId)) {
    return { supported: true, reason: '', workflowId, spec: hyperfollowEnrichSpec({ base, releaseTabUrl }) };
  }
  if (/platform-link-harvest/.test(workflowId)) {
    return { supported: true, reason: '', workflowId, spec: linkHarvestSpec({ base, releaseTabUrl }) };
  }
  // YouTube / social scheduling: no canonical recording template yet because the
  // target platform URL is operator-specific. Scaffold the call but mark it
  // unsupported with a clear reason rather than recording a placeholder.
  return {
    supported: false,
    reason: `No Browsy recording template is defined for workflow "${workflowId}" yet (target platform URL is operator-specific).`,
    workflowId,
    spec: null,
  };
}

function distrokidSubmitSpec({ base, releaseTabUrl, single, workflowContext = null, config = getBrowsyConfig() }) {
  const context = workflowContext || (single ? null : buildDistroKidAlbumWorkflowContext({ browsyBaseUrl: config.baseUrl }));
  const targetUrl = context?.targetUrl || DISTROKID_UPLOAD_URL;
  const inputSchema = context?.inputSchema || {
    type: 'object',
    required: ['album', 'tracks'],
    properties: {
      album: {
        type: 'object',
        required: ['title', 'artistName', 'releaseDate'],
        properties: {
          title: { type: 'string', title: 'Album title' },
          artistName: { type: 'string', title: 'Artist name' },
          releaseDate: { type: 'string', title: 'Release date' },
          artworkPath: { type: 'string', title: 'Artwork file path' },
        },
      },
      tracks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', title: 'Track title' },
            audioPath: { type: 'string', title: 'Audio file path' },
            trackNumber: { type: 'number', title: 'Track number' },
          },
        },
      },
    },
  };
  return {
    ...base,
    workflowRef: context?.workflowRef || `${base.appId}.${base.workflowId}`,
    sourceApp: context?.sourceApp || base.appId,
    targetUrl,
    packageId: context?.packageId || null,
    inputSchema,
    requiredAssets: context?.requiredAssets || [
      { path: 'album.artworkPath', type: 'file', label: 'Album artwork', required: true },
      { path: 'tracks[].audioPath', type: 'file', label: 'Track audio files', required: true },
    ],
    samplePayload: context?.samplePayload || null,
    derivedVariables: context?.derivedVariables || { numberOfSongs: 'tracks.length' },
    bindingHints: context?.bindingHints || [],
    recordingSetup: {
      authProfileId: DISTROKID_AUTH_PROFILE_ID,
      authPreflight: { targetUrl, rules: DISTROKID_AUTH_PREFLIGHT_RULES },
      tabs: [
        { id: 'pancakeRelease', title: 'Pancake Robot Release', url: releaseTabUrl, urlTemplate: releaseTabUrl, siteId: 'pancake-robot', requiresAuth: false, role: 'source' },
        { id: 'distrokidUpload', title: 'DistroKid Upload', url: targetUrl, siteId: 'distrokid', requiresAuth: true, authProfileId: DISTROKID_AUTH_PROFILE_ID, role: 'target' },
      ],
    },
    payloadSchema: inputSchema,
    fileBindings: [
      { id: 'coverArtPath', label: 'Album artwork', source: 'payload.album.coverArtPath', binding: 'album.coverArtPath', required: true },
      { id: 'trackAudioFiles', label: 'Track audio files', source: 'payload.tracks[].audioPath', binding: 'tracks[].audioPath', required: true },
    ],
    expectedOutputs: [
      { id: 'distrokidReviewState', label: 'DistroKid review state', required: true },
      { id: 'distrokidReleaseUrl', label: 'DistroKid release URL', required: false },
    ],
    humanCheckpoints: [
      { id: 'beforeFinalSubmit', label: 'Stop before final submit', beforeAction: 'final_submit', reason: 'Ken approval required before external release submission' },
    ],
    completionPolicy: {
      defaultMode: 'dry_run',
      requireHumanApprovalFor: ['final_submit', 'release', 'payment', 'legal_certification'],
      liveExecutionRequiresExplicitChoice: true,
    },
    writebackTargets: [
      { id: 'distrokidReviewState', output: 'distrokidReviewState', target: 'release_cockpit.distrokid_preview' },
      { id: 'distrokidReleaseUrl', output: 'distrokidReleaseUrl', target: 'release_links.distrokid_release_url' },
      { id: 'submissionStatus', output: 'submissionStatus', target: 'release.distribution_status' },
    ],
    _meta: { single: Boolean(single) },
  };
}

function hyperfollowCaptureSpec({ base, releaseTabUrl }) {
  return {
    ...base,
    recordingSetup: {
      authProfileId: DISTROKID_AUTH_PROFILE_ID,
      authPreflight: { targetUrl: 'https://distrokid.com/hyperfollow/', rules: DISTROKID_AUTH_PREFLIGHT_RULES },
      tabs: [
        { id: 'pancakeRelease', title: 'Pancake Robot Release', url: releaseTabUrl, urlTemplate: releaseTabUrl, siteId: 'pancake-robot', requiresAuth: false, role: 'source' },
        { id: 'distrokidHyperfollow', title: 'DistroKid HyperFollow', url: 'https://distrokid.com/hyperfollow/', siteId: 'distrokid', requiresAuth: true, authProfileId: DISTROKID_AUTH_PROFILE_ID, role: 'target' },
      ],
    },
    payloadSchema: {
      type: 'object',
      required: ['releaseId'],
      properties: { releaseId: { type: 'string', title: 'Release id' } },
    },
    fileBindings: [],
    expectedOutputs: [
      { id: 'hyperfollow_url', label: 'HyperFollow URL', required: true },
      { id: 'smart_link_url', label: 'Smart link URL', required: false },
    ],
    humanCheckpoints: [],
  };
}

function hyperfollowEnrichSpec({ base, releaseTabUrl }) {
  return {
    ...base,
    recordingSetup: {
      authProfileId: DISTROKID_AUTH_PROFILE_ID,
      authPreflight: { targetUrl: 'https://distrokid.com/hyperfollow/', rules: DISTROKID_AUTH_PREFLIGHT_RULES },
      tabs: [
        { id: 'pancakeRelease', title: 'Pancake Robot Release', url: releaseTabUrl, urlTemplate: releaseTabUrl, siteId: 'pancake-robot', requiresAuth: false, role: 'source' },
        { id: 'distrokidHyperfollow', title: 'DistroKid HyperFollow', url: 'https://distrokid.com/hyperfollow/', siteId: 'distrokid', requiresAuth: true, authProfileId: DISTROKID_AUTH_PROFILE_ID, role: 'target' },
      ],
    },
    payloadSchema: { type: 'object', required: ['releaseId'], properties: { releaseId: { type: 'string', title: 'Release id' } } },
    fileBindings: [],
    expectedOutputs: [{ id: 'hyperfollow_url', label: 'HyperFollow URL', required: false }],
    humanCheckpoints: [],
  };
}

function linkHarvestSpec({ base, releaseTabUrl }) {
  return {
    ...base,
    recordingSetup: {
      authProfileId: DISTROKID_AUTH_PROFILE_ID,
      authPreflight: { targetUrl: 'https://distrokid.com/mymusic', rules: DISTROKID_AUTH_PREFLIGHT_RULES },
      tabs: [
        { id: 'pancakeRelease', title: 'Pancake Robot Release', url: releaseTabUrl, urlTemplate: releaseTabUrl, siteId: 'pancake-robot', requiresAuth: false, role: 'source' },
        { id: 'distrokidBank', title: 'DistroKid Links', url: 'https://distrokid.com/mymusic', siteId: 'distrokid', requiresAuth: true, authProfileId: DISTROKID_AUTH_PROFILE_ID, role: 'target' },
      ],
    },
    payloadSchema: { type: 'object', required: ['releaseId'], properties: { releaseId: { type: 'string', title: 'Release id' } } },
    fileBindings: [],
    expectedOutputs: [
      { id: 'spotify_url', label: 'Spotify URL', required: false },
      { id: 'apple_music_url', label: 'Apple Music URL', required: false },
      { id: 'youtube_music_url', label: 'YouTube Music URL', required: false },
    ],
    humanCheckpoints: [],
  };
}

// ─────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────

export async function startMagicReleaseBrowsyRecording({ campaignId, taskKey, autoLaunch = true, config = getBrowsyConfig(), workflowContext = null } = {}) {
  const { campaign, task } = loadBrowsyTask(campaignId, taskKey);
  const built = buildBrowsyRecordingSpecForTask({ campaign, task, config, workflowContext });
  if (!built.supported) {
    const error = new Error(built.reason);
    error.code = 'unsupported_recording_workflow';
    throw error;
  }

  const callbackUrl = buildCallbackUrl(campaign, taskKey);
  const tabs = built.spec?.recordingSetup?.tabs || [];
  const targetTab = tabs.find(tab => tab.role === 'target') || tabs[tabs.length - 1];
  const targetUrl = built.spec?.targetUrl || targetTab?.url || '';
  logRecording(campaign, taskKey, 'info', 'Browsy workflow selected.', {
    workflowId: built.workflowId,
    workflowRef: built.spec?.workflowRef,
    releaseId: built.spec?.releaseId,
  });

  if (/distrokid-album-submit/.test(built.workflowId)) {
    const validation = validateDistroKidAlbumWorkflowContext({
      ...workflowContext,
      targetUrl,
      inputSchema: built.spec?.inputSchema,
      samplePayload: built.spec?.samplePayload,
    });
    logRecording(campaign, taskKey, validation.ok ? 'success' : 'error', validation.ok ? 'Setup validation passed.' : `Setup validation failed: ${validation.errors.join('; ')}`, {
      workflowId: built.workflowId,
      targetUrl,
      validation,
    });
    if (!validation.ok) {
      const recording = createReleaseBrowsyRecording({
        campaign_id: campaign.id,
        task_id: task.id,
        task_key: taskKey,
        release_type: campaign.release_type,
        release_id: campaign.release_id,
        workflow_id: built.workflowId,
        recording_status: 'setup_incomplete',
        browsy_base_url: config.baseUrl,
        last_error: validation.errors.join('; '),
      });
      return { ok: false, error: validation.errors.join('; '), validation, recording };
    }
  }

  // Validate tab spec before hitting Browsy — a missing/empty tabs array means
  // the spec builder has a bug; fail loudly rather than opening a blank recorder.
  if (!tabs.length) {
    const errMsg = `Recording spec for task ${taskKey} has no tabs — cannot launch recorder.`;
    const recording = createReleaseBrowsyRecording({
      campaign_id: campaign.id,
      task_id: task.id,
      task_key: taskKey,
      release_type: campaign.release_type,
      release_id: campaign.release_id,
      workflow_id: built.workflowId,
      recording_status: 'launch_failed',
      browsy_base_url: config.baseUrl,
      last_error: errMsg,
    });
    logRecording(campaign, taskKey, 'error', errMsg, { recordingId: recording.id });
    return { ok: false, error: errMsg, recording };
  }

  const resolvedTabs = tabs.map(tab => ({
    id: tab.id,
    urlTemplate: tab.urlTemplate || tab.url,
    url: resolveReleaseTemplate(tab.urlTemplate || tab.url, built.spec?.releaseId),
  }));

  logRecording(campaign, taskKey, 'info', 'Browsy variables resolved.', {
    releaseId: built.spec?.releaseId,
    availableVariables: Object.keys(flattenObject(built.spec?.samplePayload || {})).sort(),
    resolvedTabs,
  });

  // Log the full sanitized launch payload so the cockpit and logs confirm the tabs
  // are correct before Browsy is called.
  logRecording(campaign, taskKey, 'info', 'Browsy payload prepared.', {
    workflowId: built.workflowId,
    appId: config.appId,
    callbackUrl,
    tabCount: tabs.length,
    tabUrls: tabs.map(t => t.url),
    targetUrl,
    inputSchema: Boolean(built.spec?.inputSchema),
    samplePayload: Boolean(built.spec?.samplePayload),
  });

  // Local-only guard: refuse to record against ngrok URLs (stale tunnel URLs in a
  // spec tab or the callback would open a dead ngrok tab in the recorder).
  try {
    guardSpecAgainstNgrok(built.spec, callbackUrl);
  } catch (guardError) {
    const recording = createReleaseBrowsyRecording({
      campaign_id: campaign.id,
      task_id: task.id,
      task_key: taskKey,
      release_type: campaign.release_type,
      release_id: campaign.release_id,
      workflow_id: built.workflowId,
      recording_status: 'start_failed',
      browsy_base_url: config.baseUrl,
      last_error: guardError.message,
    });
    logRecording(campaign, taskKey, 'error', guardError.message, { recordingId: recording.id, localOnly: true });
    return { ok: false, error: guardError.message, localOnlyBlocked: true, recording };
  }

  logRecording(campaign, taskKey, 'info', 'Browsy payload sent.', {
    workflowId: built.workflowId,
    workflowRef: built.spec?.workflowRef,
    targetUrl,
    releaseId: built.spec?.releaseId,
    packageId: built.spec?.packageId,
    bindingHints: (built.spec?.bindingHints || []).map(item => item.path || item),
  });

  const started = await startBrowsyRecordingSession({ ...built.spec, callbackUrl, callbackMetadata: { campaignId: campaign.id, taskKey }, config });
  if (!started.ok) {
    const recording = createReleaseBrowsyRecording({
      campaign_id: campaign.id,
      task_id: task.id,
      task_key: taskKey,
      release_type: campaign.release_type,
      release_id: campaign.release_id,
      workflow_id: built.workflowId,
      recording_status: 'start_failed',
      browsy_base_url: config.baseUrl,
      last_error: started.error || 'Browsy did not start the recording session.',
    });
    logRecording(campaign, taskKey, 'error', `Failed to start Browsy recording: ${started.error}`, { recordingId: recording.id });
    return { ok: false, error: started.error, reachable: started.reachable, recording };
  }

  const session = started.recording || {};
  const recording = createReleaseBrowsyRecording({
    campaign_id: campaign.id,
    task_id: task.id,
    task_key: taskKey,
    release_type: campaign.release_type,
    release_id: campaign.release_id,
    workflow_id: built.workflowId,
    workflow_ref: session.workflowRefPreview || null,
    recording_session_id: session.recordingSessionId || started.recordingSessionId || null,
    recording_status: session.status || 'setup_ready',
    wizard_url: sanitizeStoredUrl(started.recordAutomationControl?.href || started.wizardUrl || session.wizardUrl),
    recorder_url: sanitizeStoredUrl(session.recorderUrl),
    browsy_base_url: config.baseUrl,
  });

  // Browsy accepted the start but returned no addressable session id — there is
  // nothing we can launch, stop, or import. Fail loudly here instead of letting
  // launchBrowsyRecordingSession throw a cryptic "recordingSessionId is required"
  // deeper in the client and stranding the row at setup_ready.
  if (!recording.recording_session_id) {
    const errMsg = 'Browsy started a recording but returned no recording session id — cannot launch the recorder.';
    const updated = updateRecording(recording.id, { recording_status: 'start_failed', last_error: errMsg });
    logRecording(campaign, taskKey, 'error', errMsg, { recordingId: recording.id });
    return { ok: false, error: errMsg, recording: updated };
  }

  logRecording(campaign, taskKey, 'success', 'Created Browsy recording session.', {
    recordingId: recording.id,
    recordingSessionId: recording.recording_session_id,
    wizardUrl: recording.wizard_url,
    localOnly: isLocalOnlyMode(),
  });

  if (!autoLaunch) {
    annotateTask(task, campaign, {
      reason: 'Browsy recording session started — launch the recorder and record the workflow.',
      suggested_action: 'Launch Browsy recorder, then Stop & Import.',
      action_url: started.recordAutomationControl?.href || started.wizardUrl || session.wizardUrl || task.action_url,
    });
    return {
      ok: true,
      recording,
      session,
      recordAutomationControl: started.recordAutomationControl || null,
      wizardUrl: started.wizardUrl || recording.wizard_url || null,
      launched: false,
    };
  }

  // Happy path: immediately launch the recorder so the operator only clicks once.
  const launchResult = await performRecorderLaunch({ recording, config });
  const reason = launchResult.authRequired
    ? `${launchResult.message} (Open Auth Browser → Verify Auth → Start Recording.)`
    : launchResult.ok
      ? (launchResult.authBlocked
        ? 'Recorder opened but the target sign-in was blocked — use Open Auth Browser, then retry.'
        : 'Recorder browser opened — complete the DistroKid flow, then stop recording.')
      : 'Recorder did not open — retry launch or check that Browsy is running.';
  annotateTask(task, campaign, {
    reason,
    suggested_action: launchResult.authRequired
      ? 'Open Auth Browser, sign in once, click Verify Auth, then Start Recording.'
      : launchResult.ok ? 'Complete the workflow, then Stop & Import.' : 'Relaunch the recorder or check Browsy.',
    action_url: started.recordAutomationControl?.href || started.wizardUrl || session.wizardUrl || task.action_url,
  });
  return {
    ok: launchResult.ok,
    recording: launchResult.recording || recording,
    session,
    recordAutomationControl: started.recordAutomationControl || null,
    wizardUrl: started.wizardUrl || recording.wizard_url || null,
    launched: launchResult.ok,
    authRequired: launchResult.authRequired || false,
    authBlocked: launchResult.authBlocked || false,
    launch: launchResult.launch || null,
    error: launchResult.error || null,
  };
}

export async function ensureMagicReleaseBrowsyRecordAutomation({ campaignId, taskKey, config = getBrowsyConfig(), workflowContext = null, forceNew = false } = {}) {
  const existing = getLatestReleaseBrowsyRecordingForTask(campaignId, taskKey);
  if (existing?.wizard_url && !forceNew) {
    return {
      ok: true,
      reused: true,
      recording: existing,
      recordAutomationControl: {
        label: 'Record Automation',
        href: existing.wizard_url,
        action: 'open_browsy_new_automation_wizard',
      },
      wizardUrl: existing.wizard_url,
    };
  }
  if (existing?.wizard_url && forceNew) {
    const campaign = getReleaseCampaignById(campaignId);
    if (campaign) {
      logRecording(campaign, taskKey, 'info', 'Creating fresh Browsy recording session for current release payload.', {
        previousRecordingId: existing.id,
        previousRecordingSessionId: existing.recording_session_id,
        previousWizardUrl: existing.wizard_url,
      });
    }
  }

  const started = await startMagicReleaseBrowsyRecording({
    campaignId,
    taskKey,
    autoLaunch: false,
    config,
    workflowContext,
  });
  const href = started.recordAutomationControl?.href || started.wizardUrl || started.recording?.wizard_url || null;
  if (!started.ok || !href) {
    return {
      ...started,
      ok: false,
      reused: false,
      error: started.error || 'Browsy did not return a Record Automation wizard URL.',
      recordAutomationControl: null,
      wizardUrl: href,
    };
  }
  return {
    ...started,
    ok: true,
    reused: false,
    recordAutomationControl: started.recordAutomationControl || {
      label: 'Record Automation',
      href,
      action: 'open_browsy_new_automation_wizard',
    },
    wizardUrl: href,
  };
}

export async function launchMagicReleaseBrowsyRecording({ recordingId, config = getBrowsyConfig() } = {}) {
  const recording = mustGetRecording(recordingId);
  return performRecorderLaunch({ recording, config });
}

// Shared launch path used by both the one-click Start flow and the secondary
// Relaunch/Retry action. Interprets the Browsy launch result: a clean launch,
// a hard failure (Browsy down / Playwright error), or an auth-blocked launch
// (the recorder opened but the target site bounced sign-in, e.g. Google's
// "this browser or app may not be secure").
async function performRecorderLaunch({ recording, config = getBrowsyConfig() } = {}) {
  const spec = recordingSpecForRecording(recording, config);
  const authProfileId = spec?.recordingSetup?.authProfileId || DISTROKID_AUTH_PROFILE_ID;

  // Local-only guard against stale ngrok in the spec/persisted URLs.
  try {
    guardSpecAgainstNgrok(spec, recording.recorder_url);
  } catch (guardError) {
    const updated = updateRecording(recording.id, { recording_status: 'launch_failed', last_error: guardError.message });
    logRecordingById(recording, 'error', guardError.message, { recordingId: recording.id, localOnly: true });
    return { ok: false, error: guardError.message, localOnlyBlocked: true, recording: updated };
  }

  // Auth preflight gate: before opening the recorder (which would otherwise land
  // on Google's rejected-OAuth page in the automation browser), probe the target
  // in the SAME persistent profile recording will use. We only block on a preflight
  // that *successfully ran* and reported not-authenticated. An unreachable Browsy,
  // a preflight transport error, or a Browsy without the preflight endpoint all
  // fall through to the launch, which surfaces any real error itself — we never
  // block recording on an inconclusive preflight.
  const preflightConfig = authPreflightForSpec(spec);
  if (preflightConfig) {
    const preflight = await runBrowsyAuthPreflight({
      appId: config.appId,
      workflowId: recording.workflow_id,
      authProfileId: preflightConfig.authProfileId,
      targetUrl: preflightConfig.targetUrl,
      rules: preflightConfig.rules,
      config,
    });
    if (preflight.ok && preflight.reachable && preflight.authenticated === false) {
      const status = preflight.code === 'auth_rejected' ? 'auth_rejected' : 'auth_required';
      const message = status === 'auth_rejected'
        ? 'DistroKid sign-in was rejected by Google in the automation browser. Open Auth Browser, sign in once with the persistent Chrome profile, then retry.'
        : 'DistroKid authentication is required. Open Auth Browser first, sign in once, then retry recording.';
      const updated = updateRecording(recording.id, { recording_status: status, last_error: message });
      logRecordingById(recording, 'warning', `Auth preflight blocked recorder launch: ${message}`, {
        recordingId: recording.id,
        authProfileId: preflightConfig.authProfileId,
        targetUrl: preflightConfig.targetUrl,
        finalUrl: preflight.finalUrl,
        code: preflight.code,
      });
      return { ok: false, authRequired: true, code: preflight.code, message, recording: updated, preflight };
    }
  }

  const launched = await launchBrowsyRecordingSession({
    recordingSessionId: recording.recording_session_id,
    usePersistentProfile: true,
    authProfileId,
    headless: false,
    slowMo: 100,
    config,
  });

  if (!launched.ok) {
    const updated = updateRecording(recording.id, { recording_status: 'launch_failed', last_error: launched.error });
    logRecordingById(recording, 'error', `Recorder launch failed (did not open): ${launched.error}`, {
      recordingId: recording.id,
      reachable: launched.reachable !== false,
    });
    return { ok: false, error: launched.error, reachable: launched.reachable, recording: updated };
  }

  const openedTabs = Array.isArray(launched.launch?.openedTabs) ? launched.launch.openedTabs : [];

  // Hard fail if Browsy itself flagged a verification failure, or if the opened
  // tabs all stayed on about:blank (navigation silently didn't happen).
  if (launched.launch?.launchFailed || launched.launch?.verification?.ok === false) {
    const verification = launched.launch?.verification || null;
    const failMsg = buildLaunchFailedMessage(spec, openedTabs, verification);
    const updated = updateRecording(recording.id, { recording_status: 'launch_failed', last_error: failMsg });
    logRecordingById(recording, 'error', `Recorder launch failed — tabs did not navigate: ${failMsg}`, {
      recordingId: recording.id,
      expectedUrls: verification?.expectedUrls || spec?.recordingSetup?.tabs?.map(t => t.url) || [],
      actualUrls: verification?.actualUrls || openedTabs.map(t => t.finalUrl || t.url),
      blankTabs: verification?.blankTabs || [],
      navErrors: verification?.navErrors || [],
    });
    return { ok: false, error: failMsg, recording: updated, launch: launched.launch };
  }

  // If Browsy returned openedTabs and they are all blank, treat as launch_failed
  // even without an explicit verification flag (defensive double-check).
  if (openedTabs.length > 0 && openedTabs.every(t => isBlankOrMissing(t.finalUrl))) {
    const expectedUrls = spec?.recordingSetup?.tabs?.map(t => t.url) || [];
    const actualUrls = openedTabs.map(t => t.finalUrl || '(no url)');
    const failMsg =
      `Recorder opened but all tabs are still about:blank — navigation did not run. ` +
      `Expected [${expectedUrls.join(', ')}] but got [${actualUrls.join(', ')}].`;
    const updated = updateRecording(recording.id, { recording_status: 'launch_failed', last_error: failMsg });
    logRecordingById(recording, 'error', `Recorder launch failed — all tabs are about:blank: ${failMsg}`, {
      recordingId: recording.id,
      expectedUrls,
      actualUrls,
    });
    return { ok: false, error: failMsg, recording: updated, launch: launched.launch };
  }

  const authBlocked = Boolean(launched.launch?.authBlocked) || openedTabs.some(tab => tab?.authBlocked);
  const authMessage = launched.launch?.authBlockedReason
    || openedTabs.find(tab => tab?.authBlocked)?.blockedReason
    || 'Google blocked sign-in in the automation browser. Use Open Auth Setup (persistent Chrome profile), sign in once, then retry recording.';

  if (authBlocked) {
    const updated = updateRecording(recording.id, {
      recording_status: 'auth_blocked',
      launched_at: new Date().toISOString(),
      last_error: authMessage,
    });
    logRecordingById(recording, 'warning', `Recorder opened but sign-in was blocked: ${authMessage}`, {
      recordingId: recording.id,
      authProfileId,
      persistentProfile: true,
      openedTabs: openedTabs.map(tab => tab?.finalUrl || tab?.url).filter(Boolean),
    });
    return { ok: true, authBlocked: true, recording: updated, launch: launched.launch, active: launched.active };
  }

  const updated = updateRecording(recording.id, {
    recording_status: launched.recording?.status || 'recording',
    launched_at: new Date().toISOString(),
    last_error: null,
  });
  logRecordingById(recording, 'success', 'Browser launched for Browsy recording.', {
    recordingId: recording.id,
    authProfileId,
    persistentProfile: true,
    localOnly: isLocalOnlyMode(),
    openedTabs: openedTabs.map(tab => tab?.finalUrl || tab?.url).filter(Boolean),
  });
  return { ok: true, authBlocked: false, recording: updated, launch: launched.launch, active: launched.active };
}

// Generic "prepare browser profile" action. Opens the named persistent Chrome
// profile straight to the target (auth-required) site so the operator can sign in
// once; Browsy persists the profile so subsequent recordings reuse the session.
// Pancake only supplies the target URL + profile name — no DistroKid login logic.
export async function prepareMagicReleaseBrowsyAuthProfile({ campaignId, taskKey, config = getBrowsyConfig() } = {}) {
  const { campaign, task } = loadBrowsyTask(campaignId, taskKey);
  const built = buildBrowsyRecordingSpecForTask({ campaign, task, config });
  if (!built.supported) {
    return { ok: false, error: built.reason };
  }
  const tabs = built.spec?.recordingSetup?.tabs || [];
  const targetTab = tabs.find(tab => tab.requiresAuth) || tabs.find(tab => tab.role === 'target') || tabs[tabs.length - 1];
  const authProfileId = built.spec?.recordingSetup?.authProfileId || targetTab?.authProfileId || DISTROKID_AUTH_PROFILE_ID;
  const targetUrl = targetTab?.url;
  if (!targetUrl) return { ok: false, error: 'No auth-required target tab to prepare a profile for.' };

  const prepared = await prepareBrowsyAuthProfile({
    appId: config.appId,
    workflowId: built.workflowId,
    authProfileId,
    targetUrl,
    config,
  });
  if (!prepared.ok) {
    logRecording(campaign, taskKey, 'error', `Auth setup failed: ${prepared.error}`, { authProfileId, targetUrl });
    return { ok: false, error: prepared.error, reachable: prepared.reachable };
  }
  logRecording(campaign, taskKey, 'success', 'Opened persistent Chrome auth profile for sign-in.', {
    authProfileId,
    targetUrl,
    profilePath: prepared.profile?.userDataDir || null,
  });
  return { ok: true, profile: prepared.profile, authProfileId, targetUrl };
}

// Generic "Verify Auth" action: run an auth preflight against the persistent
// profile recording will use, and report whether the operator is signed in —
// without launching a recorder. Lets the cockpit confirm sign-in succeeded after
// Open Auth Browser, and gives a clear next step if not.
export async function verifyMagicReleaseBrowsyAuth({ campaignId, taskKey, config = getBrowsyConfig() } = {}) {
  const { campaign, task } = loadBrowsyTask(campaignId, taskKey);
  const built = buildBrowsyRecordingSpecForTask({ campaign, task, config });
  if (!built.supported) return { ok: false, error: built.reason };
  const preflightConfig = authPreflightForSpec(built.spec);
  if (!preflightConfig) return { ok: false, error: 'No auth-required target to verify for this workflow.' };

  const preflight = await runBrowsyAuthPreflight({
    appId: config.appId,
    workflowId: built.workflowId,
    authProfileId: preflightConfig.authProfileId,
    targetUrl: preflightConfig.targetUrl,
    rules: preflightConfig.rules,
    config,
  });
  if (!preflight.reachable) {
    logRecording(campaign, taskKey, 'error', `Auth verify failed — Browsy unreachable: ${preflight.message || preflight.error}`, {
      authProfileId: preflightConfig.authProfileId,
      targetUrl: preflightConfig.targetUrl,
    });
    return { ok: false, reachable: false, error: preflight.message || preflight.error, preflight };
  }

  const authenticated = preflight.authenticated === true;
  logRecording(campaign, taskKey, authenticated ? 'success' : 'warning',
    authenticated
      ? 'DistroKid auth verified — the persistent profile is signed in.'
      : `DistroKid auth not verified (${preflight.code}). Open Auth Browser and sign in once, then verify again.`,
    {
      authProfileId: preflightConfig.authProfileId,
      targetUrl: preflightConfig.targetUrl,
      finalUrl: preflight.finalUrl,
      code: preflight.code,
    });
  return {
    ok: true,
    reachable: true,
    authenticated,
    code: preflight.code,
    finalUrl: preflight.finalUrl,
    authProfileId: preflightConfig.authProfileId,
    targetUrl: preflightConfig.targetUrl,
    message: preflight.message,
    preflight,
  };
}

export async function stopMagicReleaseBrowsyRecording({ recordingId, config = getBrowsyConfig() } = {}) {
  const recording = mustGetRecording(recordingId);
  const stopped = await stopBrowsyRecordingSession(recording.recording_session_id, config);
  if (!stopped.ok) {
    const updated = updateRecording(recording.id, { last_error: stopped.error });
    logRecordingById(recording, 'error', `Failed to stop Browsy recording: ${stopped.error}`, {
      recordingId: recording.id,
      reachable: stopped.reachable !== false,
    });
    return { ok: false, error: stopped.error, reachable: stopped.reachable, recording: updated };
  }
  const updated = updateRecording(recording.id, {
    recording_status: stopped.recording?.status || 'stopped',
    stopped_at: new Date().toISOString(),
    last_error: null,
  });
  logRecordingById(recording, 'success', 'Recording saved in Browsy.', { recordingId: recording.id, runtime: stopped.runtime });
  return { ok: true, recording: updated, runtime: stopped.runtime };
}

export async function importMagicReleaseBrowsyRecording({ recordingId, overwrite = true, config = getBrowsyConfig() } = {}) {
  const recording = mustGetRecording(recordingId);
  const { campaign, task } = loadBrowsyTask(recording.campaign_id, recording.task_key);
  const imported = await importBrowsyRecordingSession({
    recordingSessionId: recording.recording_session_id,
    appId: config.appId,
    appName: 'Pancake Robot',
    overwrite,
    packageKind: 'local',
    autoRegisterApp: true,
    config,
  });
  if (!imported.ok) {
    const updated = updateRecording(recording.id, { recording_status: 'import_failed', last_error: imported.error });
    logRecording(campaign, recording.task_key, 'error', `Browsy import failed: ${imported.error}`, { recordingId: recording.id });
    return { ok: false, error: imported.error, reachable: imported.reachable, recording: updated };
  }

  let contract = imported.contract;
  if (!contract) {
    const fetched = await getBrowsyRecordingContract(recording.recording_session_id, config);
    contract = fetched.contract;
  }
  const completeness = evaluateBrowsyContractCompleteness(contract, recording.workflow_id);
  const updated = updateRecording(recording.id, {
    recording_status: 'imported',
    imported_at: new Date().toISOString(),
    imported_workflow_ref: imported.workflowRef || contract?.workflowRef || null,
    workflow_ref: imported.workflowRef || contract?.workflowRef || recording.workflow_ref,
    contract_snapshot: contract || null,
    contract_completeness: completeness,
    last_error: null,
  });

  applyContractReadinessToTask({ campaign, task, completeness });
  logRecording(campaign, recording.task_key, completeness.ready ? 'success' : 'warning',
    completeness.ready ? 'Recording saved/imported — Browsy workflow contract ready.' : `Recording saved/imported — contract incomplete: ${completeness.summary}`,
    { recordingId: recording.id, workflowRef: updated.imported_workflow_ref, severity: completeness.severity });
  return { ok: true, recording: updated, contract, completeness };
}

// Re-fetches the published workflow contract for a Browsy-owned task (using its
// source_workflow_id), evaluates completeness, stores the snapshot, and returns
// readiness. Used by the cockpit "Refresh Contract" action and the run gate.
export async function refreshMagicReleaseBrowsyContract({ campaignId, taskKey, config = getBrowsyConfig() } = {}) {
  const { campaign, task } = loadBrowsyTask(campaignId, taskKey);
  const workflowId = String(task.source_workflow_id || '').trim();
  if (!workflowId) return { ok: false, error: `Task ${taskKey} has no Browsy workflow id.`, ready: false };
  const fetched = await getBrowsyWorkflowContract({ appId: config.appId, workflowId, version: config.workflowVersion, config });
  if (!fetched.reachable) {
    return { ok: false, reachable: false, error: fetched.error || 'Browsy unreachable.', ready: false, severity: 'error' };
  }
  const contract = fetched.contract;
  const completeness = evaluateBrowsyContractCompleteness(contract, workflowId);
  const existing = getLatestReleaseBrowsyRecordingForTask(campaignId, taskKey);
  if (existing) {
    updateRecording(existing.id, { contract_snapshot: contract || null, contract_completeness: completeness, workflow_ref: contract?.workflowRef || existing.workflow_ref });
  }
  applyContractReadinessToTask({ campaign, task, completeness });
  return { ok: Boolean(contract), reachable: true, ready: completeness.ready, severity: completeness.severity, completeness, contract };
}

export function listMagicReleaseBrowsyRecordings({ campaignId } = {}) {
  return listReleaseBrowsyRecordingsForCampaign(campaignId);
}

// Builds an operator-readable view model of every Browsy-owned task and its
// latest recording for the Release Cockpit. Pure read — no network calls — so it
// stays fast; reachability/contract refresh happen via explicit cockpit actions.
export function summarizeMagicReleaseBrowsyRecordings({ campaignId, config = getBrowsyConfig() } = {}) {
  if (!campaignId) return null;
  const campaign = getReleaseCampaignById(campaignId);
  if (!campaign) return null;
  const tasks = listReleaseCampaignTasks(campaignId).filter(task => task.owner === 'browsy');
  const items = tasks.map(task => {
    const built = buildBrowsyRecordingSpecForTask({ campaign, task, config });
    const recording = getLatestReleaseBrowsyRecordingForTask(campaignId, task.task_key);
    const completeness = recording?.contract_completeness && Object.keys(recording.contract_completeness).length
      ? recording.contract_completeness
      : null;
    const contract = recording?.contract_snapshot && Object.keys(recording.contract_snapshot).length
      ? recording.contract_snapshot
      : null;
    const counts = {
      tabs: countArray(contract?.tabs),
      recordedSteps: countArray(contract?.recordedSteps),
      fileUploadBindings: countArray(contract?.fileUploadBindings),
      humanApprovalCheckpoints: countArray(contract?.humanApprovalCheckpoints),
    };
    const readinessSeverity = completeness?.severity || (recording ? 'incomplete' : 'missing');
    return {
      taskKey: task.task_key,
      taskTitle: task.title,
      taskStatus: task.status,
      workflowId: built.workflowId || task.source_workflow_id || null,
      workflowName: WORKFLOW_NAMES[built.workflowId] || built.workflowId || task.source_workflow_id || null,
      supported: built.supported,
      unsupportedReason: built.supported ? null : built.reason,
      recordingId: recording?.id || null,
      recordingSessionId: recording?.recording_session_id || null,
      recordingStatus: recording?.recording_status || null,
      wizardUrl: recording?.wizard_url || null,
      recordAutomationControl: recording?.wizard_url ? {
        label: 'Record Automation',
        href: recording.wizard_url,
        action: 'open_browsy_new_automation_wizard',
      } : null,
      recorderUrl: recording?.recorder_url || null,
      importedWorkflowRef: recording?.imported_workflow_ref || recording?.workflow_ref || null,
      importedAt: recording?.imported_at || null,
      lastError: recording?.last_error || null,
      hasRecording: Boolean(recording),
      ready: Boolean(completeness?.ready),
      readinessSeverity,
      readinessSummary: completeness?.summary
        || (recording ? 'Recording started — record/import the workflow to publish a contract.' : 'No recording yet — start a Browsy recording for this workflow.'),
      readinessChecks: Array.isArray(completeness?.checks) ? completeness.checks : [],
      counts,
    };
  });
  return {
    campaignId,
    configured: Boolean(config.baseUrl),
    baseUrl: config.baseUrl,
    appId: config.appId,
    items,
    readyCount: items.filter(item => item.ready).length,
    pendingCount: items.filter(item => !item.ready).length,
  };
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

// ─────────────────────────────────────────────
// INTERNALS
// ─────────────────────────────────────────────

function loadBrowsyTask(campaignId, taskKey) {
  const campaign = getReleaseCampaignById(campaignId);
  if (!campaign) throw new Error(`Release campaign not found: ${campaignId}`);
  const task = getReleaseCampaignTaskByKey(campaignId, taskKey);
  if (!task) throw new Error(`Release campaign task not found: ${taskKey}`);
  if (task.owner !== 'browsy') {
    const error = new Error(`Task ${taskKey} is not a Browsy-owned task (owner=${task.owner}).`);
    error.code = 'not_browsy_task';
    throw error;
  }
  return { campaign, task };
}

function mustGetRecording(recordingId) {
  const recording = getReleaseBrowsyRecording(recordingId);
  if (!recording) throw new Error(`Browsy recording not found: ${recordingId}`);
  if (!recording.recording_session_id) throw new Error(`Browsy recording ${recordingId} has no recording session id.`);
  return recording;
}

function recordingSpecForRecording(recording, config) {
  const campaign = getReleaseCampaignById(recording.campaign_id);
  const task = getReleaseCampaignTaskByKey(recording.campaign_id, recording.task_key);
  if (!campaign || !task) return null;
  return buildBrowsyRecordingSpecForTask({ campaign, task, config }).spec;
}

function updateRecording(id, patch) {
  return updateReleaseBrowsyRecording(id, patch);
}

// On import/refresh, only *downgrade* an automation task when its contract is
// incomplete — we never auto-complete the automation task just because a
// recording was imported. The operator still has to run the workflow.
function applyContractReadinessToTask({ campaign, task, completeness }) {
  if (completeness.ready) {
    // Clear any recording-related block so recompute can re-derive readiness.
    if (['blocked', 'needs_ken'].includes(task.status) && /scaffold|record|contract|incomplete/i.test(String(task.reason || ''))) {
      upsertReleaseCampaignTask({ id: task.id, campaign_id: campaign.id, task_key: task.task_key, status: 'pending', reason: null, suggested_action: null });
    }
    return;
  }
  upsertReleaseCampaignTask({
    id: task.id,
    campaign_id: campaign.id,
    task_key: task.task_key,
    status: 'needs_ken',
    reason: completeness.summary,
    suggested_action: 'Record/import the Browsy workflow until the contract is complete.',
  });
}

function annotateTask(task, campaign, { reason, suggested_action, action_url }) {
  if (task.status === 'complete') return;
  upsertReleaseCampaignTask({
    id: task.id,
    campaign_id: campaign.id,
    task_key: task.task_key,
    reason,
    suggested_action,
    action_url,
  });
}

function isBlankOrMissing(url) {
  const u = String(url || '').trim();
  return !u || u === 'about:blank' || u.startsWith('chrome://newtab');
}

function resolveReleaseTemplate(url, releaseId) {
  return String(url || '')
    .replaceAll('{releaseId}', encodeURIComponent(String(releaseId || '')))
    .replaceAll('{{releaseId}}', encodeURIComponent(String(releaseId || '')));
}

function flattenObject(value, prefix = '', out = {}) {
  if (prefix) out[prefix] = value;
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    if (prefix) out[`${prefix}.length`] = value.length;
    if (value[0] && typeof value[0] === 'object') flattenObject(value[0], `${prefix}[]`, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenObject(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function buildLaunchFailedMessage(spec, openedTabs, verification) {
  if (verification?.summary) {
    const expected = verification.expectedUrls || [];
    const actual = verification.actualUrls || [];
    return `${verification.summary} Expected [${expected.join(', ')}], got [${actual.join(', ')}].`;
  }
  const expectedUrls = spec?.recordingSetup?.tabs?.map(t => t.url) || [];
  const actualUrls = openedTabs.map(t => t.finalUrl || '(no url)');
  return `Recorder tabs did not navigate. Expected [${expectedUrls.join(', ')}], got [${actualUrls.join(', ')}].`;
}

function buildCallbackUrl(campaign, taskKey) {
  // Browsy posts results back to Pancake on this machine — always localhost, never
  // a public/ngrok tunnel, regardless of PANCAKE_DISABLE_NGROK.
  const base = getLocalAppBaseUrl();
  return `${base}/releases/${encodeURIComponent(campaign.release_type)}/${encodeURIComponent(campaign.release_id)}/magic-release/ingest-result`;
}

// Fail fast if local-only mode is active but any tab URL or the callback still
// points at ngrok. Catches stale tunnel URLs persisted in an older recording spec.
function guardSpecAgainstNgrok(spec, callbackUrl) {
  if (!isLocalOnlyMode()) return;
  assertNoNgrokInLocalOnly(callbackUrl, 'recording callback URL');
  for (const tab of spec?.recordingSetup?.tabs || []) {
    assertNoNgrokInLocalOnly(tab?.url, `recorder tab "${tab?.id || tab?.title || '?'}" URL`);
  }
}

// Drop a stored URL that points at ngrok while in local-only mode so the cockpit
// never renders or re-opens a dead tunnel link.
function sanitizeStoredUrl(value) {
  if (!value) return null;
  if (isLocalOnlyMode() && containsNgrok(value)) return null;
  return value;
}

function logRecording(campaign, taskKey, status, message, payload = {}) {
  addReleaseCockpitLog({
    releaseType: campaign.release_type,
    releaseId: campaign.release_id,
    action: 'browsy_recording',
    status,
    message,
    payload: { taskKey, ...payload },
  });
}

function logRecordingById(recording, status, message, payload = {}) {
  addReleaseCockpitLog({
    releaseType: recording.release_type,
    releaseId: recording.release_id,
    action: 'browsy_recording',
    status,
    message,
    payload: { taskKey: recording.task_key, ...payload },
  });
}
