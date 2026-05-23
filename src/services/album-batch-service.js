/**
 * Album Batch Service — "Generate Album" mode.
 *
 * Generates multiple songs from one shared orchestration pass. The shared
 * thinking (album plan + brand interpretation reuse) only happens once per
 * batch; each track then runs the per-song generator with the shared plan
 * as inherited context.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  createAlbum,
  updateAlbum,
  getAlbum,
  upsertSong,
  getSongForAlbumTrack,
  getSongsForAlbum,
} from '../shared/db.js';
import { SONG_STATUSES } from '../shared/song-status.js';
import {
  loadBrandProfileById,
  DEFAULT_PROFILE_ID,
} from '../shared/brand-profile.js';
import {
  ALBUM_PLAN_VERSION,
  generateAlbumPlan,
} from '../agents/album-orchestrator.js';
import {
  getCachedBrandInterpretation,
  makeBrandInterpretationSignature,
  setCachedBrandInterpretation,
} from '../shared/brand-interpretation-cache.js';
import {
  buildAlbumFinanceSummary,
  recordCostEvent,
  writeAlbumFinanceSummary,
} from '../shared/finance-manager.js';
import { runMagicPipelineService } from './magic-pipeline-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const ALBUMS_DIR = path.join(ROOT_DIR, 'output', 'albums');

export const ALBUM_COST_MODES = Object.freeze(['draft', 'standard', 'premium', 'album_batch']);

export function normalizeCostMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALBUM_COST_MODES.includes(normalized) ? normalized : 'standard';
}

export function createAlbumId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ALBUM_${ts}_${rand}`;
}

function createTrackSongId(albumId, trackNumber) {
  return `SONG_${albumId.replace(/^ALBUM_/, '')}_T${String(trackNumber).padStart(2, '0')}`;
}

/**
 * Run the "Generate Album" pipeline.
 *
 * Inputs (per the spec):
 *   - brandProfileId (required)
 *   - numberOfSongs (required)
 *   - costMode: one of draft|standard|premium|album_batch (default standard)
 *   - albumTheme, releaseIntent, notes: optional
 *
 * Hooks (test/injection):
 *   - planGenerator: replaces the shared album-orchestrator call.
 *   - trackPipeline: replaces the per-track song generator.
 *   - brandLoader: replaces the brand-profile loader.
 */
