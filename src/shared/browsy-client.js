const DEFAULT_BROWSY_BASE_URL = 'http://localhost:3001';
const DEFAULT_BROWSY_APP_ID = 'pancake-robot';
const DEFAULT_BROWSY_MODE = 'preview';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60 * 1000;

// Canonical Browsy workflow ids Pancake Robot knows about. Keep them here so no
// string literals get scattered across the engine and cockpit.
export const BROWSY_WORKFLOW_IDS = Object.freeze({
  distrokidSingleSubmit: 'distrokid-single-submit',
  distrokidAlbumSubmit: 'distrokid-album-submit',
  hyperfollowCapture: 'distrokid-hyperfollow-capture',
  hyperfollowEnrich: 'distrokid-hyperfollow-enrich',
  platformLinkHarvest: 'platform-link-harvest',
});

// Browsy public run statuses (see browsy run-result contract). "created" and
// "running" are the only non-terminal states; everything else means the run has
// stopped and is either done, failed, canceled, or paused waiting on a human.
const BROWSY_NON_TERMINAL_STATUSES = new Set(['created', 'running']);

export function getBrowsyConfig(env = process.env) {
  return {
    baseUrl: clean(env.BROWSY_BASE_URL || env.PANCAKE_BROWSY_BASE_URL) || DEFAULT_BROWSY_BASE_URL,
    appId: clean(env.PANCAKE_BROWSY_APP_ID) || DEFAULT_BROWSY_APP_ID,
    mode: normalizeBrowsyMode(env.PANCAKE_BROWSY_MODE) || DEFAULT_BROWSY_MODE,
    workflowVersion: clean(env.PANCAKE_BROWSY_WORKFLOW_VERSION || env.PANCAKE_BROWSY_DISTROKID_WORKFLOW_VERSION),
    timeoutMs: Number(env.PANCAKE_BROWSY_HTTP_TIMEOUT_MS || 30_000),
    pollIntervalMs: Number(env.PANCAKE_BROWSY_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS),
    runTimeoutMs: Number(env.PANCAKE_BROWSY_TIMEOUT_MS || DEFAULT_RUN_TIMEOUT_MS),
    dryRun: resolveBrowsyDryRunFlag(env.PANCAKE_BROWSY_DRY_RUN),
  };
}

// Explicit-only dry-run resolution. Returns true/false when PANCAKE_BROWSY_DRY_RUN
// is set to an explicit boolean, otherwise null so callers fall back to the
// per-task intent. Dry-run must never be silently inferred from missing config.
export function resolveBrowsyDryRunFlag(value) {
  const raw = clean(value).toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return null;
}

export function isBrowsyTerminalStatus(status) {
  return !BROWSY_NON_TERMINAL_STATUSES.has(clean(status));
}

export function buildBrowsyWorkflowRef({ appId, workflowId, version = '' } = {}) {
  const resolvedAppId = clean(appId) || DEFAULT_BROWSY_APP_ID;
  const resolvedWorkflowId = clean(workflowId);
  if (!resolvedWorkflowId) throw new Error('Browsy workflowId is required.');
  return `${resolvedAppId}.${resolvedWorkflowId}${version ? `@${version}` : ''}`;
}

export async function startBrowsyWorkflowRun({
  workflowId,
  workflowRef = '',
  payload,
  mode = 'preview',
  callerId = 'pancake-robot',
  correlationId = '',
  approvalToken = '',
  options = null,
  config = getBrowsyConfig(),
} = {}) {
  const resolvedWorkflowRef = clean(workflowRef) || buildBrowsyWorkflowRef({
    appId: config.appId,
    workflowId,
    version: config.workflowVersion,
  });
  const body = pruneEmpty({
    payload: normalizeReleasePayload(payload),
    mode: normalizeBrowsyMode(mode),
    callerId,
    correlationId: clean(correlationId),
    approvalToken: clean(approvalToken),
    options,
  });

  const canonicalPath = `/api/workflows/${encodeURIComponent(resolvedWorkflowRef)}/runs`;
  const canonical = await postBrowsyJson(config, canonicalPath, body);
  if (canonical.ok || canonical.status !== 404) return normalizeStartRunResponse(canonical, resolvedWorkflowRef, canonicalPath);

  // Temporary compatibility path for the early Pancake/Browsy contract wording.
  const { appId, workflowId: parsedWorkflowId } = parseWorkflowRef(resolvedWorkflowRef);
  const legacyPath = `/api/apps/${encodeURIComponent(appId)}/workflows/${encodeURIComponent(parsedWorkflowId)}/runs`;
  const legacy = await postBrowsyJson(config, legacyPath, body);
  return normalizeStartRunResponse(legacy, resolvedWorkflowRef, legacyPath);
}

