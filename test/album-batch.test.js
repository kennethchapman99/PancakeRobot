import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-album-batch').slug;

const albumOutputIds = new Set();
const songOutputIds = new Set();

test.after(() => {
  cleanupTestOutputArtifacts({
    albumIds: [...albumOutputIds],
    songIds: [...songOutputIds],
  });
});

const {
  runAlbumBatch,
  repairAlbumBatch,
  resumeAlbumBatch,
  ensureAlbumTrackJobs,
  normalizeCostMode,
  ALBUM_COST_MODES,
} = await import('../src/services/album-batch-service.js');
const {
  createAlbum,
  getAlbum,
  getSongsForAlbum,
  getAllAlbums,
  updateAlbum,
  upsertSong,
  getSong,
} = await import('../src/shared/db.js');
const {
  clearBrandInterpretationCache,
} = await import('../src/shared/brand-interpretation-cache.js');
const {
  recordCostEvent,
  buildAlbumFinanceSummary,
  COST_MODE_BUDGETS,
  getFinanceDirForAlbum,
  getFinanceDirForSong,
} = await import('../src/shared/finance-manager.js');
const {
  validateAlbumPlan,
  normalizeAlbumPlan,
  generateAlbumPlan,
} = await import('../src/agents/album-orchestrator.js');
const {
  runMagicPipelineService,
} = await import('../src/services/magic-pipeline-service.js');

const FAKE_BRAND = {
  brand_name: 'Test Brand',
  app_title: 'Test',
  character: { name: 'Testy' },
  music: { default_style: 'pop', default_bpm: 120 },
  songwriting: { song_type: 'pop' },
  audience: { age_range: '5-10', guardrail: 'G' },
  lyrics: { title_examples: ['Hi'], required_closing: 'bye' },
  distribution: { default_distributor: 'TestDistro' },
  ui: {},
};

function fakeBrandLoader() {
  return FAKE_BRAND;
}

function buildPlanGenerator({ recordedCalls } = {}) {
  return async function fakePlanGenerator({ brandProfile, numberOfSongs, albumTheme }) {
    if (recordedCalls) recordedCalls.push({ brandProfile: brandProfile.brand_name, numberOfSongs, albumTheme });
    const plan = normalizeAlbumPlan({
      album_title: albumTheme ? `${albumTheme} (album)` : `${brandProfile.brand_name} Test Album`,
      album_theme: albumTheme || 'inferred-from-brand',
      release_positioning: 'test release',
      sonic_palette: 'test palette',
      lyrical_rules: ['rule one', 'rule two'],
      track_count: numberOfSongs,
      tracks: Array.from({ length: numberOfSongs }, (_, idx) => ({
        track_number: idx + 1,
        title: `Track ${idx + 1}`,
        concept: `Concept for ${idx + 1}`,
        emotional_role: idx === 0 ? 'opener' : 'middle',
        music_style_prompt: 'pop bouncy',
        lyric_direction: 'kid-friendly',
        provider_prompt_seed: 'seed',
      })),
    }, numberOfSongs);
    return { plan, costUsd: 0.05, runId: 'fake-run' };
  };
}

function makeTrackPipeline({ failOnTrack = null, costPerTrack = 0.02, recordedTracks } = {}) {
  return async function fakeTrackPipeline({ songId, albumId, track, plan }) {
    albumOutputIds.add(albumId);
    songOutputIds.add(songId);
    if (recordedTracks) recordedTracks.push({ songId, albumId, track_number: track.track_number });
    if (failOnTrack !== null && track.track_number === failOnTrack) {
      throw new Error(`Synthetic failure on track ${failOnTrack}`);
    }
    // Record a per-song cost event so the album finance summary can pick it up.
    recordCostEvent({
      id: `cost_${songId}_synthetic`,
      timestamp: new Date().toISOString(),
      songId,
      pipelineStep: 'music_generation',
      agentName: 'fake-music',
      operation: 'fake_generate',
      provider: 'minimax',
      model: 'music-2.6',
      unitType: 'audio_generation',
      computedCostUsd: costPerTrack,
      pricingSource: 'test',
      status: 'success',
    });
    return { title: track.title, totalCost: costPerTrack, pipelineStage: 'album_track_generated' };
  };
}