export async function runAlbumBatch({
  brandProfileId = DEFAULT_PROFILE_ID,
  numberOfSongs,
  costMode = 'standard',
  albumTheme = null,
  releaseIntent = null,
  notes = null,
  planGenerator = generateAlbumPlan,
  trackPipeline = defaultTrackPipeline,
  brandLoader = loadBrandProfileById,
  isTest = false,
  onEvent = null,
  logger = console,
} = {}) {
  const cleanBrandId = String(brandProfileId || DEFAULT_PROFILE_ID).trim();
  const requested = Math.max(1, Math.floor(Number(numberOfSongs) || 0));
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error('runAlbumBatch requires numberOfSongs >= 1');
  }
  const cleanCostMode = normalizeCostMode(costMode);

  const brandProfile = brandLoader(cleanBrandId);
  if (!brandProfile) throw new Error(`Brand profile not found: ${cleanBrandId}`);

  // Brand interpretation reuse: do not rerun interpretation per track.
  const brandSignature = makeBrandInterpretationSignature(brandProfile);
  let brandInterpretation = getCachedBrandInterpretation(cleanBrandId, brandSignature);
  let brandInterpretationFromCache = true;
  if (!brandInterpretation) {
    brandInterpretation = {
      brand_profile_id: cleanBrandId,
      signature: brandSignature,
      summary: {
        brand_name: brandProfile.brand_name,
        character_name: brandProfile.character?.name || null,
        music: brandProfile.music || null,
        songwriting: brandProfile.songwriting || null,
        audience: brandProfile.audience || null,
        lyrics: brandProfile.lyrics || null,
      },
    };
    setCachedBrandInterpretation(cleanBrandId, brandSignature, brandInterpretation);
    brandInterpretationFromCache = false;
  }

  // Persist the album record up-front so we can link tracks even on failure.
  const albumId = createAlbumId();
  createAlbum({
    id: albumId,
    brand_profile_id: cleanBrandId,
    album_title: null,
    album_theme: albumTheme || null,
    release_intent: releaseIntent || null,
    number_of_songs: requested,
    cost_mode: cleanCostMode,
    status: 'orchestrating',
    notes: notes || null,
    is_test: isTest,
  });
  fs.mkdirSync(path.join(ALBUMS_DIR, albumId), { recursive: true });

  await emit(onEvent, { type: 'album_progress', albumId, stage: 'orchestrating', line: 'Running shared album orchestration' });

  let plan;
  let orchestrationCostUsd = 0;
  const previousAlbumScope = process.env.PIPELINE_ALBUM_ID;
  process.env.PIPELINE_ALBUM_ID = albumId;
  try {
    const planResult = await planGenerator({
      brandProfile,
      numberOfSongs: requested,
      albumTheme,
      releaseIntent,
      notes,
    });
    plan = planResult.plan;
    orchestrationCostUsd = Number(planResult.costUsd) || 0;
  } catch (err) {
    updateAlbum(albumId, { status: 'failed', shared_orchestration: { error: err.message } });
    throw err;
  } finally {
    if (previousAlbumScope === undefined) delete process.env.PIPELINE_ALBUM_ID;
    else process.env.PIPELINE_ALBUM_ID = previousAlbumScope;
  }

  // Record a marker cost event so the album finance dir is always populated,
  // even when the plan-generator is a stub (e.g. in tests) that does not
  // record costs via managed-agent.
  recordCostEvent({
    id: `cost_${albumId}_orchestration_marker`,
    timestamp: new Date().toISOString(),
    albumId,
    pipelineStep: 'orchestration',
    agentName: 'album-orchestrator',
    operation: 'album_plan_generated',
    provider: 'anthropic',
    model: 'album-orchestrator',
    unitType: 'tokens',
    computedCostUsd: orchestrationCostUsd,
    pricingSource: 'album_batch_service',
    status: 'success',
    notes: `plan_version=${plan.plan_version}; tracks=${plan.tracks.length}; brand_interpretation_cached=${brandInterpretationFromCache}`,
  });

  updateAlbum(albumId, {
    album_title: plan.album_title,
    album_theme: plan.album_theme,
    release_intent: releaseIntent || plan.release_positioning,
    shared_orchestration: {
      plan_version: plan.plan_version,
      plan,
      brand_interpretation_from_cache: brandInterpretationFromCache,
      brand_signature: brandSignature,
      orchestration_cost_usd: orchestrationCostUsd,
    },
    status: 'generating_tracks',
  });

  const ensuredTracks = ensureAlbumTrackJobs({ albumId, album: getAlbum(albumId), plan, brandProfileId: cleanBrandId, isTest });
  const initialFinanceSummary = rebuildAndPersistAlbumFinanceSummary({
    albumId,
    costMode: cleanCostMode,
    trackSongIds: ensuredTracks.map(row => row.id),
    cachedSavingsUsd: brandInterpretationFromCache ? estimateBrandInterpretationSavings(plan.tracks.length) : 0,
  });
  updateAlbum(albumId, { finance_summary: initialFinanceSummary });

  await emit(onEvent, {
    type: 'album_plan_ready',
    albumId,
    plan,
    brandInterpretationFromCache,
  });

  // Track-by-track generation. Partial failures are recorded and surfaced;
  // they do not abort the batch.
  const trackResults = [];
  for (const track of plan.tracks) {
    const songId = getSongForAlbumTrack(albumId, track.track_number)?.id || createTrackSongId(albumId, track.track_number);

    await emit(onEvent, { type: 'track_started', albumId, songId, track });

    try {
      const trackResult = await trackPipeline({
        songId,
        albumId,
        brandProfileId: cleanBrandId,
        brandInterpretation,
        plan,
        track,
        costMode: cleanCostMode,
        onEvent,
        logger,
        isTest,
      });
      upsertSong({
        id: songId,
        status: SONG_STATUSES.DRAFT,
        pipeline_stage: trackResult?.pipelineStage || 'album_track_generated',
        total_cost_usd: Number(trackResult?.totalCost) || 0,
      });
      trackResults.push({
        status: 'success',
        songId,
        trackNumber: track.track_number,
        title: trackResult?.title || track.title,
        totalCost: Number(trackResult?.totalCost) || 0,
      });
      await emit(onEvent, { type: 'track_succeeded', albumId, songId, track });
    } catch (err) {
      upsertSong({
        id: songId,
        status: SONG_STATUSES.DRAFT,
        pipeline_stage: 'album_track_failed',
        notes: `Album track generation failed: ${err.message}`,
      });
      trackResults.push({
        status: 'failed',
        songId,
        trackNumber: track.track_number,
        title: track.title,
        error: err.message,
      });
      await emit(onEvent, { type: 'track_failed', albumId, songId, track, error: err.message });
    }
  }

  const succeeded = trackResults.filter(t => t.status === 'success');
  const failed = trackResults.filter(t => t.status === 'failed');
  const finalStatus = failed.length === 0
    ? 'completed'
    : (succeeded.length > 0 ? 'completed_with_failures' : 'failed');

  const financeSummary = buildAlbumFinanceSummary({
    albumId,
    costMode: cleanCostMode,
    trackSongIds: getSongsForAlbum(albumId).map(song => song.id),
    cachedSavingsUsd: brandInterpretationFromCache ? estimateBrandInterpretationSavings(plan.tracks.length) : 0,
  });
  writeAlbumFinanceSummary(albumId, financeSummary);

  updateAlbum(albumId, {
    status: finalStatus,
    finance_summary: financeSummary,
  });

  await emit(onEvent, {
    type: 'album_complete',
    albumId,
    status: finalStatus,
    succeeded,
    failed,
    financeSummary,
  });

  return {
    albumId,
    status: finalStatus,
    plan,
    tracks: trackResults,
    succeeded,
    failed,
    financeSummary,
    brandInterpretationFromCache,
  };
}

