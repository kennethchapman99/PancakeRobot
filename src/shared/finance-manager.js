import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const SONGS_DIR = path.join(OUTPUT_DIR, 'songs');
const RUNS_DIR = path.join(OUTPUT_DIR, 'runs');
const PRICING_PATH = process.env.PROVIDER_PRICING_PATH || path.join(ROOT_DIR, 'config/provider-pricing.json');
const COST_EVENT_VERSION = '1.0.0';
const LEGACY_UNTRUSTED_PRICING_SOURCES = new Set(['runs_table_precomputed']);
const ARTIFACT_SYNC_IN_PROGRESS = new Set();
const DEFAULT_MINIMAX_PAID_GENERATION_USD = 0.15;

export function loadProviderPricing(pricingPath = PRICING_PATH) {
  try {
    return JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
  } catch {
    return { version: 'missing', currency: 'USD', providers: {} };
  }
}

export function getFinanceDirForSong(songId) {
  return path.join(SONGS_DIR, songId, 'finance');
}

export function getFinanceDirForRun(runId) {
  return path.join(RUNS_DIR, runId, 'finance');
}

export function inferPipelineStep(agentName = '', operation = '') {
  const value = `${agentName} ${operation}`.toLowerCase();
  if (value.includes('lyric')) return 'lyrics_generation';
  if (value.includes('brand')) return 'brand_interpretation';
  if (value.includes('creative') || value.includes('thumbnail') || value.includes('image') || value.includes('art')) return 'album_art_assets';
  if (value.includes('release')) return 'release_selection';
  if (value.includes('marketing') || value.includes('outreach') || value.includes('social')) return 'marketing_assets';
  if (value.includes('music') || value.includes('minimax')) return 'music_generation';
  if (value.includes('master') || value.includes('mix')) return 'mastering';
  if (value.includes('research')) return 'research_ideation';
  return 'orchestration';
}

export function computeTokenCost({ provider, model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, reasoningTokens = 0, pricing = loadProviderPricing() }) {
  const providerCfg = pricing.providers?.[provider] || {};
  const modelCfg = providerCfg.models?.[model] || {};
  const inputRate = numberOrNull(modelCfg.input_usd_per_1m);
  const cachedInputRate = numberOrNull(modelCfg.cached_input_usd_per_1m);
  const outputRate = numberOrNull(modelCfg.output_usd_per_1m);
  const flatCallRate = numberOrNull(modelCfg.flat_usd_per_call);
  const unknown = [];
  let cost = 0;

  if (inputTokens && inputRate === null) unknown.push('input_usd_per_1m');
  else cost += (inputTokens / 1_000_000) * (inputRate || 0);

  if (cachedInputTokens && cachedInputRate === null) unknown.push('cached_input_usd_per_1m');
  else cost += (cachedInputTokens / 1_000_000) * (cachedInputRate || 0);

  const billedOutputTokens = outputTokens + reasoningTokens;
  if (billedOutputTokens && outputRate === null) unknown.push('output_usd_per_1m');
  else cost += (billedOutputTokens / 1_000_000) * (outputRate || 0);

  if (!inputTokens && !cachedInputTokens && !billedOutputTokens && flatCallRate !== null) cost += flatCallRate;

  return {
    costUsd: roundUsd(cost),
    pricingSource: pricing.version || 'unknown',
    inputRateUsdPer1m: inputRate,
    cachedInputRateUsdPer1m: cachedInputRate,
    outputRateUsdPer1m: outputRate,
    flatRateUsd: flatCallRate,
    pricingMissing: unknown,
  };
}

export function computeFlatGenerationCost({ provider, model, operation = 'generation', generationCount = 1, pricing = loadProviderPricing() }) {
  const providerCfg = pricing.providers?.[provider] || {};
  const modelCfg = providerCfg.models?.[model] || {};
  const flatGenerationRate = numberOrNull(modelCfg.flat_usd_per_generation);
  const flatCallRate = numberOrNull(modelCfg.flat_usd_per_call);
  const configuredRate = flatGenerationRate ?? flatCallRate;
  const fallbackRate = configuredRate === null ? getFlatGenerationCostFallback({ provider, model }) : null;
  const rate = configuredRate ?? fallbackRate;
  const pricingSource = fallbackRate !== null && configuredRate === null
    ? `${pricing.version || 'unknown'}+provider-default`
    : (pricing.version || 'unknown');

  return {
    costUsd: rate === null ? 0 : roundUsd(rate * Math.max(1, Number(generationCount) || 1)),
    pricingSource,
    flatRateUsd: rate,
    pricingMissing: rate === null ? [`flat_usd_per_${operation}`] : [],
  };
}

