const DEFAULT_BROWSY_BASE_URL = 'http://localhost:3001';
const DEFAULT_BROWSY_APP_ID = 'pancake-robot';

// Status buckets straight from the Browsy HTTP contract (contractVersion 1.0.0).
export const BROWSY_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'blocked', 'canceled']);
// Waiting states that THIS service is allowed to resume by POSTing /approve.
export const BROWSY_WAITING_APPROVABLE_STATUSES = Object.freeze([
  'waiting_for_approval',
  'waiting_for_approval_to_submit',
  'waiting_for_human_review',
]);
// Waiting states that must always be handed to a human — never auto-approved.
export const BROWSY_WAITING_HUMAN_STATUSES = Object.freeze([
  'waiting_for_auth',
  'waiting_for_2fa',
  'waiting_for_file_selection',
  'waiting_for_manual_page_fix',
]);
export const BROWSY_TRANSIENT_STATUSES = Object.freeze(['created', 'running']);
export const BROWSY_MODES = Object.freeze(['dry_run', 'preview', 'live']);

/**
 * Resolve the configurable Browsy base URL. The task contract uses BROWSY_BASE_URL;
 * we keep PANCAKE_BROWSY_BASE_URL as a fallback for the earlier scaffolding.
 */
export function resolveBrowsyBaseUrl(env = process.env) {
  return clean(env.BROWSY_BASE_URL) || clean(env.PANCAKE_BROWSY_BASE_URL) || DEFAULT_BROWSY_BASE_URL;
}

export function getBrowsyConfig(env = process.env) {
  return {
    baseUrl: resolveBrowsyBaseUrl(env),
    appId: clean(env.BROWSY_APP_ID) || clean(env.PANCAKE_BROWSY_APP_ID) || DEFAULT_BROWSY_APP_ID,
    workflowVersion: clean(env.PANCAKE_BROWSY_WORKFLOW_VERSION || env.PANCAKE_BROWSY_DISTROKID_WORKFLOW_VERSION),
    timeoutMs: Number(env.PANCAKE_BROWSY_HTTP_TIMEOUT_MS || env.BROWSY_HTTP_TIMEOUT_MS || 30_000),
  };
}

/**
 * Classify a Browsy run status into the action buckets the contract defines.
 * `terminal` → stop. `waiting` → needs action. `autoApprovable` → may /approve.
 * `needsHuman` → surface to a person. `transient` → keep polling.
 */
export function classifyBrowsyStatus(status) {
  const value = clean(status).toLowerCase();
  const autoApprovable = BROWSY_WAITING_APPROVABLE_STATUSES.includes(value);
  const needsHuman = BROWSY_WAITING_HUMAN_STATUSES.includes(value);
  return {
    status: value,
    terminal: BROWSY_TERMINAL_STATUSES.includes(value),
    waiting: autoApprovable || needsHuman,
    autoApprovable,
    needsHuman,
    transient: BROWSY_TRANSIENT_STATUSES.includes(value),
  };
}

/**
 * Normalize a requested mode against the documented contract. Unlike the legacy
 * normalizeBrowsyMode(), this keeps `dry_run` as its own mode.
 */