export async function repairAlbumBatch({
  albumId,
  brandLoader = loadBrandProfileById,
  onEvent = null,
} = {}) {
  const cleanAlbumId = String(albumId || '').trim();
  if (!cleanAlbumId) throw new Error('repairAlbumBatch requires albumId');

  const album = getAlbum(cleanAlbumId);
  if (!album) throw new Error(`Album not found: ${cleanAlbumId}`);
  const plan = loadSavedAlbumPlan(album);
  const brandProfileId = album.brand_profile_id || DEFAULT_PROFILE_ID;
  const brandProfile = brandLoader(brandProfileId);
  if (!brandProfile) throw new Error(`Brand profile not found: ${brandProfileId}`);

  const songsBefore = getSongsForAlbum(cleanAlbumId);
  await emit(onEvent, { type: 'album_repair_started', albumId: cleanAlbumId, stage: 'repair', line: 'Loading saved album plan' });
  updateAlbumLatestEvent(cleanAlbumId, { type: 'album_repair_started', message: 'Loading saved album plan' });

  const ensuredTracks = ensureAlbumTrackJobs({
    albumId: cleanAlbumId,
    album,
    plan,
    brandProfileId,
    isTest: album.is_test,
  });
  const beforeResumeSummary = rebuildAndPersistAlbumFinanceSummary({
    albumId: cleanAlbumId,
    costMode: album.cost_mode,
    trackSongIds: ensuredTracks.map(row => row.id),
  });
  updateAlbum(cleanAlbumId, {
    status: 'generating_tracks',
    finance_summary: beforeResumeSummary,
  });

  await emit(onEvent, {
    type: 'album_repair_materialized_tracks',
    albumId: cleanAlbumId,
    stage: 'repair',
    line: `Ensured ${ensuredTracks.length} planned track jobs`,
  });
  updateAlbumLatestEvent(cleanAlbumId, { type: 'album_repair_materialized_tracks', message: `Ensured ${ensuredTracks.length} planned track jobs` });

  const incomplete = getIncompleteAlbumTracks(cleanAlbumId, plan);
  const created = ensuredTracks.filter(song => !songsBefore.some(existing => existing.id === song.id));
  return {
    albumId: cleanAlbumId,
    status: 'repaired',
    currentAlbumStatus: getAlbum(cleanAlbumId)?.status || 'unknown',
    plan,
    ensured: ensuredTracks,
    existingTracks: songsBefore.length,
    created,
    createdTracks: created.length,
    incomplete,
    skipped: ensuredTracks.filter(song => !incomplete.some(item => item.song.id === song.id)),
    financeSummary: beforeResumeSummary,
    latestError: getAlbum(cleanAlbumId)?.shared_orchestration?.latest_error || null,
  };
}