export async function getBrowsyRunStatus(runId, config = getBrowsyConfig()) {
  const id = clean(runId);
  if (!id) throw new Error('Browsy runId is required.');
  return getBrowsyJson(config, `/api/runs/${encodeURIComponent(id)}`);
}

export async function getBrowsyRunArtifacts(runId, config = getBrowsyConfig()) {
  const id = clean(runId);
  if (!id) throw new Error('Browsy runId is required.');
  return getBrowsyJson(config, `/api/runs/${encodeURIComponent(id)}/artifacts`);
}

// Maps a Browsy public run status into a coarse Pancake category so the engine
// can decide task state without re-deriving Browsy semantics everywhere.
export function categorizeBrowsyStatus(status) {
  switch (clean(status)) {
    case 'completed':
      return 'success';
    case 'waiting_for_auth':
    case 'waiting_for_2fa':
      return 'blocked_auth';
    case 'waiting_for_human_review':
    case 'waiting_for_approval':
    case 'waiting_for_approval_to_submit':
      return 'blocked_human_approval';
    case 'waiting_for_file_selection':
    case 'waiting_for_manual_page_fix':
    case 'blocked':
      return 'blocked_validation';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'failed';
  }
}

// Starts a workflow run over HTTP and polls until it reaches a terminal state or
// the run timeout elapses. Returns a normalized envelope; on a network failure to
// reach Browsy it returns { reachable: false } so callers can surface
// not_configured rather than fabricating success.
export async function executeBrowsyWorkflowRun({
  workflowId,
  payload,
  mode = 'preview',
  callerId = 'pancake-robot',
  correlationId = '',
  approvalToken = '',
  options = null,
  config = getBrowsyConfig(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const start = await startBrowsyWorkflowRun({ workflowId, payload, mode, callerId, correlationId, approvalToken, options, config });
  if (!start.ok) {
    const unreachable = start.status === 0;
    return {
      ok: false,
      reachable: !unreachable,
      runId: start.runId || null,
      workflowRef: start.workflowRef,
      endpointPath: start.endpointPath,
      status: start.status,
      error: start.error,
      response: start.response,
    };
  }
  if (!start.runId) {
    return { ok: false, reachable: true, runId: null, workflowRef: start.workflowRef, error: 'Browsy did not return a runId.', response: start.response };
  }

  const deadline = now() + (config.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS);
  let last = start.run || {};
  let runResult = null;
  let publicStatus = clean(start.status) || 'created';

  while (true) {
    let statusResponse;
    try {
      statusResponse = await getBrowsyRunStatus(start.runId, config);
    } catch (error) {
      return { ok: false, reachable: false, runId: start.runId, workflowRef: start.workflowRef, error: error.message };
    }
    last = statusResponse.run || last;
    runResult = statusResponse.json?.result || statusResponse.run?.result || runResult;
    publicStatus = clean(runResult?.status || last?.status || publicStatus);
    if (isBrowsyTerminalStatus(publicStatus)) break;
    if (now() >= deadline) {
      return { ok: false, reachable: true, timedOut: true, runId: start.runId, workflowRef: start.workflowRef, status: publicStatus, run: last, result: runResult };
    }
    await sleep(config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  }

  const category = categorizeBrowsyStatus(publicStatus);
  return {
    ok: category === 'success',
    reachable: true,
    runId: start.runId,
    workflowRef: start.workflowRef,
    endpointPath: start.endpointPath,
    status: publicStatus,
    category,
    run: last,
    result: runResult,
  };
}

// ─────────────────────────────────────────────
// RECORDING LIFECYCLE
//
// Pancake Robot owns the release/payload context and tells Browsy what kind of
// workflow it wants recorded. Browsy owns the browser recorder, auth profile,
// selectors, and the resulting workflow contract. These thin wrappers keep all
// recording HTTP details in this client module.
// ─────────────────────────────────────────────

export async function startBrowsyRecordingSession({
  workflowRef,
  workflowId,
  workflowName,
  sourceApp,
  appId,
  appName,
  releaseType,
  releaseId,
  packageId,
  targetUrl,
  recordingSetup,
  inputSchema,
  payloadSchema,
  requiredAssets,
  samplePayload,
  derivedVariables,
  bindingHints,
  fileBindings,
  expectedOutputs,
  humanCheckpoints,
  completionPolicy,
  writebackTargets,
  callbackMetadata,
  recorderUrl,
  callbackUrl,
  config = getBrowsyConfig(),
} = {}) {
  const normalizedSamplePayload = normalizeReleasePayload(samplePayload, releaseId);
  const body = pruneEmpty({
    workflowRef: clean(workflowRef) || undefined,
    appId: clean(appId) || config.appId,
    appName: clean(appName) || undefined,
    sourceApp: clean(sourceApp) || undefined,
    workflowId: clean(workflowId),
    workflowName: clean(workflowName) || undefined,
    releaseType: clean(releaseType) || undefined,
    releaseId: clean(releaseId) || undefined,
    packageId: clean(packageId) || undefined,
    targetUrl: clean(targetUrl) || undefined,
    recordingSetup,
    inputSchema,
    payloadSchema,
    requiredAssets,
    samplePayload: normalizedSamplePayload,
    derivedVariables,
    bindingHints,
    fileBindings,
    expectedOutputs,
    humanCheckpoints,
    completionPolicy,
    writebackTargets,
    callbackMetadata,
    recorderUrl: clean(recorderUrl) || undefined,
    callbackUrl: clean(callbackUrl) || undefined,
  });
  const result = await postBrowsyJson(config, '/api/recordings/start', body);
  return normalizeRecordingResponse(result, 'Browsy failed to start the recording session.');
}

export async function launchBrowsyRecordingSession({
  recordingSessionId,
  usePersistentProfile = true,
  authProfileId,
  headless = false,
  slowMo = 100,
  config = getBrowsyConfig(),
} = {}) {
  const id = clean(recordingSessionId);
  if (!id) throw new Error('Browsy recordingSessionId is required.');
  const body = pruneEmpty({
    usePersistentProfile,
    authProfileId: clean(authProfileId) || undefined,
    headless,
    slowMo,
  });
  const result = await postBrowsyJson(config, `/api/recordings/${encodeURIComponent(id)}/start`, body);
  return normalizeRecordingResponse(result, 'Browsy failed to launch the recorder.');
}

// Generic Browsy primitive: open the named persistent Chrome profile to a target
// URL so a human can sign in once. Pancake supplies only the profile name + URL;
// no site-specific login logic crosses the boundary.
export async function prepareBrowsyAuthProfile({
  appId,
  workflowId,
  authProfileId,
  targetUrl,
  config = getBrowsyConfig(),
} = {}) {
  const body = pruneEmpty({
    appId: clean(appId) || config.appId,
    workflowId: clean(workflowId) || undefined,
    authProfileId: clean(authProfileId) || undefined,
    targetUrl: clean(targetUrl),
  });
  const result = await postBrowsyJson(config, '/api/auth-profiles/prepare', body);
  if (!result.ok) {
    return { ok: false, reachable: result.status !== 0, status: result.status, error: result.error, profile: null };
  }
  return { ok: true, reachable: true, status: result.status, profile: result.json?.profile || result.json || null };
}

// Generic auth-preflight rules Pancake passes to Browsy (and uses for offline
// classification). These describe the "automation browser bounced to SSO/login"
// and Google-rejected-OAuth states without any DistroKid-specific logic — callers
// can override per workflow via recordingSetup.authPreflight.rules.
export const BROWSY_AUTH_PREFLIGHT_DEFAULT_RULES = Object.freeze([
  { code: 'auth_required', when: 'urlIncludes', value: 'accounts.google.com' },
  { code: 'auth_required', when: 'urlIncludes', value: '/signin' },
  { code: 'auth_required', when: 'urlIncludes', value: '/login' },
  { code: 'auth_rejected', when: 'textIncludes', value: 'this browser or app may not be secure' },
  { code: 'auth_required', when: 'textIncludes', value: "couldn't sign you in" },
  { code: 'auth_required', when: 'textIncludes', value: 'couldn’t sign you in' },
]);

// Pure, offline classifier mirroring Browsy's evaluateAuthPreflight. Lets Pancake
// classify observed page facts (or test fixtures) into an auth verdict without a
// live Browsy. Returns { ok, code, matchedRule }. ok=true means authenticated.
export function classifyBrowsyAuthPreflight({ finalUrl = '', title = '', bodyText = '', rules } = {}) {
  const activeRules = Array.isArray(rules) && rules.length ? rules : BROWSY_AUTH_PREFLIGHT_DEFAULT_RULES;
  const url = String(finalUrl || '').toLowerCase();
  const text = `${String(title || '')}\n${String(bodyText || '')}`.toLowerCase();
  for (const rule of activeRules) {
    const value = String(rule?.value || '').toLowerCase();
    if (!value) continue;
    const when = String(rule?.when || 'urlIncludes');
    let matched = false;
    if (when === 'urlIncludes') matched = url.includes(value);
    else if (when === 'urlEquals') matched = url === value;
    else if (when === 'textIncludes' || when === 'bodyIncludes' || when === 'titleIncludes') matched = text.includes(value);
    if (matched) {
      return { ok: false, code: rule.code || 'auth_required', matchedRule: { when, value: rule.value } };
    }
  }
  return { ok: true, code: 'authenticated', matchedRule: null };
}

// Generic Browsy primitive: run an auth preflight against the named persistent
// profile and target URL. Pancake supplies the URL + generic rules; Browsy opens
// the profile, observes the final page, and returns an authenticated/not verdict.
// Normalizes to { ok, reachable, authenticated, code, finalUrl, authUrl, message }.
export async function runBrowsyAuthPreflight({
  appId,
  workflowId,
  authProfileId,
  targetUrl,
  rules,
  options,
  config = getBrowsyConfig(),
} = {}) {
  const body = pruneEmpty({
    appId: clean(appId) || config.appId,
    workflowId: clean(workflowId) || undefined,
    authProfileId: clean(authProfileId) || undefined,
    targetUrl: clean(targetUrl),
    rules: Array.isArray(rules) && rules.length ? rules : undefined,
    options: options || undefined,
  });
  const result = await postBrowsyJson(config, '/api/auth-profiles/preflight', body);
  if (!result.ok) {
    return {
      ok: false,
      reachable: result.status !== 0,
      authenticated: false,
      status: result.status,
      error: result.error,
      code: 'preflight_failed',
      finalUrl: null,
      authUrl: clean(targetUrl) || null,
      message: result.error || 'Browsy auth preflight failed.',
      preflight: null,
    };
  }
  const preflight = result.json?.preflight || result.json || {};
  return {
    ok: true,
    reachable: true,
    authenticated: preflight.ok === true,
    status: result.status,
    code: preflight.code || (preflight.ok ? 'authenticated' : 'auth_required'),
    finalUrl: preflight.finalUrl || null,
    authUrl: clean(targetUrl) || null,
    message: preflight.message || null,
    preflight,
  };
}

export async function getBrowsyRecordingSession(recordingSessionId, config = getBrowsyConfig()) {
  const id = clean(recordingSessionId);
  if (!id) throw new Error('Browsy recordingSessionId is required.');
  const result = await getBrowsyJsonSafe(config, `/api/recordings/${encodeURIComponent(id)}`);
  return normalizeRecordingResponse(result, 'Browsy could not load the recording session.');
}

export async function stopBrowsyRecordingSession(recordingSessionId, config = getBrowsyConfig()) {
  const id = clean(recordingSessionId);
  if (!id) throw new Error('Browsy recordingSessionId is required.');
  const result = await postBrowsyJson(config, `/api/recordings/${encodeURIComponent(id)}/stop`, {});
  return normalizeRecordingResponse(result, 'Browsy failed to stop the recording.');
}

export async function importBrowsyRecordingSession({
  recordingSessionId,
  appId,
  appName,
  version = '1.0.0',
  overwrite = true,
  packageKind = 'local',
  autoRegisterApp = true,
  config = getBrowsyConfig(),
} = {}) {
  const id = clean(recordingSessionId);
  if (!id) throw new Error('Browsy recordingSessionId is required.');
  const body = pruneEmpty({
    appId: clean(appId) || config.appId,
    appName: clean(appName) || undefined,
    version: clean(version) || '1.0.0',
    overwrite,
    packageKind: clean(packageKind) || 'local',
    autoRegisterApp,
  });
  const result = await postBrowsyJson(config, `/api/recordings/${encodeURIComponent(id)}/import`, body);
  const normalized = normalizeRecordingResponse(result, 'Browsy failed to import the recording.');
  if (normalized.ok) {
    normalized.workflowRef = result.json?.workflowRef || normalized.recording?.workflowRef || null;
    normalized.contract = result.json?.contract || normalized.recording?.contract || null;
  }
  return normalized;
}

export async function getBrowsyRecordingContract(recordingSessionId, config = getBrowsyConfig()) {
  const id = clean(recordingSessionId);
  if (!id) throw new Error('Browsy recordingSessionId is required.');
  const result = await getBrowsyJsonSafe(config, `/api/recordings/${encodeURIComponent(id)}/contract`);
  if (!result.ok) {
    return { ok: false, reachable: result.status !== 0, status: result.status, error: result.error, contract: null };
  }
  return { ok: true, reachable: true, status: result.status, contract: result.json?.contract || null };
}

export async function getBrowsyWorkflowContract({ appId, workflowId, version = '', config = getBrowsyConfig() } = {}) {
  const resolvedAppId = clean(appId) || config.appId;
  const resolvedWorkflowId = clean(workflowId);
  if (!resolvedWorkflowId) throw new Error('Browsy workflowId is required.');
  const versionQuery = clean(version) ? `?version=${encodeURIComponent(clean(version))}` : '';
  const result = await getBrowsyJsonSafe(
    config,
    `/api/apps/${encodeURIComponent(resolvedAppId)}/workflows/${encodeURIComponent(resolvedWorkflowId)}/contract${versionQuery}`,
  );
  if (!result.ok) {
    return { ok: false, reachable: result.status !== 0, status: result.status, error: result.error, contract: null };
  }
  return { ok: true, reachable: true, status: result.status, contract: result.json?.contract || null };
}

// Evaluates whether a Browsy workflow contract is complete enough for Pancake to
// run it autonomously. Returns a structured verdict so the cockpit can show
// operator-readable readiness. A scaffold-only contract (no tabs / no recorded
// steps) is never reported as ready.
export function evaluateBrowsyContractCompleteness(contract, workflowId = '') {
  const ref = clean(workflowId) || contract?.workflowId || '';
  if (!contract) {
    return {
      ready: false,
      severity: 'missing',
      checks: [{ key: 'contract', ok: false, label: 'Workflow contract exists', actual: 'none', expected: 'present', severity: 'missing' }],
      summary: 'No Browsy workflow contract found — record and import the workflow first.',
    };
  }

  const tabs = asArrayLike(contract.tabs);
  const recordedSteps = asArrayLike(contract.recordedSteps);
  const fileUploadBindings = asArrayLike(contract.fileUploadBindings);
  const humanApprovalCheckpoints = asArrayLike(contract.humanApprovalCheckpoints);
  const requiredPayloadFields = asArrayLike(contract.requiredPayloadFields);
  const expectedOutputs = asArrayLike(contract.expectedOutputs);
  const auth = asArrayLike(contract.auth);
  const checks = [];

  const add = (key, ok, label, actual, expected, severity = 'incomplete') =>
    checks.push({ key, ok: Boolean(ok), label, actual, expected, severity: ok ? 'ready' : severity });

  add('contract', true, 'Workflow contract exists', 'present', 'present');
  add('runEndpoint', Boolean(clean(contract.runEndpoint)), 'Run endpoint published', clean(contract.runEndpoint) ? 'present' : 'missing', 'present');

  const isBrowserReplay = tabs.length > 0 || recordedSteps.length > 0 || /submit|capture|harvest|enrich|upload|schedule/i.test(ref);
  if (isBrowserReplay) {
    add('tabs', tabs.length > 0, 'Recorded browser tabs', tabs.length, '> 0');
    add('recordedSteps', recordedSteps.length > 0, 'Recorded steps', recordedSteps.length, '> 0');
  }

  if (/distrokid.*album.*submit|album-submit/i.test(ref) || /distrokid.*single.*submit|single-submit/i.test(ref)) {
    const single = /single/i.test(ref);
    add('requiredPayloadFields', requiredPayloadFields.includes('album') && requiredPayloadFields.includes('tracks'),
      'Requires album + tracks payload', requiredPayloadFields.join(', ') || 'none', 'album, tracks');
    add('fileUploadBindings', fileUploadBindings.length > 0, 'Artwork/audio upload bindings', fileUploadBindings.length, '> 0');
    add('humanApprovalCheckpoints', humanApprovalCheckpoints.length > 0, 'Human approval checkpoint before submit', humanApprovalCheckpoints.length, '> 0', 'incomplete');
    const hasAuth = auth.some(item => /distrokid|auth/i.test(JSON.stringify(item)))
      || tabs.some(tab => tab?.requiresAuth || /distrokid/i.test(clean(tab?.siteId)));
    add('auth', hasAuth, 'DistroKid authenticated tab/profile', hasAuth ? 'present' : 'missing', 'present');
    if (single) add('singleTrack', true, 'Single-track submit workflow', 'single', 'single');
  } else if (/hyperfollow.*capture|hyperfollow-capture/i.test(ref)) {
    add('recordedSteps', recordedSteps.length > 0, 'Recorded steps', recordedSteps.length, '> 0');
    const hasSmartLinkOutput = expectedOutputs.some(out => /hyperfollow|smart.?link/i.test(JSON.stringify(out)));
    if (expectedOutputs.length) add('expectedOutputs', hasSmartLinkOutput, 'Captures HyperFollow / smart link', hasSmartLinkOutput ? 'present' : 'missing', 'hyperfollow/smart link');
  } else if (/schedule|teaser|short.?form|social|post/i.test(ref)) {
    add('recordedSteps', recordedSteps.length > 0, 'Recorded steps', recordedSteps.length, '> 0');
    add('humanApprovalCheckpoints', humanApprovalCheckpoints.length > 0, 'Human approval before publish/schedule', humanApprovalCheckpoints.length, '> 0', 'incomplete');
  }

  const failed = checks.filter(check => !check.ok);
  const ready = failed.length === 0;
  // A contract with no recorded steps and no tabs is a scaffold-only stub — call
  // it out distinctly so the cockpit can tell "never recorded" apart from
  // "recorded but missing a required field".
  const isScaffold = recordedSteps.length === 0 && tabs.length === 0;
  const severity = ready ? 'ready' : (isScaffold ? 'scaffold' : 'incomplete');
  const summary = ready
    ? 'Contract is ready: recorded steps, tabs, and required fields are present.'
    : `Not ready — ${failed.map(check => check.label).join('; ')}.`;
  return { ready, severity, checks, summary };
}

function normalizeRecordingResponse(result, defaultError) {
  if (!result.ok) {
    return {
      ok: false,
      reachable: result.status !== 0,
      status: result.status,
      error: result.error || defaultError,
      response: result.json || null,
      recording: null,
    };
  }
  const json = result.json || {};
  const recording = json.recording || json;
  const wizardUrl = clean(json.recordAutomationControl?.href)
    || clean(json.wizardUrl)
    || clean(recording.wizardUrl)
    || null;
  const recordAutomationControl = json.recordAutomationControl
    ? {
        label: clean(json.recordAutomationControl.label) || 'Record Automation',
        href: clean(json.recordAutomationControl.href) || wizardUrl,
        action: clean(json.recordAutomationControl.action) || 'open_browsy_new_automation_wizard',
      }
    : (wizardUrl ? { label: 'Record Automation', href: wizardUrl, action: 'open_browsy_new_automation_wizard' } : null);
  return {
    ok: true,
    reachable: true,
    status: result.status,
    recordingSessionId: recording.recordingSessionId || json.recordingSessionId || null,
    recording,
    wizardUrl,
    recordAutomationControl,
    active: json.active || null,
    launch: json.launch || recording.launch || null,
    runtime: json.runtime || null,
    response: json,
  };
}

function asArrayLike(value) {
  return Array.isArray(value) ? value : [];
}

// GET that returns a structured envelope instead of throwing, so recording
// callers can distinguish unreachable Browsy (status 0) from a real 404.
async function getBrowsyJsonSafe(config, path) {
  const url = joinUrl(config.baseUrl, path);
  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, config.timeoutMs);
    const json = await readJsonResponse(response);
    return {
      ok: response.ok && json?.ok !== false,
      status: response.status,
      url,
      json,
      error: response.ok ? null : (json?.error || json?.message || response.statusText),
    };
  } catch (error) {
    return { ok: false, status: 0, url, json: null, error: error.message };
  }
}

async function postBrowsyJson(config, path, body) {
  const url = joinUrl(config.baseUrl, path);
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, config.timeoutMs);
    const json = await readJsonResponse(response);
    return {
      ok: response.ok && json?.ok !== false,
      status: response.status,
      url,
      json,
      error: response.ok ? null : (json?.error || json?.message || response.statusText),
    };
  } catch (error) {
    return { ok: false, status: 0, url, json: null, error: error.message };
  }
}

