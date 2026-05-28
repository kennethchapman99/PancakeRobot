// Pancake-Robot-specific glue between a release and the generic Browsy service.
//
// The contract endpoint is the source of truth for which payload fields/files a
// workflow needs. This module fetches that contract, maps Pancake Robot release
// data onto the binding names it declares (failing loudly when a required field is
// unmapped), drives dry_run -> preview -> live, and persists the structured result
// back onto the release record. NONE of this leaks into Browsy: the service stays
// generic; every release/DistroKid assumption lives here.

import fs from 'fs';
import path from 'path';

import { BrowsyClient, classifyBrowsyStatus, normalizeContractMode } from './browsy-client.js';

const DEFAULT_POLL = Object.freeze({ intervalMs: 1500, timeoutMs: 10 * 60 * 1000 });

// Pancake Robot's mapping from Browsy binding names to the canonical DistroKid
// payload. Aliases are tried in order; the first key present on the source wins.
// This is intentionally generous so a freshly recorded workflow keeps working as
// long as it uses conventional binding names — but the contract still decides
// which of these are actually required.
const BINDING_ALIASES = Object.freeze({
  artist: ['artist', 'artist_name', 'band_name', 'band'],
  release_title: ['release_title', 'album_title', 'title'],
  album_title: ['release_title', 'album_title', 'title'],
  track_title: ['track_title', 'song_title', 'title'],
  cover_art: ['artwork_path', 'cover_art', 'cover_art_path', 'artwork'],
  artwork: ['artwork_path', 'cover_art', 'cover_art_path', 'artwork'],
  audio_file: ['audio_path', 'audio_file', 'audio'],
  audio: ['audio_path', 'audio_file', 'audio'],
  primary_genre: ['primary_genre', 'genre'],
  genre: ['primary_genre', 'genre'],
  secondary_genre: ['secondary_genre'],
  language: ['language'],
  release_date: ['release_date'],
  label: ['label', 'record_label'],
  lyrics: ['lyrics', 'lyrics_text'],
  explicit: ['explicit'],
  instrumental: ['instrumental'],
  made_for_kids: ['made_for_kids', 'kids'],
  songwriter: ['songwriter'],
  songwriter_first: ['songwriter_first', 'songwriter_real_name_first'],
  songwriter_last: ['songwriter_last', 'songwriter_real_name_last'],
  producer: ['producer'],
  isrc: ['isrc'],
});

/**
 * Flatten the canonical release payload into a single normalized-key index of
 * candidate values, surfacing the first track's fields at the top level so
 * single-track bindings (track_title, audio_file, lyrics, ...) resolve directly.
 */
export function buildReleaseSourceIndex(canonical = {}) {
  const firstTrack = Array.isArray(canonical.tracks) && canonical.tracks.length ? canonical.tracks[0] : {};
  const index = {};
  const put = (key, value) => {
    const normalized = normalizeKey(key);
    if (normalized && value !== undefined && value !== null && value !== '' && index[normalized] === undefined) {
      index[normalized] = value;
    }
  };

  // Everything from the canonical payload (snake_case + camelCase aliases included).
  for (const [key, value] of Object.entries(canonical)) {
    if (value && typeof value === 'object') continue;
    put(key, value);
  }

  // Curated, release-level values.
  put('artist', canonical.artist || canonical.artistName);
  put('release_title', canonical.release_title || canonical.releaseTitle);
  put('album_title', canonical.release_title || canonical.releaseTitle);
  put('release_date', canonical.release_date || canonical.releaseDate);
  put('primary_genre', canonical.primary_genre || canonical.primaryGenre || canonical.genre);
  put('genre', canonical.primary_genre || canonical.primaryGenre || canonical.genre);
  put('secondary_genre', canonical.secondary_genre || canonical.secondaryGenre);
  put('label', canonical.label);
  put('language', canonical.language);
  put('artwork_path', canonical.artwork_path || canonical.artworkPath);
  put('cover_art', canonical.artwork_path || canonical.artworkPath);

  // First-track values.
  put('track_title', firstTrack.track_title || firstTrack.title);
  put('audio_path', firstTrack.audio_path || firstTrack.audioPath);
  put('audio_file', firstTrack.audio_path || firstTrack.audioPath);
  put('lyrics', firstTrack.lyrics);
  put('explicit', firstTrack.explicit);
  put('instrumental', firstTrack.instrumental);
  put('songwriter', firstTrack.songwriter);
  put('producer', firstTrack.producer);
  put('isrc', firstTrack.isrc);

  return index;
}