export async function resumeAlbumBatch({
  albumId,
  trackPipeline = defaultTrackPipeline,
  brandLoader = loadBrandProfileById,
  onEvent = null,
  logger = console,
} = {}) {
  const cleanAlbumId = String(albumId || '').trim();
  if (!cleanAlbumId) throw new Error('resumeAlbumBatch requires albumId');

  const repairResult = await repairAlbumBatch({
    albumId: cleanAlbumId,
    brandLoader,
    onEvent,
  });

  const album = getAlbum(cleanAlbumId);
  if (!album) throw new Error(`Album not found: ${cleanAlbumId}`);
  const plan = loadSavedAlbumPlan(album);
  const brandProfileId = album.brand_profile_id || DEFAULT_PROFILE_ID;
  const brandProfile = brandLoader(brandProfileId);
  if (!brandProfile) throw new Error(`Brand profile not found: ${brandProfileId}`);

  const brandInterpretation = buildRepairBrandInterpretation({ album, brandProfile, brandProfileId });
  const trackResults = [];
  const next = getIncompleteAlbumTracks(cleanAlbumId, plan)[0] || null;
  let generationStarted = false;

  if (next) {
    const { track, song } = next;
    await emit(onEvent, { type: 'track_resumed', albumId: cleanAlbumId, songId: song.id, track });
    updateAlbumLatestEvent(cleanAlbumId, { type: 'track_resumed', message: `Resuming track ${track.track_number}: ${track.title}` });
    try {
      generationStarted = true;
      const trackResult = await trackPipeline({
        songId: song.id,
        albumId: cleanAlbumId,
        brandProfileId,
        brandInterpretation,
        plan,
        track,
        costMode: album.cost_mode,
        onEvent,
        logger,
        isTest: album.is_test,
      });
      upsertSong({
        id: song.id,
        status: SONG_STATUSES.DRAFT,
        pipeline_stage: trackResult?.pipelineStage || 'album_track_generated',
        total_cost_usd: Number(trackResult?.totalCost) || 0,
      });
      trackResults.push({ status: 'success', songId: song.id, trackNumber: track.track_number, title: trackResult?.title || track.title });
      updateAlbumLatestEvent(cleanAlbumId, { type: 'track_succeeded', message: `Track ${track.track_number} completed: ${track.title}`, clear_error: true });
      await emit(onEvent, { type: 'track_succeeded', albumId: cleanAlbumId, songId: song.id, track });
    } catch (err) {
      upsertSong({
        id: song.id,
        status: SONG_STATUSES.DRAFT,
        pipeline_stage: 'album_track_failed',
        notes: `Album track generation failed: ${err.message}`,
      });
      trackResults.push({ status: 'failed', songId: song.id, trackNumber: track.track_number, title: track.title, error: err.message });
      updateAlbumLatestEvent(cleanAlbumId, { type: 'track_failed', message: `Track ${track.track_number} failed: ${err.message}`, error: err.message });
      await emit(onEvent, { type: 'track_failed', albumId: cleanAlbumId, songId: song.id, track, error: err.message });
    }
  }

  const songs = getSongsForAlbum(cleanAlbumId);
  const stillIncomplete = getIncompleteAlbumTracks(cleanAlbumId, plan);
  const failed = songs.filter(song => song.pipeline_stage === 'album_track_failed');
  const completed = songs.filter(isCompletedAlbumTrack);
  const finalStatus = stillIncomplete.length === 0 && failed.length === 0
    ? 'completed'
    : (failed.length > 0 && completed.length === 0 ? 'failed' : (failed.length > 0 ? 'completed_with_failures' : 'generating_tracks'));
  const financeSummary = rebuildAndPersistAlbumFinanceSummary({
    albumId: cleanAlbumId,
    costMode: album.cost_mode,
    trackSongIds: songs.map(song => song.id),
  });
  const nextAfterResume = getIncompleteAlbumTracks(cleanAlbumId, plan)[0] || null;

  updateAlbum(cleanAlbumId, {
    status: finalStatus,
    finance_summary: financeSummary,
  });
  updateAlbumLatestEvent(cleanAlbumId, { type: 'album_resume_complete', message: `Resume complete with status ${finalStatus}` });
  await emit(onEvent, { type: 'album_resume_complete', albumId: cleanAlbumId, status: finalStatus, results: trackResults, financeSummary });

  return {
    albumId: cleanAlbumId,
    status: finalStatus,
    plan,
    repair: repairResult,
    ensured: songs,
    resumed: trackResults,
    skipped: songs.filter(song => !trackResults.some(result => result.songId === song.id)),
    financeSummary,
    generationStarted,
    nextTrack: nextAfterResume ? nextAfterResume.track : null,
    latestError: getAlbum(cleanAlbumId)?.shared_orchestration?.latest_error || null,
  };
}