export function buildCostEvent(input = {}) {
  const pricing = input.pricing || loadProviderPricing();
  const provider = input.provider || 'unknown';
  const model = input.model || 'unknown';
  const unitType = input.unit_type || input.unitType || 'tokens';
  const status = input.status || 'success';
  const pipelineStep = input.pipeline_step || input.pipelineStep || inferPipelineStep(input.agent_name || input.agentName, input.operation);
  const computed = unitType === 'tokens'
    ? computeTokenCost({
      provider,
      model,
      inputTokens: input.input_tokens ?? input.inputTokens ?? 0,
      outputTokens: input.output_tokens ?? input.outputTokens ?? 0,
      cachedInputTokens: input.cached_input_tokens ?? input.cache_read_tokens ?? input.cachedInputTokens ?? input.cacheReadTokens ?? 0,
      reasoningTokens: input.reasoning_tokens ?? input.reasoningTokens ?? 0,
      pricing,
    })
    : computeFlatGenerationCost({
      provider,
      model,
      operation: input.operation || 'generation',
      generationCount: input.generation_count ?? input.generationCount ?? 1,
      pricing,
    });

  const hasPrecomputedCost = input.computed_cost_usd !== undefined || input.computedCostUsd !== undefined;
  const pricingMissing = hasPrecomputedCost ? [] : (computed.pricingMissing || []);
  const computedStatus = pricingMissing.length > 0 && status === 'success' ? 'estimated' : status;

  return compactObject({
    version: COST_EVENT_VERSION,
    id: input.id || `cost_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: input.timestamp || new Date().toISOString(),
    run_id: input.run_id || input.runId || null,
    song_id: input.song_id || input.songId || null,
    album_id: input.album_id || input.albumId || null,
    brand_id: input.brand_id || input.brandId || null,
    pipeline_step: pipelineStep,
    agent_name: input.agent_name || input.agentName || null,
    operation: input.operation || 'provider_call',
    provider,
    model,
    request_id: input.request_id || input.requestId || null,
    input_tokens: input.input_tokens ?? input.inputTokens ?? 0,
    cached_input_tokens: input.cached_input_tokens ?? input.cache_read_tokens ?? input.cachedInputTokens ?? input.cacheReadTokens ?? 0,
    output_tokens: input.output_tokens ?? input.outputTokens ?? 0,
    reasoning_tokens: input.reasoning_tokens ?? input.reasoningTokens ?? 0,
    total_tokens: input.total_tokens ?? input.totalTokens ?? undefined,
    image_count: input.image_count ?? input.imageCount ?? undefined,
    audio_seconds: input.audio_seconds ?? input.audioSeconds ?? undefined,
    video_seconds: input.video_seconds ?? input.videoSeconds ?? undefined,
    generation_count: input.generation_count ?? input.generationCount ?? undefined,
    unit_type: unitType,
    pricing_source: input.pricing_source || input.pricingSource || (hasPrecomputedCost ? 'precomputed' : computed.pricingSource),
    input_rate_usd_per_1m: computed.inputRateUsdPer1m,
    cached_input_rate_usd_per_1m: computed.cachedInputRateUsdPer1m,
    output_rate_usd_per_1m: computed.outputRateUsdPer1m,
    flat_rate_usd: computed.flatRateUsd,
    computed_cost_usd: roundUsd(hasPrecomputedCost ? (input.computed_cost_usd ?? input.computedCostUsd) : computed.costUsd),
    currency: pricing.currency || 'USD',
    status: computedStatus,
    retry_of_event_id: input.retry_of_event_id || input.retryOfEventId || null,
    pricing_missing: pricingMissing,
    notes: input.notes || null,
  });
}

export function recordCostEvent(input = {}) {
  const event = buildCostEvent(input);
  const targets = [];
  if (event.song_id) targets.push(getFinanceDirForSong(event.song_id));
  if (event.run_id) targets.push(getFinanceDirForRun(event.run_id));
  for (const dir of [...new Set(targets)]) {
    fs.mkdirSync(dir, { recursive: true });
    const eventsPath = path.join(dir, 'cost-events.jsonl');
    const existingEvents = readJsonl(eventsPath);
    if (!existingEvents.some(existing => existing.id === event.id)) fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  }
  if (event.song_id) writeSongFinanceSummary(event.song_id);
  if (event.run_id) writeRunFinanceSummary(event.run_id);
  return event;
}

export async function callWithCostTracking(options = {}) {
  const start = Date.now();
  try {
    const response = await options.callFn();
    const usage = extractUsage(response);
    recordCostEvent({
      ...options,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      status: 'success',
      notes: options.notes || `runtime_ms=${Date.now() - start}`,
    });
    return response;
  } catch (error) {
    recordCostEvent({
      ...options,
      status: options.failedBillable ? 'failed_billable' : 'failed_non_billable',
      notes: `${error.message}; runtime_ms=${Date.now() - start}`,
    });
    throw error;
  }
}

export async function syncSongFinanceFromRuns() {
  return {
    synced: 0,
    events: [],
    skipped: true,
    reason: 'Disabled: global runs table entries are not reliably attributable to individual songs. Use direct cost events written with PIPELINE_SONG_ID.',
  };
}

export function syncSongFinanceArtifacts(songId, { writeSummary = true } = {}) {
  if (!songId) return { synced: 0, events: [] };
  const events = [];
  const audioMetaPath = path.join(SONGS_DIR, songId, 'audio', 'generation-meta.json');
  ARTIFACT_SYNC_IN_PROGRESS.add(songId);
  try {
    if (fs.existsSync(audioMetaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(audioMetaPath, 'utf8'));
        const versions = Array.isArray(meta.versions) && meta.versions.length > 0 ? meta.versions : [{ model: meta.model, tier: meta.render_tier }];
        events.push(recordCostEvent({
          id: `cost_${songId}_minimax_${stableIdPart(meta.generated_at || meta.model || 'audio')}`,
          timestamp: meta.generated_at || new Date().toISOString(),
          songId,
          pipelineStep: 'music_generation',
          agentName: 'music-generator',
          operation: 'minimax_music_generation',
          provider: 'minimax',
          model: meta.model || versions[0]?.model || 'unknown',
          unitType: 'audio_generation',
          generationCount: versions.length,
          status: 'success',
          notes: `verified_from_audio_generation_meta; render_tier=${meta.render_tier || 'unknown'}`,
        }));
      } catch {}
    }
    if (writeSummary) writeSongFinanceSummary(songId);
    return { synced: events.length, events };
  } finally {
    ARTIFACT_SYNC_IN_PROGRESS.delete(songId);
  }
}

export function readCostEventsForSong(songId) {
  return readJsonl(path.join(getFinanceDirForSong(songId), 'cost-events.jsonl'));
}

export function readCostEventsForRun(runId) {
  return readJsonl(path.join(getFinanceDirForRun(runId), 'cost-events.jsonl'));
}

export function isTrustedCostEvent(event = {}) {
  if (LEGACY_UNTRUSTED_PRICING_SOURCES.has(event.pricing_source)) return false;
  if (String(event.notes || '').includes('synced_from_runs_table')) return false;
  return true;
}

export function summarizeCostEvents(events = []) {
  const trustedEvents = events.filter(isTrustedCostEvent);
  const ignoredLegacyEventCount = events.length - trustedEvents.length;
  const summary = {
    total_cost_usd: 0,
    total_final_asset_cost_usd: 0,
    total_failed_retry_cost_usd: 0,
    event_count: trustedEvents.length,
    raw_event_count: events.length,
    ignored_legacy_event_count: ignoredLegacyEventCount,
    estimated_event_count: 0,
    unknown_pricing_event_count: 0,
    by_pipeline_step: {},
    by_agent: {},
    by_provider: {},
    by_model: {},
    by_status: {},
    warnings: [],
    events: trustedEvents,
  };

  for (const event of trustedEvents) {
    const cost = Number(event.computed_cost_usd || 0);
    summary.total_cost_usd += cost;
    if (['failed_billable', 'estimated'].includes(event.status) || event.retry_of_event_id) summary.total_failed_retry_cost_usd += cost;
    else summary.total_final_asset_cost_usd += cost;
    if (event.status === 'estimated') summary.estimated_event_count += 1;
    if (event.pricing_missing?.length) summary.unknown_pricing_event_count += 1;
    addBucket(summary.by_pipeline_step, event.pipeline_step || 'unknown', cost, event);
    addBucket(summary.by_agent, event.agent_name || 'unknown', cost, event);
    addBucket(summary.by_provider, event.provider || 'unknown', cost, event);
    addBucket(summary.by_model, event.model || 'unknown', cost, event);
    addBucket(summary.by_status, event.status || 'unknown', cost, event);
  }

  summary.total_cost_usd = roundUsd(summary.total_cost_usd);
  summary.total_final_asset_cost_usd = roundUsd(summary.total_final_asset_cost_usd);
  summary.total_failed_retry_cost_usd = roundUsd(summary.total_failed_retry_cost_usd);
  if (ignoredLegacyEventCount > 0) summary.warnings.push(`${ignoredLegacyEventCount} legacy run-table backfill event(s) were ignored because they are not reliable song-level finance data.`);
  if (summary.estimated_event_count > 0) summary.warnings.push('Some costs are estimated because provider pricing is missing.');
  if (summary.total_failed_retry_cost_usd > 0) summary.warnings.push('Retries, failed billable calls, or unknown-priced events contributed to total incurred cost.');
  return summary;
}

export function getSongFinanceSummary(songId, { syncArtifacts = true } = {}) {
  if (syncArtifacts && songId && !ARTIFACT_SYNC_IN_PROGRESS.has(songId)) {
    syncSongFinanceArtifacts(songId, { writeSummary: false });
  }
  const summary = summarizeCostEvents(readCostEventsForSong(songId));
  summary.song_id = songId;
  summary.summary_path = path.join(getFinanceDirForSong(songId), 'cost-summary.json');
  return summary;
}

export function getRunFinanceSummary(runId) {
  const summary = summarizeCostEvents(readCostEventsForRun(runId));
  summary.run_id = runId;
  summary.summary_path = path.join(getFinanceDirForRun(runId), 'cost-summary.json');
  return summary;
}

export function writeSongFinanceSummary(songId) {
  const dir = getFinanceDirForSong(songId);
  fs.mkdirSync(dir, { recursive: true });
  const summary = getSongFinanceSummary(songId);
  fs.writeFileSync(path.join(dir, 'cost-summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

export function writeRunFinanceSummary(runId) {
  const dir = getFinanceDirForRun(runId);
  fs.mkdirSync(dir, { recursive: true });
  const summary = getRunFinanceSummary(runId);
  fs.writeFileSync(path.join(dir, 'cost-summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

export function getRecentFinanceOverview({ limit = 25 } = {}) {
  const songs = fs.existsSync(SONGS_DIR) ? fs.readdirSync(SONGS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
  const rows = songs.map(songId => getSongFinanceSummary(songId)).filter(summary => summary.event_count > 0).slice(0, limit);
  return { total_cost_usd: roundUsd(rows.reduce((sum, row) => sum + row.total_cost_usd, 0)), songs_with_costs: rows.length, rows };
}

export function getMissingPricingEntries(events = []) {
  const missing = new Map();
  for (const event of events.filter(isTrustedCostEvent)) {
    for (const key of event.pricing_missing || []) {
      const id = `${event.provider}:${event.model}:${key}`;
      missing.set(id, { provider: event.provider, model: event.model, missing_field: key, count: (missing.get(id)?.count || 0) + 1 });
    }
  }
  return [...missing.values()];
}

function addBucket(map, key, cost, event) {
  if (!map[key]) map[key] = { cost_usd: 0, count: 0 };
  map[key].cost_usd = roundUsd(map[key].cost_usd + cost);
  map[key].count += 1;
  if (event.pricing_missing?.length) map[key].has_unknown_pricing = true;
}

function extractUsage(response) {
  const usage = response?.usage || response?.message?.usage || response?.model_usage || {};
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0;
  const reasoningTokens = usage.reasoning_tokens ?? usage.reasoningTokens ?? 0;
  return { inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens: usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens + cachedInputTokens + reasoningTokens };
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getFlatGenerationCostFallback({ provider, model }) {
  const providerName = String(provider || '').toLowerCase();
  const modelName = String(model || '').toLowerCase();

  if (providerName === 'minimax' && modelName.includes('free')) return 0;
  if (providerName === 'minimax' && modelName === 'music-2.6') {
    return numberOrDefault(process.env.MINIMAX_MUSIC_GENERATION_COST_USD, DEFAULT_MINIMAX_PAID_GENERATION_USD);
  }
  return null;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundUsd(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function stableIdPart(value) {
  return String(value || 'unknown').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'unknown';
}
