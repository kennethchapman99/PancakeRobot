import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { prepareTestDbSlug } from '../src/shared/test-db-artifacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-album-batch').slug;

const {
  runAlbumBatch,
  normalizeCostMode,
  ALBUM_COST_MODES,
} = await import('../src/services/album-batch-service.js');
const {
  getAlbum,
  getSongsForAlbum,
  getAllAlbums,
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