async function defaultTrackPipeline({
  songId,
  albumId,
  brandProfileId,
  brandInterpretation,
  plan,
  track,
  costMode,
  onEvent,
  logger,
}) {
  // Build a track topic that already encodes the shared album plan so the
  // per-song lyricist does not need to re-derive brand interpretation or
  // album-level intent. The standard magic pipeline runs in SONG_ONLY mode,
  // which skips advisory scoring entirely — that is intentional: scoring is
  // subjective and we do not want to hard-block any track based on it.
  const inheritedContext = formatInheritedAlbumContext({ plan, track, brandInterpretation });
  const topic = `${track.title} — ${track.concept}\n\nALBUM CONTEXT (inherited from album plan ${plan.plan_version}, do not rerun):\n${inheritedContext}`;

  const previousAlbumScope = process.env.PIPELINE_ALBUM_ID;
  delete process.env.PIPELINE_ALBUM_ID; // per-track costs go to song, not album-shared
  try {
    const result = await runMagicPipelineService({
      topic,
      existingSongId: songId,
      brandId: brandProfileId,
      pipelineStage: 'song_only',
      onEvent,
      logger,
    });
    return {
      title: result?.title || track.title,
      totalCost: result?.totalCost || 0,
      pipelineStage: 'album_track_generated',
    };
  } finally {
    if (previousAlbumScope === undefined) delete process.env.PIPELINE_ALBUM_ID;
    else process.env.PIPELINE_ALBUM_ID = previousAlbumScope;
  }
}

function formatInheritedAlbumContext({ plan, track }) {
  return [
    `Album title: ${plan.album_title}`,
    `Album theme: ${plan.album_theme}`,
    `Release positioning: ${plan.release_positioning}`,
    `Sonic palette: ${plan.sonic_palette}`,
    `Lyrical rules: ${plan.lyrical_rules.join(' | ')}`,
    `Track number: ${track.track_number} of ${plan.track_count}`,
    `Emotional role: ${track.emotional_role}`,
    `Music style direction: ${track.music_style_prompt}`,
    `Lyric direction: ${track.lyric_direction}`,
    `Provider prompt seed: ${track.provider_prompt_seed}`,
  ].join('\n');
}

function estimateBrandInterpretationSavings(trackCount) {
  // Rough avoided-cost figure: each track would otherwise re-pay an
  // interpretation pass roughly the size of a brand-manager call.
  const PER_TRACK_AVOIDED_USD = 0.05;
  return Math.max(0, trackCount * PER_TRACK_AVOIDED_USD);
}

export function loadSavedAlbumPlan(albumOrId) {
  const album = typeof albumOrId === 'string' ? getAlbum(albumOrId) : albumOrId;
  const plan = album?.shared_orchestration?.plan;
  if (!plan || !Array.isArray(plan.tracks) || plan.tracks.length === 0) {
    throw new Error(`Album plan is missing for ${album?.id || albumOrId}`);
  }
  return plan;
}

