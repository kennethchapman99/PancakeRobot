import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAlbumOrchestrationTask,
  validateAlbumPlan,
  normalizeAlbumPlan,
  extractAlbumLaneContext,
  extractTrackAlbumContext,
} from '../src/agents/album-orchestrator.js';

const ENRICHED_PROFILE = {
  brand_name: 'Razor Bloom',
  character: { name: 'Razor Bloom', core_concept: 'experimental hard rap villain' },
  music: { default_style: 'experimental hip-hop', default_bpm: 140, default_prompt: 'hard rap' },
  songwriting: {
    song_type: 'experimental_hard_rap',
    allowed_elements: ['hard language'],
    forbidden_elements: [],
    required_elements: [],
    structure_preferences: [],
    album_mode_lanes: [
      { name: 'pressure track', description: 'dense flows and beat-stop punchlines' },
      { name: 'club menace', description: 'bass-forward and chantable' },
      { name: 'theatrical villain', description: 'character voices and monologue breaks' },
    ],
    performance_conceit_bank: [
      'bored-to-double-time flip',
      'beat-dropout punchline',
      'hook from clipped breath fragments',
      'adlib-arguing second personality',
    ],
    anti_generic_rules: ['every track must have a vocal gimmick in 10 seconds'],
    do_not_repeat_across_album: ['same conceit twice'],
    song_differentiation_rules: ['adjacent tracks must differ in hook type'],
  },
};

const LEGACY_PROFILE = {
  brand_name: 'Simple Pop',
  character: { name: 'Simple', core_concept: 'pop' },
  music: { default_style: 'pop', default_bpm: 120, default_prompt: 'pop song' },
  songwriting: { song_type: 'pop', allowed_elements: [], forbidden_elements: [], required_elements: [], structure_preferences: [] },
};

// --- buildAlbumOrchestrationTask ---

test('buildAlbumOrchestrationTask includes lane section for enriched profile', () => {
  const task = buildAlbumOrchestrationTask({
    brandProfile: ENRICHED_PROFILE,
    numberOfSongs: 3,
    albumTheme: 'test theme',
    releaseIntent: null,
    notes: null,
  });
  assert.ok(task.includes('ALBUM MODE LANES'));
  assert.ok(task.includes('pressure track'));
  assert.ok(task.includes('PRIMARY lane'));
});

test('buildAlbumOrchestrationTask includes conceit bank for enriched profile', () => {
  const task = buildAlbumOrchestrationTask({
    brandProfile: ENRICHED_PROFILE,
    numberOfSongs: 3,
    albumTheme: null,
    releaseIntent: null,
    notes: null,
  });
  assert.ok(task.includes('PERFORMANCE CONCEIT BANK'));
  assert.ok(task.includes('bored-to-double-time flip'));
});

test('buildAlbumOrchestrationTask includes album_lane and assigned_conceit in track shape for enriched profile', () => {
  const task = buildAlbumOrchestrationTask({
    brandProfile: ENRICHED_PROFILE,
    numberOfSongs: 2,
    albumTheme: null,
    releaseIntent: null,
    notes: null,
  });
  assert.ok(task.includes('"album_lane"'));
  assert.ok(task.includes('"assigned_conceit"'));
  assert.ok(task.includes('"primary_lane"'));
  assert.ok(task.includes('"contaminating_lane"'));
});

test('buildAlbumOrchestrationTask does NOT include lane section for legacy profile', () => {
  const task = buildAlbumOrchestrationTask({
    brandProfile: LEGACY_PROFILE,
    numberOfSongs: 3,
    albumTheme: null,
    releaseIntent: null,
    notes: null,
  });
  assert.ok(!task.includes('ALBUM MODE LANES'));
  assert.ok(!task.includes('"album_lane"'));
});

test('buildAlbumOrchestrationTask includes anti-generic rules for enriched profile', () => {
  const task = buildAlbumOrchestrationTask({
    brandProfile: ENRICHED_PROFILE,
    numberOfSongs: 2,
    albumTheme: null,
    releaseIntent: null,
    notes: null,
  });
  assert.ok(task.includes('ANTI-GENERIC RULES'));
  assert.ok(task.includes('vocal gimmick'));
});

// --- validateAlbumPlan ---

test('validateAlbumPlan accepts plan without enriched lane fields (legacy compat)', () => {
  const plan = {
    album_title: 'Test Album',
    album_theme: 'test',
    release_positioning: 'indie',
    sonic_palette: 'dark',
    lyrical_rules: ['rule1'],
    track_count: 2,
    tracks: [
      { track_number: 1, title: 'T1', concept: 'c1', emotional_role: 'opener', music_style_prompt: 'm1', lyric_direction: 'l1', provider_prompt_seed: 'p1' },
      { track_number: 2, title: 'T2', concept: 'c2', emotional_role: 'closer', music_style_prompt: 'm2', lyric_direction: 'l2', provider_prompt_seed: 'p2' },
    ],
  };
  const failures = validateAlbumPlan(plan, 2);
  assert.deepEqual(failures, []);
});