test('normalizeCostMode normalizes accepted modes and falls back to standard', () => {
  for (const mode of ALBUM_COST_MODES) {
    assert.equal(normalizeCostMode(mode), mode);
    assert.equal(normalizeCostMode(mode.toUpperCase()), mode);
  }
  assert.equal(normalizeCostMode('bogus'), 'standard');
  assert.equal(normalizeCostMode(''), 'standard');
});

test('validateAlbumPlan catches missing fields and wrong track counts', () => {
  assert.ok(validateAlbumPlan({}, 2).length > 0);
  const bad = normalizeAlbumPlan({
    album_title: 'a',
    album_theme: 'b',
    release_positioning: 'c',
    sonic_palette: 'd',
    lyrical_rules: [],
    track_count: 2,
    tracks: [{ title: '1', concept: '1', emotional_role: 'x', music_style_prompt: 'p', lyric_direction: 'l', provider_prompt_seed: 's' }],
  }, 1);
  // Only one track was kept; asking for 2 should now report the mismatch.
  assert.ok(validateAlbumPlan(bad, 2).length > 0);
});

test('TEST 1+2: user can create album batch with brand + count only, or with explicit theme', async () => {
  clearBrandInterpretationCache();
  const callsNoTheme = [];
  const callsTheme = [];

  const result1 = await runAlbumBatch({
    brandProfileId: 'test',
    numberOfSongs: 3,
    planGenerator: buildPlanGenerator({ recordedCalls: callsNoTheme }),
    trackPipeline: makeTrackPipeline(),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  assert.equal(result1.status, 'completed');
  assert.equal(result1.tracks.length, 3);
  assert.equal(callsNoTheme[0].albumTheme, null);
  // Inferred theme is non-empty.
  assert.ok(result1.plan.album_theme && result1.plan.album_theme.length > 0);

  const result2 = await runAlbumBatch({
    brandProfileId: 'test',
    numberOfSongs: 2,
    albumTheme: 'Ocean Friends',
    planGenerator: buildPlanGenerator({ recordedCalls: callsTheme }),
    trackPipeline: makeTrackPipeline(),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  assert.equal(result2.status, 'completed');
  assert.equal(callsTheme[0].albumTheme, 'Ocean Friends');
  assert.equal(result2.plan.album_theme, 'Ocean Friends');
});

test('TEST 3: album orchestration runs exactly once per batch', async () => {
  clearBrandInterpretationCache();
  const calls = [];
  const result = await runAlbumBatch({
    brandProfileId: 'test',
    numberOfSongs: 5,
    planGenerator: buildPlanGenerator({ recordedCalls: calls }),
    trackPipeline: makeTrackPipeline(),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  assert.equal(calls.length, 1, 'plan generator must run exactly once');
  assert.equal(result.tracks.length, 5);
});

test('TEST 4: brand interpretation is cached and reused across batches', async () => {
  clearBrandInterpretationCache();
  const first = await runAlbumBatch({
    brandProfileId: 'cache-brand',
    numberOfSongs: 2,
    planGenerator: buildPlanGenerator(),
    trackPipeline: makeTrackPipeline(),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  assert.equal(first.brandInterpretationFromCache, false);
  const second = await runAlbumBatch({
    brandProfileId: 'cache-brand',
    numberOfSongs: 2,
    planGenerator: buildPlanGenerator(),
    trackPipeline: makeTrackPipeline(),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  assert.equal(second.brandInterpretationFromCache, true);
  assert.ok(second.financeSummary.cached_savings_usd > 0);
});

test('TEST 5: generated songs are linked to album_id and have track numbers', async () => {
  clearBrandInterpretationCache();
  const result = await runAlbumBatch({
    brandProfileId: 'link-brand',
    numberOfSongs: 4,
    planGenerator: buildPlanGenerator(),
    trackPipeline: makeTrackPipeline(),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  const songs = getSongsForAlbum(result.albumId);
  assert.equal(songs.length, 4);
  for (const song of songs) {
    assert.equal(song.album_id, result.albumId);
    assert.ok(Number.isInteger(song.track_number) && song.track_number >= 1);
    assert.ok(song.album_role);
    assert.ok(song.inherited_album_plan_version);
  }
  const album = getAlbum(result.albumId);
  assert.equal(album.status, 'completed');
  assert.equal(album.cost_mode, 'standard');
});

test('TEST 6+7+8: finance manager amortizes shared cost, total = shared + per-track, average is correct', async () => {
  clearBrandInterpretationCache();
  const result = await runAlbumBatch({
    brandProfileId: 'finance-brand',
    numberOfSongs: 4,
    costMode: 'album_batch',
    planGenerator: buildPlanGenerator(),
    trackPipeline: makeTrackPipeline({ costPerTrack: 0.10 }),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  // Record a fake shared album-level event so shared_thinking_cost > 0.
  recordCostEvent({
    id: `cost_${result.albumId}_shared_test`,
    albumId: result.albumId,
    pipelineStep: 'orchestration',
    agentName: 'album-orchestrator',
    operation: 'shared_call',
    provider: 'anthropic',
    model: 'claude',
    unitType: 'tokens',
    computedCostUsd: 0.20,
    pricingSource: 'test',
    status: 'success',
  });
  // Re-build summary now that the shared event is present.
  const summary = buildAlbumFinanceSummary({
    albumId: result.albumId,
    costMode: 'album_batch',
    trackSongIds: result.succeeded.map(t => t.songId),
  });

  assert.equal(summary.track_count, 4);
  // Shared thinking includes both the synthetic event and the marker.
  assert.ok(summary.shared_thinking_cost_usd >= 0.20);
  // Per-track total = 4 * 0.10
  assert.ok(Math.abs(summary.per_track_total_cost_usd - 0.40) < 1e-6);
  // Total = shared + per-track
  const expectedTotal = summary.shared_thinking_cost_usd + summary.per_track_total_cost_usd;
  assert.ok(Math.abs(summary.total_album_cost_usd - expectedTotal) < 1e-6);
  // Average = total / count
  assert.ok(Math.abs(summary.average_cost_per_song_usd - summary.total_album_cost_usd / 4) < 1e-6);
  // Allocated shared per song
  assert.ok(Math.abs(summary.allocated_shared_cost_per_song_usd - summary.shared_thinking_cost_usd / 4) < 1e-6);
  // Each per-track row carries the allocated shared cost
  for (const row of summary.per_track) {
    assert.equal(row.allocated_shared_cost_usd, summary.allocated_shared_cost_per_song_usd);
    assert.ok(Math.abs(row.total_attributed_cost_usd - (row.track_cost_usd + row.allocated_shared_cost_usd)) < 1e-6);
  }
  // Cost mode budget is reflected
  assert.equal(summary.cost_mode_budget.per_song_usd, COST_MODE_BUDGETS.album_batch);
});

test('TEST 9: existing single-song generation is not broken (runMagicPipelineService stays importable and validates input)', async () => {
  await assert.rejects(
    () => runMagicPipelineService({ topic: '' }),
    /Magic pipeline requires a topic/
  );
});

test('TEST 10: album batch can partially succeed and clearly shows failed tracks', async () => {
  clearBrandInterpretationCache();
  const result = await runAlbumBatch({
    brandProfileId: 'partial-brand',
    numberOfSongs: 3,
    planGenerator: buildPlanGenerator(),
    trackPipeline: makeTrackPipeline({ failOnTrack: 2 }),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  assert.equal(result.status, 'completed_with_failures');
  assert.equal(result.succeeded.length, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].trackNumber, 2);
  assert.match(result.failed[0].error, /Synthetic failure/);

  // Failed song record exists and is labeled as failed.
  const failedSong = getSong(result.failed[0].songId);
  assert.ok(failedSong);
  assert.equal(failedSong.pipeline_stage, 'album_track_failed');
  assert.ok(failedSong.notes && failedSong.notes.includes('Album track generation failed'));
});

test('Finance directories are created under output/albums/<id>/finance', async () => {
  clearBrandInterpretationCache();
  const result = await runAlbumBatch({
    brandProfileId: 'fs-brand',
    numberOfSongs: 1,
    planGenerator: buildPlanGenerator(),
    trackPipeline: makeTrackPipeline(),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  const albumFinanceDir = getFinanceDirForAlbum(result.albumId);
  assert.ok(fs.existsSync(albumFinanceDir));
  const summaryPath = path.join(albumFinanceDir, 'cost-summary.json');
  assert.ok(fs.existsSync(summaryPath));
  // And the song finance dir was populated by the synthetic track pipeline.
  const songFinanceDir = getFinanceDirForSong(result.succeeded[0].songId);
  assert.ok(fs.existsSync(path.join(songFinanceDir, 'cost-events.jsonl')));
});

test('getAllAlbums returns persisted albums (excluding test rows by default)', async () => {
  clearBrandInterpretationCache();
  const result = await runAlbumBatch({
    brandProfileId: 'listing-brand',
    numberOfSongs: 1,
    planGenerator: buildPlanGenerator(),
    trackPipeline: makeTrackPipeline(),
    brandLoader: fakeBrandLoader,
    isTest: true,
  });
  const nonTestAlbums = getAllAlbums();
  assert.ok(!nonTestAlbums.some(a => a.id === result.albumId), 'test rows must not leak into default listing');
  const allAlbums = getAllAlbums({ includeTests: true });
  assert.ok(allAlbums.some(a => a.id === result.albumId));
});

test('album repair creates planned track jobs when plan exists but songs are missing', async () => {
  const plan = (await buildPlanGenerator()({ brandProfile: FAKE_BRAND, numberOfSongs: 8, albumTheme: 'Repair Theme' })).plan;
  const albumId = createAlbum({
    id: 'ALBUM_REPAIR_NO_TRACKS',
    brand_profile_id: 'repair-brand',
    album_title: plan.album_title,
    album_theme: plan.album_theme,
    number_of_songs: 8,
    cost_mode: 'album_batch',
    status: 'generating_tracks',
    shared_orchestration: { plan_version: plan.plan_version, plan, orchestration_cost_usd: 0.072783 },
    is_test: true,
  });
  albumOutputIds.add(albumId);
  recordCostEvent({
    id: `cost_${albumId}_shared_repair_test`,
    albumId,
    pipelineStep: 'orchestration',
    agentName: 'album-orchestrator',
    operation: 'album_plan_generated',
    provider: 'anthropic',
    model: 'claude',
    unitType: 'tokens',
    computedCostUsd: 0.072783,
    pricingSource: 'test',
    status: 'success',
  });

  const result = await repairAlbumBatch({
    albumId,
    resume: false,
    brandLoader: fakeBrandLoader,
  });

  const songs = getSongsForAlbum(albumId);
  assert.equal(result.ensured.length, 8);
  assert.equal(songs.length, 8);
  assert.deepEqual(songs.map(song => song.track_number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.financeSummary.track_count, 8);
  assert.ok(result.financeSummary.shared_thinking_cost_usd > 0);
});

test('album repair is idempotent and does not create duplicate track jobs', async () => {
  const plan = (await buildPlanGenerator()({ brandProfile: FAKE_BRAND, numberOfSongs: 3, albumTheme: 'Idempotent' })).plan;
  const albumId = createAlbum({
    id: 'ALBUM_REPAIR_IDEMPOTENT',
    brand_profile_id: 'repair-brand',
    album_title: plan.album_title,
    album_theme: plan.album_theme,
    number_of_songs: 3,
    cost_mode: 'standard',
    status: 'generating_tracks',
    shared_orchestration: { plan_version: plan.plan_version, plan },
    is_test: true,
  });
  albumOutputIds.add(albumId);

  ensureAlbumTrackJobs({ albumId, plan, brandProfileId: 'repair-brand', isTest: true });
  const firstIds = getSongsForAlbum(albumId).map(song => song.id);
  await repairAlbumBatch({ albumId, resume: false, brandLoader: fakeBrandLoader });
  await repairAlbumBatch({ albumId, resume: false, brandLoader: fakeBrandLoader });
  const secondIds = getSongsForAlbum(albumId).map(song => song.id);

  assert.equal(secondIds.length, 3);
  assert.deepEqual(secondIds, firstIds);
});

test('album resume resumes only first incomplete track and skips completed tracks', async () => {
  const plan = (await buildPlanGenerator()({ brandProfile: FAKE_BRAND, numberOfSongs: 3, albumTheme: 'Resume' })).plan;
  const albumId = createAlbum({
    id: 'ALBUM_REPAIR_RESUME',
    brand_profile_id: 'repair-brand',
    album_title: plan.album_title,
    album_theme: plan.album_theme,
    number_of_songs: 3,
    cost_mode: 'standard',
    status: 'generating_tracks',
    shared_orchestration: { plan_version: plan.plan_version, plan },
    is_test: true,
  });
  albumOutputIds.add(albumId);
  updateAlbum(albumId, {
    shared_orchestration: {
      plan_version: plan.plan_version,
      plan,
      latest_error: 'previous auth failure',
    },
  });
  const songs = ensureAlbumTrackJobs({ albumId, plan, brandProfileId: 'repair-brand', isTest: true });
  upsertSong({ id: songs[0].id, pipeline_stage: 'album_track_generated', total_cost_usd: 0.12 });
  const recordedTracks = [];

  const result = await resumeAlbumBatch({
    albumId,
    brandLoader: fakeBrandLoader,
    trackPipeline: makeTrackPipeline({ recordedTracks, costPerTrack: 0.03 }),
  });

  assert.equal(result.resumed.length, 1);
  assert.deepEqual(recordedTracks.map(track => track.track_number), [2]);
  assert.equal(getSong(songs[0].id).pipeline_stage, 'album_track_generated');
  assert.equal(getAlbum(albumId).shared_orchestration.latest_error, null);
});

test('album repair finance shows shared thinking cost before tracks finish', async () => {
  const plan = (await buildPlanGenerator()({ brandProfile: FAKE_BRAND, numberOfSongs: 2, albumTheme: 'Finance Repair' })).plan;
  const albumId = createAlbum({
    id: 'ALBUM_REPAIR_FINANCE',
    brand_profile_id: 'repair-brand',
    album_title: plan.album_title,
    album_theme: plan.album_theme,
    number_of_songs: 2,
    cost_mode: 'album_batch',
    status: 'generating_tracks',
    shared_orchestration: { plan_version: plan.plan_version, plan },
    is_test: true,
  });
  albumOutputIds.add(albumId);
  recordCostEvent({
    id: `cost_${albumId}_shared_before_tracks`,
    albumId,
    pipelineStep: 'orchestration',
    agentName: 'album-orchestrator',
    operation: 'album_plan_generated',
    provider: 'anthropic',
    model: 'claude',
    unitType: 'tokens',
    computedCostUsd: 0.07,
    pricingSource: 'test',
    status: 'success',
  });

  const result = await repairAlbumBatch({
    albumId,
    resume: false,
    brandLoader: fakeBrandLoader,
  });

  const album = getAlbum(albumId);
  assert.equal(result.financeSummary.track_count, 2);
  assert.ok(result.financeSummary.shared_thinking_cost_usd >= 0.07);
  assert.ok(album.finance_summary.shared_thinking_cost_usd >= 0.07);
  assert.ok(album.finance_summary.allocated_shared_cost_per_song_usd > 0);
});

test('album finance does not double-count orchestration marker when verified event exists', async () => {
  const plan = (await buildPlanGenerator()({ brandProfile: FAKE_BRAND, numberOfSongs: 2, albumTheme: 'Dedupe' })).plan;
  const albumId = createAlbum({
    id: 'ALBUM_REPAIR_FINANCE_DEDUPE',
    brand_profile_id: 'repair-brand',
    album_title: plan.album_title,
    album_theme: plan.album_theme,
    number_of_songs: 2,
    cost_mode: 'album_batch',
    status: 'generating_tracks',
    shared_orchestration: { plan_version: plan.plan_version, plan },
    is_test: true,
  });
  albumOutputIds.add(albumId);
  recordCostEvent({
    id: `cost_${albumId}_orchestration_marker`,
    albumId,
    pipelineStep: 'orchestration',
    agentName: 'album-orchestrator',
    operation: 'album_plan_generated',
    provider: 'anthropic',
    model: 'album-orchestrator',
    unitType: 'tokens',
    computedCostUsd: 0.05,
    pricingSource: 'album_batch_service',
    status: 'success',
  });
  recordCostEvent({
    id: `cost_${albumId}_verified_orchestration`,
    albumId,
    pipelineStep: 'orchestration',
    agentName: 'album-orchestrator',
    operation: 'anthropic_agent_run',
    provider: 'anthropic',
    model: 'claude',
    unitType: 'tokens',
    computedCostUsd: 0.07,
    pricingSource: 'anthropic_usage',
    status: 'success',
  });

  const result = await repairAlbumBatch({
    albumId,
    brandLoader: fakeBrandLoader,
  });

  assert.equal(result.financeSummary.shared_thinking_cost_usd, 0.07);
});

test('album resume does not rerun orchestration and chooses the first failed or incomplete track', async () => {
  const plan = (await buildPlanGenerator()({ brandProfile: FAKE_BRAND, numberOfSongs: 3, albumTheme: 'No Orchestration' })).plan;
  const albumId = createAlbum({
    id: 'ALBUM_RESUME_NO_ORCHESTRATION',
    brand_profile_id: 'repair-brand',
    album_title: plan.album_title,
    album_theme: plan.album_theme,
    number_of_songs: 3,
    cost_mode: 'standard',
    status: 'generating_tracks',
    shared_orchestration: { plan_version: plan.plan_version, plan },
    is_test: true,
  });
  albumOutputIds.add(albumId);
  const songs = ensureAlbumTrackJobs({ albumId, plan, brandProfileId: 'repair-brand', isTest: true });
  upsertSong({ id: songs[0].id, pipeline_stage: 'album_track_generated', total_cost_usd: 0.12 });
  upsertSong({ id: songs[1].id, pipeline_stage: 'album_track_failed', notes: 'previous failure' });
  const recordedTracks = [];

  const result = await resumeAlbumBatch({
    albumId,
    brandLoader: fakeBrandLoader,
    trackPipeline: makeTrackPipeline({ recordedTracks, costPerTrack: 0.03 }),
  });

  assert.equal(result.generationStarted, true);
  assert.equal(recordedTracks.length, 1);
  assert.equal(recordedTracks[0].track_number, 2);
  assert.equal(getSongsForAlbum(albumId).length, 3);
  assert.equal(getSong(songs[0].id).pipeline_stage, 'album_track_generated');
});

test('album resume persists provider auth/config errors in album latest event', async () => {
  const plan = (await buildPlanGenerator()({ brandProfile: FAKE_BRAND, numberOfSongs: 2, albumTheme: 'Auth Error' })).plan;
  const albumId = createAlbum({
    id: 'ALBUM_RESUME_AUTH_ERROR',
    brand_profile_id: 'repair-brand',
    album_title: plan.album_title,
    album_theme: plan.album_theme,
    number_of_songs: 2,
    cost_mode: 'standard',
    status: 'generating_tracks',
    shared_orchestration: { plan_version: plan.plan_version, plan },
    is_test: true,
  });
  albumOutputIds.add(albumId);
  const authError = 'Could not resolve authentication method for Anthropic';

  const result = await resumeAlbumBatch({
    albumId,
    brandLoader: fakeBrandLoader,
    trackPipeline: async () => {
      throw new Error(authError);
    },
  });

  const album = getAlbum(albumId);
  const songs = getSongsForAlbum(albumId);
  assert.equal(result.generationStarted, true);
  assert.match(result.latestError, /Could not resolve authentication method/);
  assert.match(album.shared_orchestration.latest_error, /Could not resolve authentication method/);
  assert.equal(album.shared_orchestration.latest_event.type, 'album_resume_complete');
  assert.equal(songs[0].pipeline_stage, 'album_track_failed');
});

test('generateAlbumPlan reports missing ANTHROPIC_API_KEY before any network attempt', async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await generateAlbumPlan({ brandProfile: FAKE_BRAND, numberOfSongs: 2 });
    assert.fail('expected generateAlbumPlan to throw');
  } catch (err) {
    assert.ok(
      err.message.includes('ANTHROPIC_API_KEY'),
      `Error message should mention ANTHROPIC_API_KEY; got: "${err.message}"`
    );
    assert.ok(
      err.message.includes('.env'),
      `Error message should mention .env; got: "${err.message}"`
    );
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test('runAlbumBatch records orchestration failure in album record before lyricist stage', async () => {
  clearBrandInterpretationCache();
  const events = [];
  const result = await runAlbumBatch({
    brandProfileId: 'fake-brand',
    numberOfSongs: 2,
    brandLoader: fakeBrandLoader,
    planGenerator: async () => { throw new Error('Synthetic orchestrator connection error'); },
    isTest: true,
    onEvent: async (e) => events.push(e),
  }).catch(err => ({ threw: err.message }));

  assert.ok(result.threw, 'expected runAlbumBatch to reject when planGenerator fails');
  assert.match(result.threw, /Synthetic orchestrator connection error/);
  // No track_started event should have been emitted — failure is pre-lyricist
  assert.equal(events.filter(e => e.type === 'track_started').length, 0);
  assert.ok(events.some(e => e.type === 'album_progress' && e.stage === 'orchestrating'));
});
