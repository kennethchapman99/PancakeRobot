const DEFAULT_BROWSY_BASE_URL = 'http://localhost:3001';
const DEFAULT_BROWSY_APP_ID = 'pancake-robot';

export function getBrowsyConfig(env = process.env) {
  return {
    baseUrl: clean(env.PANCAKE_BROWSY_BASE_URL) || DEFAULT_BROWSY_BASE_URL,
    appId: clean(env.PANCAKE_BROWSY_APP_ID) || DEFAULT_BROWSY_APP_ID,
    workflowVersion: clean(env.PANCAKE_BROWSY_WORKFLOW_VERSION || env.PANCAKE_BROWSY_DISTROKID_WORKFLOW_VERSION),
    timeoutMs: Number(env.PANCAKE_BROWSY_HTTP_TIMEOUT_MS || 30_000),
  };
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
  approvalToken = '',
  config = getBrowsyConfig(),
} = {}) {
  const resolvedWorkflowRef = clean(workflowRef) || buildBrowsyWorkflowRef({
    appId: config.appId,
    workflowId,
    version: config.workflowVersion,
  });
  const body = pruneEmpty({
    payload,
    mode: normalizeBrowsyMode(mode),
    callerId,
    approvalToken: clean(approvalToken),
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

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || DEFAULT_BROWSY_BASE_URL).replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function clean(value) {
  return String(value || '').trim();
}

function pruneEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}