/**
 * Resolve a single binding name against the source index, honoring an explicit
 * override map first, then curated aliases, then a direct normalized match.
 * Returns `undefined` when nothing maps (the caller decides if that's fatal).
 */
function resolveBinding(binding, sourceIndex, canonical, overrideMap) {
  const override = overrideMap?.[binding];
  if (override !== undefined) {
    if (override && typeof override === 'object') {
      if ('value' in override) return override.value;
      if (override.source) return readPath(canonical, override.source) ?? sourceIndex[normalizeKey(override.source)];
    }
    if (typeof override === 'string') {
      return readPath(canonical, override) ?? sourceIndex[normalizeKey(override)];
    }
    return override;
  }

  const normalized = normalizeKey(binding);
  if (sourceIndex[normalized] !== undefined) return sourceIndex[normalized];

  for (const alias of BINDING_ALIASES[normalized] || []) {
    const value = sourceIndex[normalizeKey(alias)];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Build the Browsy run payload for a workflow strictly from its contract.
 *
 * @returns {{ payload, files, mapped, fileBindings }} — `payload` keyed by binding.
 * @throws if any requiredPayloadField / requiredFile / requiredAsset is unmapped,
 *         or if a required file path does not exist on disk.
 */
export function buildBrowsyPayloadFromContract({ contract, canonical, bindingMap = {} } = {}) {
  if (!contract) throw new Error('A Browsy contract is required to build a payload.');
  const sourceIndex = buildReleaseSourceIndex(canonical || {});

  const requiredFields = toNames(contract.requiredPayloadFields);
  const optionalFields = toNames(contract.optionalPayloadFields);
  // requiredFiles[] and requiredAssets[] are both file inputs (absolute paths).
  const fileBindings = new Set([...toNames(contract.requiredFiles), ...toNames(contract.requiredAssets)]);

  const payload = {};
  const files = {};
  const mapped = {};
  const missing = [];
  const missingFiles = [];

  const assign = (binding, { required }) => {
    const value = resolveBinding(binding, sourceIndex, canonical, bindingMap);
    const isFile = fileBindings.has(binding);
    if (value === undefined || value === '') {
      if (required) (isFile ? missingFiles : missing).push(binding);
      return;
    }
    if (isFile) {
      const absolute = ensureAbsolute(value);
      if (required && !fileExists(absolute)) {
        missingFiles.push(`${binding} (file not found: ${absolute})`);
        return;
      }
      files[binding] = absolute;
      payload[binding] = absolute;
    } else {
      payload[binding] = value;
    }
    mapped[binding] = payload[binding];
  };

  const handled = new Set([...requiredFields, ...optionalFields]);
  for (const binding of requiredFields) assign(binding, { required: true });
  for (const binding of optionalFields) assign(binding, { required: false });
  // File-only bindings that aren't also listed as payload fields.
  for (const binding of fileBindings) {
    if (!handled.has(binding)) assign(binding, { required: true });
  }

  if (missing.length || missingFiles.length) {
    const parts = [];
    if (missing.length) parts.push(`unmapped required payload fields: ${missing.join(', ')}`);
    if (missingFiles.length) parts.push(`unmapped/absent required files: ${missingFiles.join(', ')}`);
    throw new Error(`Cannot build Browsy payload — ${parts.join('; ')}. Map these via PANCAKE_BROWSY_BINDING_MAP or fix the release data.`);
  }

  if (Object.keys(files).length) payload.files = { ...(payload.files || {}), ...files };
  return { payload, files, mapped, fileBindings: [...fileBindings] };
}

/**
 * Assert the preview gate: status completed, no failed steps, and every required
 * expected output captured. Throws with a descriptive message otherwise.
 */
export function assertBrowsyPreviewPassed(result, contract = {}) {
  if (!result) throw new Error('Browsy preview returned no result.');
  if (result.status !== 'completed') {
    throw new Error(`Browsy preview did not complete (status=${result.status}${result.blockingReason ? `, reason=${result.blockingReason}` : ''}).`);
  }
  if (Array.isArray(result.failedSteps) && result.failedSteps.length) {
    throw new Error(`Browsy preview reported failed steps: ${result.failedSteps.map(stepName).join(', ')}.`);
  }
  const outputs = result.outputs || {};
  const missing = [];
  for (const expected of toNames(contract.expectedOutputs)) {
    const output = outputs[expected];
    const required = isRequiredOutput(contract.expectedOutputs, expected);
    if (!output || output.status !== 'captured') {
      if (required || !output) missing.push(`${expected}${output ? ` (status=${output.status})` : ''}`);
    }
  }
  // Also fail on any output the result itself marks required-but-not-captured.
  for (const [id, output] of Object.entries(outputs)) {
    if (output?.required && output.status !== 'captured' && !missing.includes(id)) {
      missing.push(`${id} (status=${output.status})`);
    }
  }
  if (missing.length) {
    throw new Error(`Browsy preview did not capture expected outputs: ${missing.join(', ')}.`);
  }
  return true;
}

/**
 * Run one Browsy stage end to end: start the run, poll, and (for live) resolve
 * approvable waiting states by approving. Human-only waiting states are surfaced,
 * never auto-approved. Returns a normalized stage result.
 */
export async function runBrowsyStage({
  client,
  workflowId,
  appId,
  version = '',
  mode,
  payload,
  options = undefined,
  approvalToken = '',
  approvedBy = 'pancake-robot',
  autoApprove = false,
  poll = {},
  onStatus = null,
} = {}) {
  const normalizedMode = normalizeContractMode(mode);
  const pollOptions = { ...DEFAULT_POLL, ...poll };
  const approvals = [];

  const start = await client.startRun({ workflowId, appId, version, mode: normalizedMode, payload, options, approvalToken });
  const runId = start.runId;

  let snapshot = await client.pollUntilDone(runId, { ...pollOptions, onStatus });

  // Resolve approvable waiting states (live submissions) automatically when allowed.
  while (snapshot.waiting && snapshot.autoApprovable && autoApprove && !snapshot.timedOut) {
    await client.approve(runId, { approvedBy, note: `Auto-approved ${snapshot.status} by ${approvedBy}.`, approvalToken });
    approvals.push({ status: snapshot.status, approvedBy });
    snapshot = await client.pollUntilDone(runId, { ...pollOptions, onStatus });
  }

  return normalizeStageResult({ runId, mode: normalizedMode, snapshot, start, approvals });
}

function normalizeStageResult({ runId, mode, snapshot, start, approvals }) {
  const status = snapshot.status;
  const classification = classifyBrowsyStatus(status);
  return {
    runId,
    mode,
    status,
    statusUrl: start.statusUrl || null,
    contractVersion: start.contractVersion || snapshot.result?.contractVersion || null,
    result: snapshot.result || null,
    run: snapshot.run || null,
    approvals,
    timedOut: Boolean(snapshot.timedOut),
    ...classification,
    // True when a human must intervene (auth/2fa/file/manual) — surface, don't approve.
    needsHumanAction: classification.needsHuman || (classification.waiting && !classification.autoApprovable),
  };
}

/**
 * Full release pipeline: dry_run pre-flight -> preview gate -> optional live.
 * Persists outputs/artifacts/runId for each real-browser stage onto the release.
 */
export async function runReleaseBrowsyPipeline({
  releaseType,
  releaseId,
  workflowId = '',
  version = '',
  stages = ['dry_run', 'preview'],
  approvalToken = '',
  approvedBy = 'pancake-robot',
  autoApproveSubmit = false,
  options = undefined,
  bindingMap = null,
  poll = {},
  persist = true,
  client = null,
  deps = defaultDeps,
} = {}) {
  const browsy = client || new BrowsyClient();
  const canonical = await deps.buildCanonicalPayload(releaseType, releaseId);
  const resolvedWorkflowId = String(workflowId || deps.resolveWorkflowId(releaseType, canonical)).trim();
  if (!resolvedWorkflowId) throw new Error('Could not resolve a Browsy workflowId for this release.');

  const contract = await browsy.getContract({ workflowId: resolvedWorkflowId, version });
  const supportedModes = toNames(contract.supportedModes);
  const map = bindingMap || deps.loadBindingMap();
  const { payload, mapped, fileBindings } = buildBrowsyPayloadFromContract({ contract, canonical, bindingMap: map });
  const trackIds = collectTrackIds(canonical);

  const runStages = [];
  for (const requested of stages) {
    const mode = normalizeContractMode(requested);
    if (supportedModes.length && !supportedModes.includes(mode)) {
      throw new Error(`Workflow ${resolvedWorkflowId} does not support mode "${mode}". Supported: ${supportedModes.join(', ')}.`);
    }
    if (mode === 'live' && !approvalToken) {
      throw new Error('Live Browsy submission requires an approvalToken (set BROWSY_APPROVAL_TOKEN or pass approvalToken).');
    }

    const stage = await runBrowsyStage({
      client: browsy,
      workflowId: resolvedWorkflowId,
      version,
      mode,
      payload,
      options,
      approvalToken: mode === 'live' ? approvalToken : '',
      approvedBy,
      autoApprove: mode === 'live' && autoApproveSubmit,
      poll,
    });

    // Pre-flight gate: dry_run must validate the package; preview must pass the
    // full gate (completed, no failed steps, expected outputs captured).
    if (mode === 'dry_run' && stage.status === 'failed') {
      throw new Error(`Browsy dry_run pre-flight failed${stage.result?.blockingReason ? `: ${stage.result.blockingReason}` : ''}.`);
    }
    if (mode === 'preview') {
      assertBrowsyPreviewPassed(stage.result, contract);
    }

    // Persist real-browser stages (preview/live) onto the release record.
    let artifacts = null;
    if (mode !== 'dry_run' && stage.runId) {
      artifacts = await safeGetArtifacts(browsy, stage.runId);
      if (persist) await deps.persistBrowsyRun({
        releaseType,
        releaseId,
        workflowId: resolvedWorkflowId,
        mode,
        runId: stage.runId,
        status: stage.status,
        result: stage.result,
        artifacts,
        trackIds,
      });
    }

    runStages.push({ ...stage, artifacts });

    // Stop early if a stage needs a human or did not reach a clean terminal state.
    if (stage.needsHumanAction) break;
    if (stage.status === 'failed' || stage.status === 'blocked' || stage.status === 'canceled') break;
  }

  const lastStage = runStages[runStages.length - 1] || null;
  return {
    ok: Boolean(lastStage && !lastStage.needsHumanAction && lastStage.status !== 'failed'),
    releaseType,
    releaseId,
    workflowId: resolvedWorkflowId,
    contractVersion: contract.contractVersion || null,
    supportedModes,
    payload,
    mappedBindings: mapped,
    fileBindings,
    stages: runStages,
    needsHuman: runStages.some(stage => stage.needsHumanAction),
    finalStatus: lastStage?.status || null,
  };
}

async function safeGetArtifacts(client, runId) {
  try {
    return await client.getArtifacts(runId);
  } catch {
    return null;
  }
}

// --- persistence -----------------------------------------------------------

/**
 * Persist a Browsy run's structured outputs, artifact paths and runId onto the
 * release record: maps URL outputs to release links, records the run on the
 * campaign run_summary, and writes a cockpit audit log entry.
 */
export function persistBrowsyRunToRelease({
  releaseType,
  releaseId,
  workflowId,
  mode,
  runId,
  status,
  result = {},
  artifacts = null,
  trackIds = [],
  db = defaultDb(),
} = {}) {
  const outputs = result?.outputs || {};
  const links = {};

  for (const [id, output] of Object.entries(outputs)) {
    const value = output?.value;
    if (!value || typeof value !== 'string') continue;
    const link = classifyOutputLink(id);
    if (link && isUrl(value)) {
      links[link.linkKey] = value;
      for (const trackId of trackIds) {
        try {
          db.upsertReleaseLink(trackId, link.platform, value);
        } catch { /* link table is best-effort */ }
      }
    }
  }

  const artifactPaths = flattenArtifacts(result?.artifacts, artifacts);
  const browsyRecord = {
    runId,
    mode,
    status,
    contractVersion: result?.contractVersion || null,
    completedSteps: result?.completedSteps || [],
    failedSteps: result?.failedSteps || [],
    outputs,
    artifacts: artifactPaths,
    links,
    persistedAt: new Date().toISOString(),
  };

  const campaign = safeCall(() => db.getReleaseCampaignByRelease(releaseType, releaseId));
  if (campaign) {
    const runSummary = { ...(campaign.run_summary || {}) };
    const browsyRuns = { ...(runSummary.browsy_runs || {}) };
    browsyRuns[`${workflowId}:${mode}`] = browsyRecord;
    runSummary.browsy_runs = browsyRuns;
    runSummary.last_browsy_run = browsyRecord;
    safeCall(() => db.upsertReleaseCampaign({ id: campaign.id, links: { ...(campaign.links || {}), ...links }, run_summary: runSummary }));
    safeCall(() => db.addReleaseCampaignRun({
      campaign_id: campaign.id,
      workflow_id: workflowId,
      run_id: runId,
      status: status === 'completed' ? 'complete' : status,
      log: browsyRecord,
    }));
  }

  safeCall(() => db.addReleaseCockpitLog({
    releaseType,
    releaseId,
    action: 'browsy_run',
    status: status === 'completed' ? 'success' : (status === 'failed' ? 'error' : 'info'),
    message: `Browsy ${mode} run ${runId} → ${status}.`,
    payload: browsyRecord,
  }));

  return browsyRecord;
}

function flattenArtifacts(resultArtifacts = {}, artifactsResponse = null) {
  const out = [];
  const groups = resultArtifacts || {};
  for (const role of Object.keys(groups)) {
    for (const item of groups[role] || []) {
      if (item?.path) out.push({ role, name: item.name || null, path: item.path, type: item.type || role });
    }
  }
  for (const item of artifactsResponse?.artifacts || []) {
    if (item?.path && !out.some(existing => existing.path === item.path)) {
      out.push({ role: item.role || item.type || 'artifact', name: item.name || null, path: item.path, type: item.type || null });
    }
  }
  return out;
}

function classifyOutputLink(id) {
  const key = normalizeKey(id);
  if (/(hyperfollow|smart_link|smartlink|presave|pre_save)/.test(key)) return { platform: 'HyperFollow', linkKey: 'hyperfollow_url' };
  if (/(distrokid|external_release|release_url)/.test(key)) return { platform: 'DistroKid', linkKey: 'distrokid_release_url' };
  if (/spotify/.test(key)) return { platform: 'Spotify', linkKey: 'spotify_url' };
  if (/apple/.test(key)) return { platform: 'Apple Music', linkKey: 'apple_music_url' };
  if (/youtube/.test(key)) return { platform: 'YouTube', linkKey: 'youtube_url' };
  return null;
}

function collectTrackIds(canonical = {}) {
  const ids = new Set();
  for (const track of canonical.tracks || []) {
    const id = String(track?.song_id || track?.songId || track?.id || '').trim();
    if (id) ids.add(id);
  }
  if (!ids.size && canonical.release_id) ids.add(String(canonical.release_id));
  return [...ids];
}

// --- default dependency wiring (lazy to keep the pure helpers DB-free) ------

let _db = null;
function defaultDb() {
  return _db;
}

const defaultDeps = {
  async buildCanonicalPayload(releaseType, releaseId) {
    const [{ buildReleaseCockpitViewModel }, { buildDistroKidPayloadFromCockpit }] = await Promise.all([
      import('./release-cockpit.js'),
      import('./distrokid-payload.js'),
    ]);
    const cockpit = buildReleaseCockpitViewModel(releaseType, releaseId);
    if (!cockpit) throw new Error(`Release not found for Browsy pipeline: ${releaseType}/${releaseId}`);
    return buildDistroKidPayloadFromCockpit(cockpit);
  },
  resolveWorkflowId(releaseType, canonical) {
    const type = String(canonical?.release_type || releaseType || '').toLowerCase();
    if (type === 'album') return process.env.BROWSY_DISTROKID_ALBUM_WORKFLOW || 'distrokid-album-submit';
    return process.env.BROWSY_DISTROKID_SINGLE_WORKFLOW || 'distrokid-single-submit';
  },
  loadBindingMap() {
    return loadBindingMapFromEnv();
  },
  async persistBrowsyRun(args) {
    const db = await import('./db.js');
    return persistBrowsyRunToRelease({ ...args, db });
  },
};

function loadBindingMapFromEnv(env = process.env) {
  const inline = String(env.PANCAKE_BROWSY_BINDING_MAP_JSON || '').trim();
  if (inline) {
    try { return JSON.parse(inline); } catch { /* ignore malformed inline map */ }
  }
  const file = String(env.PANCAKE_BROWSY_BINDING_MAP || '').trim();
  if (file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* ignore missing/malformed file */ }
  }
  return {};
}

// --- small utilities --------------------------------------------------------

function toNames(list) {
  if (!Array.isArray(list)) return [];
  return list.map(fieldName).filter(Boolean);
}

function fieldName(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') return String(entry.binding || entry.name || entry.id || entry.field || '').trim();
  return '';
}

function isRequiredOutput(list, id) {
  if (!Array.isArray(list)) return true;
  const entry = list.find(item => fieldName(item) === id);
  if (entry && typeof entry === 'object' && 'required' in entry) return Boolean(entry.required);
  return true;
}

function stepName(step) {
  if (typeof step === 'string') return step;
  if (step && typeof step === 'object') return String(step.name || step.id || step.step || 'step');
  return 'step';
}

function readPath(object, dotPath) {
  if (!object || !dotPath) return undefined;
  return String(dotPath).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

function ensureAbsolute(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function fileExists(filePath) {
  try {
    return Boolean(filePath) && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function safeCall(fn) {
  try { return fn(); } catch { return null; }
}
