/**
 * Tests for duration/word-range consistency validation and render prompt correctness.
 *
 * Goals verified here:
 *   1. Active profile (not brand-profile.json) controls target duration in render prompt.
 *   2. Render prompt for a long-form profile contains no hardcoded short-song duration.
 *   3. Lyricist prompt for long-target profiles contains full-length structure guidance.
 *   4. Validator catches target_length max > 4:00 when normal_word_range max < 450.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: minimal valid profile factory
// ─────────────────────────────────────────────────────────────────────────────

function makeMinimalProfile(musicOverrides = {}, topLevelOverrides = {}) {
  return {
    brand_name: 'Test Brand',
    app_title: 'Test App',
    brand_type: 'music',
    brand_description: 'original test brand for unit testing',
    audience: {
      age_range: '16+',
      description: 'test audience',
      guardrail: 'clean',
    },
    character: {
      name: 'Test Artist',
      core_concept: 'test concept',
      fallback_summary: 'test summary',
      visual_identity: 'test visual',
      visual_reference: ['test reference'],
    },
    music: {
      default_style: 'test style',
      default_bpm: 100,
      default_key: 'C Major',
      default_prompt: 'test prompt',
      target_length: '2:30-4:30',
      normal_word_range: '260-480',
      first_vocal_by_seconds: 5,
      max_instrumental_intro_seconds: 6,
      ...musicOverrides,
    },
    lyrics: {
      title_examples: ['Test Title'],
      topic_variety: 'test variety',
      required_closing: 'test closing',
    },
    distribution: {
      default_distributor: 'none',
      legacy_distributor: 'none',
      research_default_service: 'none',
      research_default_url: 'none',
      default_artist: 'Test Artist',
      default_album: 'Test Album',
      primary_genre: 'Rock',
      spotify_genres: ['rock'],
      youtube_tags_seed: ['rock'],
      apple_music_genres: ['Rock'],
      coppa_status: 'not directed to children under 13',
      content_advisory: 'clean',
    },
    ui: {
      sidebar_subtitle: 'Test Studio',
      logo_path: '/test.png',
    },
    ...topLevelOverrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Validator: profile with target > 4:00 and low word max throws
// ─────────────────────────────────────────────────────────────────────────────

test('validateBrandProfile throws when target_length max > 4:00 and normal_word_range max < 450', async () => {
  const { validateBrandProfile } = await import('../src/shared/brand-profile.js');
  const bad = makeMinimalProfile({
    target_length: '2:30-4:30',
    normal_word_range: '160-360', // max 360 < 450
  });
  assert.throws(
    () => validateBrandProfile(bad, 'test profile'),
    /normal_word_range max.*450/i,
    'Expected a validation error about word range being under 450 for long targets'
  );
});

test('validateBrandProfile passes when target_length max > 4:00 and normal_word_range max >= 450', async () => {
  const { validateBrandProfile } = await import('../src/shared/brand-profile.js');
  const good = makeMinimalProfile({
    target_length: '2:30-4:30',
    normal_word_range: '260-480', // max 480 >= 450
  });
  assert.doesNotThrow(() => validateBrandProfile(good, 'test profile'));
});

test('validateBrandProfile passes for sparse_format profile even with low word range and long target', async () => {
  const { validateBrandProfile } = await import('../src/shared/brand-profile.js');
  const sparse = makeMinimalProfile({
    target_length: '2:30-4:30',
    normal_word_range: '100-200',
    sparse_format: true,
  });
  assert.doesNotThrow(() => validateBrandProfile(sparse, 'test sparse profile'));
});

test('validateBrandProfile passes for array-format word range that meets the threshold', async () => {
  const { validateBrandProfile } = await import('../src/shared/brand-profile.js');
  const arrayRange = makeMinimalProfile({
    target_length: '2:30-4:30',
    normal_word_range: [260, 480],
  });
  assert.doesNotThrow(() => validateBrandProfile(arrayRange, 'test array range profile'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. All real brand profiles pass validation (including new word ranges)
// ─────────────────────────────────────────────────────────────────────────────

test('all brand profiles in config/brand-profiles pass validateBrandProfile', async () => {
  const { validateBrandProfile } = await import('../src/shared/brand-profile.js');
  const profilesDir = path.join(ROOT, 'config/brand-profiles');
  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));

  const errors = [];
  for (const file of files) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(profilesDir, file), 'utf8'));
      validateBrandProfile(profile, file);
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }

  assert.deepEqual(errors, [], `Brand profiles failed validation:\n${errors.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Render prompt uses active profile's target_length, not a hardcoded value
// ─────────────────────────────────────────────────────────────────────────────

test('buildRenderSafetyPrompt uses the active profile target_length for a long-form profile', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-duration-'));
  const profilePath = path.join(tmp, 'long-form-test.json');

  const longProfile = makeMinimalProfile({
    target_length: '2:30-4:30',
    normal_word_range: '260-480',
  });
  fs.writeFileSync(profilePath, JSON.stringify(longProfile));

  const originalPath = process.env.BRAND_PROFILE_PATH;
  process.env.BRAND_PROFILE_PATH = profilePath;

  try {
    const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
    clearBrandProfileCache();

    const { buildRenderSafetyPrompt } = await import(`../src/shared/song-qa.js?cacheBust=${Date.now()}`);
    const parts = buildRenderSafetyPrompt('Test Song Title');
    const prompt = Array.isArray(parts) ? parts.join(', ') : String(parts);

    assert.ok(
      prompt.includes('2:30-4:30'),
      `Render safety prompt should include the active profile target_length "2:30-4:30" but got: ${prompt.slice(0, 200)}`
    );
    assert.ok(
      !prompt.includes('1:30-2:00') && !prompt.includes('1:30 to 2:00'),
      `Render safety prompt must not contain a hardcoded children-profile duration`
    );
  } finally {
    if (originalPath === undefined) delete process.env.BRAND_PROFILE_PATH;
    else process.env.BRAND_PROFILE_PATH = originalPath;

    const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
    clearBrandProfileCache();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Lyricist prompt contains full-length structure guidance for long targets
// ─────────────────────────────────────────────────────────────────────────────

test('buildLyricsTask includes full-length structure requirement when target max exceeds 2:30', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-duration-'));
  const profilePath = path.join(tmp, 'long-form-lyricist.json');

  const longProfile = makeMinimalProfile({
    target_length: '2:30-4:30',
    normal_word_range: '260-480',
  });
  fs.writeFileSync(profilePath, JSON.stringify(longProfile));

  const originalPath = process.env.BRAND_PROFILE_PATH;
  process.env.BRAND_PROFILE_PATH = profilePath;

  try {
    const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
    clearBrandProfileCache();

    const { buildLyricsTask } = await import(`../src/agents/lyricist.js?cacheBust=${Date.now()}`);
    const prompt = buildLyricsTask({ topic: 'test topic', researchReport: null, revisionNotes: null, existingLyrics: null, performanceBrief: null });

    assert.ok(
      prompt.includes('FULL-LENGTH SONG REQUIREMENT'),
      'Long-target profile should trigger FULL-LENGTH SONG REQUIREMENT section'
    );
    assert.ok(
      prompt.includes('verse 1') || prompt.includes('VERSE 1'),
      'Full-length guidance should mention verse structure'
    );
    assert.ok(
      prompt.includes('chorus') || prompt.includes('CHORUS'),
      'Full-length guidance should mention chorus'
    );
    assert.ok(
      prompt.includes('260-480'),
      'Prompt should reflect updated word range'
    );
  } finally {
    if (originalPath === undefined) delete process.env.BRAND_PROFILE_PATH;
    else process.env.BRAND_PROFILE_PATH = originalPath;

    const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
    clearBrandProfileCache();
  }
});

test('buildLyricsTask does not include full-length guidance for short target profiles', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-duration-'));
  const profilePath = path.join(tmp, 'short-form-lyricist.json');

  const shortProfile = makeMinimalProfile({
    target_length: '1:30-2:00',
    normal_word_range: '80-140',
  }, { brand_type: 'children_music' });
  fs.writeFileSync(profilePath, JSON.stringify(shortProfile));

  const originalPath = process.env.BRAND_PROFILE_PATH;
  process.env.BRAND_PROFILE_PATH = profilePath;

  try {
    const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
    clearBrandProfileCache();

    const { buildLyricsTask } = await import(`../src/agents/lyricist.js?cacheBust=${Date.now()}`);
    const prompt = buildLyricsTask({ topic: 'test topic', researchReport: null, revisionNotes: null, existingLyrics: null, performanceBrief: null });

    assert.ok(
      !prompt.includes('FULL-LENGTH SONG REQUIREMENT'),
      'Short-target profile should not include full-length structure guidance'
    );
  } finally {
    if (originalPath === undefined) delete process.env.BRAND_PROFILE_PATH;
    else process.env.BRAND_PROFILE_PATH = originalPath;

    const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
    clearBrandProfileCache();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Active profile (not brand-profile.json default) controls target duration
// ─────────────────────────────────────────────────────────────────────────────

test('active profile controls target_length used in pipeline, not config/brand-profile.json default', async () => {
  const soundheadPath = path.join(ROOT, 'config/brand-profiles/soundhead.json');
  if (!fs.existsSync(soundheadPath)) {
    // Skip if soundhead profile not present
    return;
  }
  const soundhead = JSON.parse(fs.readFileSync(soundheadPath, 'utf8'));
  const defaultProfile = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/brand-profile.json'), 'utf8'));

  // Confirm the two profiles have different target lengths
  assert.notEqual(
    soundhead.music.target_length,
    defaultProfile.music.target_length,
    'Test requires soundhead and default profiles to have different target_length values'
  );

  const originalPath = process.env.BRAND_PROFILE_PATH;
  process.env.BRAND_PROFILE_PATH = soundheadPath;

  try {
    const { clearBrandProfileCache, loadBrandProfile } = await import('../src/shared/brand-profile.js');
    clearBrandProfileCache();

    const loaded = loadBrandProfile();
    assert.equal(
      loaded.music.target_length,
      soundhead.music.target_length,
      `loadBrandProfile() should return soundhead's target_length (${soundhead.music.target_length}) when BRAND_PROFILE_PATH points to soundhead`
    );
    assert.notEqual(
      loaded.music.target_length,
      defaultProfile.music.target_length,
      'loadBrandProfile() must not return the default profile target_length when a custom profile is active'
    );
  } finally {
    if (originalPath === undefined) delete process.env.BRAND_PROFILE_PATH;
    else process.env.BRAND_PROFILE_PATH = originalPath;

    const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
    clearBrandProfileCache();
  }
});
