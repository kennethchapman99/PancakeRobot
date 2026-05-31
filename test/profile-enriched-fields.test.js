import test from 'node:test';
import assert from 'node:assert/strict';

import { validateBrandProfile, hasEnrichedPerformanceFields } from '../src/shared/brand-profile.js';

// Minimal valid base profile (all required fields).
function makeBase(overrides = {}) {
  return {
    brand_name: 'Test Brand',
    app_title: 'Test',
    brand_type: 'music',
    brand_description: 'test brand',
    audience: { age_range: '18+', description: 'adults', guardrail: 'adult content OK' },
    character: { name: 'Testy', core_concept: 'test', fallback_summary: 'test artist', visual_identity: 'bold' },
    music: {
      default_style: 'pop',
      default_bpm: 120,
      default_key: 'C',
      default_prompt: 'pop song',
      target_length: '3:00',
      normal_word_range: '160-320',
      first_vocal_by_seconds: 5,
      max_instrumental_intro_seconds: 5,
    },
    lyrics: { title_examples: ['Test Song'], topic_variety: 'any', required_closing: 'end' },
    visuals: { style: 'bold', palette: { primary: '#000', secondary: '#fff', accent: '#f00', background: '#fff' }, negative_prompt: 'none', text_overlay_style: 'bold' },
    media: { default_image_url: '', default_image_path: '' },
    distribution: {
      default_distributor: 'none',
      legacy_distributor: 'none',
      research_default_service: 'none',
      research_default_url: 'none',
      default_artist: 'Test',
      default_album: 'Test Album',
      primary_genre: 'Pop',
      spotify_genres: ['pop'],
      youtube_tags_seed: ['music'],
      apple_music_genres: ['Pop'],
      coppa_status: 'not_applicable',
      content_advisory: 'suitable for adults',
    },
    ui: { sidebar_subtitle: 'Studio', logo_path: '/logo.png' },
    ...overrides,
  };
}

test('legacy profile without enriched fields validates correctly', () => {
  const profile = makeBase();
  assert.doesNotThrow(() => validateBrandProfile(profile, 'test'));
});

test('legacy profile with basic songwriting block validates correctly', () => {
  const profile = makeBase({
    songwriting: {
      song_type: 'pop',
      allowed_elements: ['melody'],
      forbidden_elements: ['violence'],
      required_elements: ['hook'],
      structure_preferences: ['verse-chorus'],
      output_schema: { include_audio_prompt: true },
    },
  });
  assert.doesNotThrow(() => validateBrandProfile(profile, 'test'));
});

test('profile with vocal_performance_engine validates correctly', () => {
  const profile = makeBase({
    songwriting: {
      song_type: 'rap',
      allowed_elements: ['flow'],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      vocal_performance_engine: {
        priority: 'vocal is the main instrument',
        vocal_textures: ['clipped consonants', 'dry delivery'],
        timing_behaviors: ['behind the beat'],
        adlib_behaviors: ['self-interrupting adlibs'],
        avoid: ['smooth radio delivery'],
      },
    },
  });
  assert.doesNotThrow(() => validateBrandProfile(profile, 'test'));
});

test('profile with performance_conceit_bank validates correctly', () => {
  const profile = makeBase({
    songwriting: {
      song_type: 'rap',
      allowed_elements: ['flow'],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      performance_conceit_bank: [
        'the vocal sounds bored until bar 4 snaps into double-time',
        'adlibs argue with the lead vocal',
      ],
    },
  });
  assert.doesNotThrow(() => validateBrandProfile(profile, 'test'));
});

test('profile with album_mode_lanes validates correctly', () => {
  const profile = makeBase({
    songwriting: {
      song_type: 'rap',
      allowed_elements: ['flow'],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      album_mode_lanes: [
        { name: 'pressure track', description: 'dense flows and beat-stop punchlines' },
        { name: 'club menace', description: 'bass-forward and chantable' },
      ],
    },
  });
  assert.doesNotThrow(() => validateBrandProfile(profile, 'test'));
});

test('profile with all enriched fields validates correctly', () => {
  const profile = makeBase({
    songwriting: {
      song_type: 'rap',
      allowed_elements: ['flow'],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      vocal_performance_engine: {
        priority: 'attack and timing first',
        vocal_textures: ['dry delivery'],
        timing_behaviors: ['behind the beat'],
        adlib_behaviors: ['dry reactions'],
        avoid: ['smooth delivery'],
      },
      performance_conceit_bank: ['bored-to-double-time flip', 'beat-dropout punchline'],
      album_mode_lanes: [
        { name: 'pressure', description: 'dense and sharp' },
        { name: 'chaos', description: 'ugly funny unstable' },
      ],
      song_differentiation_rules: ['no two consecutive tracks with same hook type'],
      anti_generic_rules: ['every track must have a specific vocal gimmick'],
      do_not_repeat_across_album: ['same vocal conceit on two tracks'],
      hidden_brief_requirements: ['vocal_conceit', 'flow_movement'],
    },
  });
  assert.doesNotThrow(() => validateBrandProfile(profile, 'test'));
});

test('malformed vocal_performance_engine (not an object) throws', () => {
  const profile = makeBase({
    songwriting: {
      song_type: 'rap',
      allowed_elements: [],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      vocal_performance_engine: 'just a string',
    },
  });
  assert.throws(() => validateBrandProfile(profile, 'test'), /vocal_performance_engine must be an object/);
});

test('malformed album_mode_lanes (missing name) throws', () => {
  const profile = makeBase({
    songwriting: {
      song_type: 'rap',
      allowed_elements: [],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      album_mode_lanes: [
        { description: 'missing name field' },
      ],
    },
  });
  assert.throws(() => validateBrandProfile(profile, 'test'), /album_mode_lanes\[0\]\.name must be a non-empty string/);
});

test('malformed performance_conceit_bank (empty array) does not throw', () => {
  const profile = makeBase({
    songwriting: {
      song_type: 'rap',
      allowed_elements: [],
      forbidden_elements: [],
      required_elements: [],
      structure_preferences: [],
      performance_conceit_bank: [],
    },
  });
  assert.doesNotThrow(() => validateBrandProfile(profile, 'test'));
});

test('hasEnrichedPerformanceFields returns false for legacy profile', () => {
  const profile = makeBase();
  assert.equal(hasEnrichedPerformanceFields(profile), false);
});

test('hasEnrichedPerformanceFields returns true when vocal_performance_engine present', () => {
  const profile = makeBase({
    songwriting: {
      vocal_performance_engine: { priority: 'test', vocal_textures: ['dry'], timing_behaviors: [], adlib_behaviors: [], avoid: [] },
    },
  });
  assert.equal(hasEnrichedPerformanceFields(profile), true);
});

test('hasEnrichedPerformanceFields returns true when performance_conceit_bank present', () => {
  const profile = makeBase({
    songwriting: { performance_conceit_bank: ['conceit one'] },
  });
  assert.equal(hasEnrichedPerformanceFields(profile), true);
});

test('existing production profiles (doechii, gravl) still load and validate', async () => {
  const { loadBrandProfileById } = await import('../src/shared/brand-profile.js');
  for (const id of ['doechii', 'gravl-brand-profile']) {
    assert.doesNotThrow(() => loadBrandProfileById(id), `${id} should validate`);
  }
});