test('validateAlbumPlan accepts plan with enriched lane fields', () => {
  const plan = {
    album_title: 'Razor Album',
    album_theme: 'menace',
    release_positioning: 'indie rap',
    sonic_palette: 'dark heavy bass',
    lyrical_rules: ['no smooth delivery'],
    primary_lane: 'pressure track',
    contaminating_lane: 'theatrical villain',
    track_count: 2,
    tracks: [
      { track_number: 1, title: 'T1', concept: 'c1', emotional_role: 'opener', music_style_prompt: 'm1', lyric_direction: 'l1', provider_prompt_seed: 'p1', album_lane: 'pressure track', assigned_conceit: 'bored-to-double-time flip' },
      { track_number: 2, title: 'T2', concept: 'c2', emotional_role: 'closer', music_style_prompt: 'm2', lyric_direction: 'l2', provider_prompt_seed: 'p2', album_lane: 'theatrical villain contamination', assigned_conceit: 'beat-dropout punchline' },
    ],
  };
  const failures = validateAlbumPlan(plan, 2);
  assert.deepEqual(failures, []);
});

// --- normalizeAlbumPlan ---

test('normalizeAlbumPlan preserves primary_lane and contaminating_lane when present', () => {
  const rawPlan = {
    album_title: 'Test',
    album_theme: 'test',
    release_positioning: 'test',
    sonic_palette: 'dark',
    lyrical_rules: ['rule'],
    primary_lane: 'pressure track',
    contaminating_lane: 'club menace',
    track_count: 1,
    tracks: [
      { track_number: 1, title: 'T1', concept: 'c', emotional_role: 'opener', music_style_prompt: 'm', lyric_direction: 'l', provider_prompt_seed: 'p', album_lane: 'pressure track', assigned_conceit: 'test conceit' },
    ],
  };
  const normalized = normalizeAlbumPlan(rawPlan, 1);
  assert.equal(normalized.primary_lane, 'pressure track');
  assert.equal(normalized.contaminating_lane, 'club menace');
  assert.equal(normalized.tracks[0].album_lane, 'pressure track');
  assert.equal(normalized.tracks[0].assigned_conceit, 'test conceit');
});

test('normalizeAlbumPlan handles plan without lane fields', () => {
  const rawPlan = {
    album_title: 'Test',
    album_theme: 'test',
    release_positioning: 'test',
    sonic_palette: 'dark',
    lyrical_rules: ['rule'],
    track_count: 1,
    tracks: [
      { track_number: 1, title: 'T1', concept: 'c', emotional_role: 'opener', music_style_prompt: 'm', lyric_direction: 'l', provider_prompt_seed: 'p' },
    ],
  };
  const normalized = normalizeAlbumPlan(rawPlan, 1);
  assert.equal(normalized.primary_lane, undefined);
  assert.equal(normalized.contaminating_lane, undefined);
  assert.equal(normalized.tracks[0].album_lane, undefined);
});

// --- extractAlbumLaneContext ---

test('extractAlbumLaneContext returns null for plan without lanes', () => {
  const plan = { album_title: 'Test', tracks: [] };
  assert.equal(extractAlbumLaneContext(plan), null);
});

test('extractAlbumLaneContext returns lane context when present', () => {
  const plan = { primary_lane: 'pressure track', contaminating_lane: 'club menace' };
  const ctx = extractAlbumLaneContext(plan);
  assert.equal(ctx.primary_lane, 'pressure track');
  assert.equal(ctx.contaminating_lane, 'club menace');
});

// --- extractTrackAlbumContext ---

test('extractTrackAlbumContext returns null for track without enriched fields', () => {
  const plan = { track_count: 3, tracks: [] };
  const track = { track_number: 1, title: 'T', concept: 'c', emotional_role: 'opener', music_style_prompt: 'm', lyric_direction: 'l', provider_prompt_seed: 'p' };
  assert.equal(extractTrackAlbumContext(plan, track), null);
});

test('extractTrackAlbumContext returns full context when enriched', () => {
  const plan = { primary_lane: 'pressure', contaminating_lane: 'chaos', track_count: 4, tracks: [] };
  const track = { track_number: 2, title: 'T2', concept: 'c', emotional_role: 'verse', music_style_prompt: 'm', lyric_direction: 'l', provider_prompt_seed: 'p', album_lane: 'pressure', assigned_conceit: 'beat dropout punchline' };
  const ctx = extractTrackAlbumContext(plan, track);
  assert.equal(ctx.primary_lane, 'pressure');
  assert.equal(ctx.contaminating_lane, 'chaos');
  assert.equal(ctx.track_lane, 'pressure');
  assert.equal(ctx.assigned_conceit, 'beat dropout punchline');
  assert.equal(ctx.track_number, 2);
  assert.equal(ctx.track_count, 4);
});