export function ensureAlbumTrackJobs({ albumId, album = null, plan = null, brandProfileId = null, isTest = false } = {}) {
  const resolvedAlbum = album || getAlbum(albumId);
  if (!resolvedAlbum) throw new Error(`Album not found: ${albumId}`);
  const resolvedPlan = plan || loadSavedAlbumPlan(resolvedAlbum);
  const resolvedBrandProfileId = brandProfileId || resolvedAlbum.brand_profile_id || DEFAULT_PROFILE_ID;
  const ensured = [];
  for (const track of resolvedPlan.tracks) {
    const trackNumber = Number(track.track_number);
    const existing = getSongForAlbumTrack(albumId, trackNumber);
    const songId = existing?.id || createTrackSongId(albumId, trackNumber);
    upsertSong({
      id: songId,
      topic: existing?.topic || track.title,
      title: existing?.title || track.title,
      concept: existing?.concept || track.concept,
      status: existing?.status || SONG_STATUSES.DRAFT,
      brand_profile_id: existing?.brand_profile_id || resolvedBrandProfileId,
      album_id: albumId,
      track_number: trackNumber,
      album_role: existing?.album_role || track.emotional_role,
      inherited_album_plan_version: existing?.inherited_album_plan_version || resolvedPlan.plan_version || ALBUM_PLAN_VERSION,
      is_test: isTest || resolvedAlbum.is_test,
    });
    ensured.push(getSongForAlbumTrack(albumId, trackNumber));
  }
  return ensured;
}

export function getIncompleteAlbumTracks(albumId, plan = null) {
  const resolvedPlan = plan || loadSavedAlbumPlan(albumId);
  return resolvedPlan.tracks
    .map(track => ({ track, song: getSongForAlbumTrack(albumId, track.track_number) }))
    .filter(({ song }) => !isCompletedAlbumTrack(song));
}

export function isCompletedAlbumTrack(song) {
  return song?.pipeline_stage === 'album_track_generated';
}

function rebuildAndPersistAlbumFinanceSummary({ albumId, costMode, trackSongIds, cachedSavingsUsd = 0 }) {
  const financeSummary = buildAlbumFinanceSummary({ albumId, costMode, trackSongIds, cachedSavingsUsd });
  writeAlbumFinanceSummary(albumId, financeSummary);
  return financeSummary;
}

function buildRepairBrandInterpretation({ album, brandProfile, brandProfileId }) {
  return {
    brand_profile_id: brandProfileId,
    signature: album.shared_orchestration?.brand_signature || makeBrandInterpretationSignature(brandProfile),
    summary: {
      brand_name: brandProfile.brand_name,
      character_name: brandProfile.character?.name || null,
      music: brandProfile.music || null,
      songwriting: brandProfile.songwriting || null,
      audience: brandProfile.audience || null,
      lyrics: brandProfile.lyrics || null,
    },
  };
}

function updateAlbumLatestEvent(albumId, event) {
  const album = getAlbum(albumId);
  if (!album) return;
  const latestError = event.error || (event.clear_error ? null : album.shared_orchestration?.latest_error || null);
  const persistedEvent = { ...event };
  delete persistedEvent.clear_error;
  updateAlbum(albumId, {
    shared_orchestration: {
      ...album.shared_orchestration,
      latest_event: {
        timestamp: new Date().toISOString(),
        ...persistedEvent,
      },
      latest_error: latestError,
    },
  });
}

async function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try {
    await onEvent({ timestamp: new Date().toISOString(), ...event });
  } catch {
    // emit must never sink the pipeline.
  }
}

export function getAlbumSummary(albumId) {
  let album = getAlbum(albumId);
  if (!album) return null;
  const songs = getSongsForAlbum(albumId);
  const financeSummary = rebuildAndPersistAlbumFinanceSummary({
    albumId,
    costMode: album.cost_mode,
    trackSongIds: songs.map(song => song.id),
  });
  if (JSON.stringify(album.finance_summary || {}) !== JSON.stringify(financeSummary)) {
    updateAlbum(albumId, { finance_summary: financeSummary });
    album = getAlbum(albumId);
  }
  return {
    album,
    songs,
  };
}