async function getBrowsyJson(config, path) {
  const url = joinUrl(config.baseUrl, path);
  const response = await fetchWithTimeout(url, { method: 'GET' }, config.timeoutMs);
  const json = await readJsonResponse(response);
  if (!response.ok || json?.ok === false) {
    throw new Error(json?.error || json?.message || response.statusText || `Browsy request failed: ${response.status}`);
  }
  return { ok: true, status: response.status, url, json, run: json?.run || json };
}

function normalizeStartRunResponse(result, workflowRef, endpointPath) {
  const runId = result.json?.runId || result.json?.run?.runId || result.json?.run?.id || result.json?.id || null;
  if (!result.ok) {
    return {
      ok: false,
      workflowRef,
      endpointPath,
      status: result.status,
      error: result.error || 'Browsy run failed to start.',
      response: result.json,
    };
  }
  return {
    ok: true,
    workflowRef,
    endpointPath,
    status: result.status,
    runId,
    run: result.json?.run || result.json,
    response: result.json,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 30_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: text };
  }
}

function parseWorkflowRef(workflowRef) {
  const refWithoutVersion = clean(workflowRef).split('@')[0];
  const firstDot = refWithoutVersion.indexOf('.');
  if (firstDot === -1) return { appId: DEFAULT_BROWSY_APP_ID, workflowId: refWithoutVersion };
  return {
    appId: refWithoutVersion.slice(0, firstDot),
    workflowId: refWithoutVersion.slice(firstDot + 1),
  };
}

function normalizeBrowsyMode(mode) {
  const raw = clean(mode).toLowerCase();
  if (raw === 'dry_run' || raw === 'dry-run') return 'preview';
  return raw || 'preview';
}

function normalizeReleasePayload(payload, fallbackReleaseId = '') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const releaseId = clean(
    fallbackReleaseId
    || payload.releaseId
    || payload.release_id
    || payload.albumId
    || payload.album_id
    || payload.album?.releaseId
    || payload.album?.id
  );
  if (!releaseId) return payload;
  const next = { ...payload, releaseId };
  if (!next.albumId) next.albumId = releaseId;
  if (next.album && typeof next.album === 'object' && !Array.isArray(next.album)) {
    next.album = {
      ...next.album,
      id: next.album.id || releaseId,
      releaseId: next.album.releaseId || releaseId,
    };
  }
  return next;
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || DEFAULT_BROWSY_BASE_URL).replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function clean(value) {
  return String(value || '').trim();
}

function pruneEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}