export function normalizeContractMode(mode) {
  const raw = clean(mode).toLowerCase().replace(/-/g, '_');
  if (!raw) return 'preview';
  if (!BROWSY_MODES.includes(raw)) {
    throw new Error(`Unsupported Browsy mode "${mode}". Expected one of: ${BROWSY_MODES.join(', ')}.`);
  }
  return raw;
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Thin async HTTP wrapper around the generic Browsy service. Knows nothing about
 * Pancake Robot or DistroKid — that mapping lives in browsy-release-pipeline.js.
 */
export class BrowsyClient {
  constructor(options = {}) {
    const env = options.env || process.env;
    this.baseUrl = String(options.baseUrl || resolveBrowsyBaseUrl(env)).replace(/\/+$/, '');
    this.appId = clean(options.appId) || clean(env.BROWSY_APP_ID) || clean(env.PANCAKE_BROWSY_APP_ID) || DEFAULT_BROWSY_APP_ID;
    this.callerId = clean(options.callerId) || 'pancake-robot';
    this.timeoutMs = Number(options.timeoutMs || env.BROWSY_HTTP_TIMEOUT_MS || env.PANCAKE_BROWSY_HTTP_TIMEOUT_MS || 30_000);
    this.fetchImpl = options.fetchImpl || null;
  }

  /** GET the machine-readable contract for a workflow. Returns the `contract` object. */
  async getContract({ workflowId, appId = this.appId, version = '' } = {}) {
    if (!clean(workflowId)) throw new Error('Browsy getContract requires a workflowId.');
    const query = clean(version) ? `?version=${encodeURIComponent(version)}` : '';
    const path = `/api/apps/${encodeURIComponent(appId)}/workflows/${encodeURIComponent(workflowId)}/contract${query}`;
    const json = await this.#get(path);
    const contract = json?.contract || (json?.requiredPayloadFields ? json : null);
    if (!contract) throw new Error(`Browsy returned no contract for ${appId}/${workflowId}.`);
    return contract;
  }

  /** POST a new run. Returns { ok, runId, status, statusUrl, contractVersion }. */
  async startRun({
    workflowId,
    appId = this.appId,
    mode = 'preview',
    version = '',
    payload = {},
    options = undefined,
    approvalToken = '',
    callerId = this.callerId,
  } = {}) {
    if (!clean(workflowId)) throw new Error('Browsy startRun requires a workflowId.');
    const normalizedMode = normalizeContractMode(mode);
    if (normalizedMode === 'live' && !clean(approvalToken)) {
      throw new Error('Browsy live runs require an approvalToken.');
    }
    const body = pruneEmpty({
      mode: normalizedMode,
      version: clean(version) || undefined,
      payload,
      options: options && Object.keys(options).length ? options : undefined,
      approvalToken: clean(approvalToken) || undefined,
      callerId,
    });
    const path = `/api/apps/${encodeURIComponent(appId)}/workflows/${encodeURIComponent(workflowId)}/runs`;
    const json = await this.#post(path, body);
    const runId = json?.runId || json?.run?.runId || json?.run?.id || json?.id || null;
    if (!runId) throw new Error('Browsy startRun response did not include a runId.');
    return {
      ok: true,
      runId,
      status: json?.status || json?.run?.status || 'running',
      statusUrl: json?.statusUrl || null,
      contractVersion: json?.contractVersion || null,
      response: json,
    };
  }

  /** GET a single run. Returns { ok, run, result, response }. */
  async getRun(runId) {
    const id = clean(runId);
    if (!id) throw new Error('Browsy getRun requires a runId.');
    const json = await this.#get(`/api/runs/${encodeURIComponent(id)}`);
    return { ok: true, run: json?.run || null, result: json?.result || null, response: json };
  }

  /**
   * Poll a run until it reaches a terminal status OR a waiting_* status that needs
   * action. Transient (created|running) statuses keep polling. Returns the last
   * snapshot enriched with the classifyBrowsyStatus() flags (plus `timedOut`).
   */
  async pollUntilDone(runId, {
    intervalMs = 1500,
    timeoutMs = 10 * 60 * 1000,
    onStatus = null,
    sleep = defaultSleep,
  } = {}) {
    const id = clean(runId);
    if (!id) throw new Error('Browsy pollUntilDone requires a runId.');
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      const snapshot = await this.getRun(id);
      const status = snapshot.result?.status || snapshot.run?.status || 'running';
      const classification = classifyBrowsyStatus(status);
      last = { ...snapshot, ...classification };
      if (onStatus) await onStatus(last);
      if (classification.terminal || classification.waiting) return last;
      if (Date.now() >= deadline) return { ...last, timedOut: true };
      await sleep(intervalMs);
    }
  }

  /** Resume a waiting run. Only call for autoApprovable statuses. */
  async approve(runId, { approvedBy = 'pancake-robot', note = '', approvalToken = '' } = {}) {
    const id = clean(runId);
    if (!id) throw new Error('Browsy approve requires a runId.');
    const json = await this.#post(
      `/api/runs/${encodeURIComponent(id)}/approve`,
      pruneEmpty({ approvedBy, note, approvalToken: clean(approvalToken) || undefined }),
    );
    return { ok: true, response: json };
  }

  /** Cancel a run. */
  async cancel(runId, { reason = '' } = {}) {
    const id = clean(runId);
    if (!id) throw new Error('Browsy cancel requires a runId.');
    const json = await this.#post(`/api/runs/${encodeURIComponent(id)}/cancel`, pruneEmpty({ reason }));
    return { ok: true, response: json };
  }

  /** GET artifacts for a run. Returns { ok, artifacts, groupedArtifacts, files }. */
  async getArtifacts(runId) {
    const id = clean(runId);
    if (!id) throw new Error('Browsy getArtifacts requires a runId.');
    const json = await this.#get(`/api/runs/${encodeURIComponent(id)}/artifacts`);
    return {
      ok: true,
      artifacts: json?.artifacts || [],
      groupedArtifacts: json?.groupedArtifacts || {},
      files: json?.files || [],
      response: json,
    };
  }

  #httpFetch(url, options) {
    const impl = this.fetchImpl || globalThis.fetch;
    return fetchWithTimeout(url, options, this.timeoutMs, impl);
  }

  async #get(path) {
    const url = joinUrl(this.baseUrl, path);
    const response = await this.#httpFetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    const json = await readJsonResponse(response);
    if (!response.ok || json?.ok === false) throw new Error(browsyErrorMessage(json, response, url));
    return json;
  }

  async #post(path, body) {
    const url = joinUrl(this.baseUrl, path);
    const response = await this.#httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = await readJsonResponse(response);
    if (!response.ok || json?.ok === false) throw new Error(browsyErrorMessage(json, response, url));
    return json;
  }
}

function browsyErrorMessage(json, response, url) {
  return json?.error
    || json?.message
    || response.statusText
    || `Browsy request failed (${response.status}) for ${url}`;
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

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 30_000);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
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
