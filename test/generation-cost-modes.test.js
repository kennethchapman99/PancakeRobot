/**
 * Generation cost mode tests.
 *
 * Covers:
 *   - SONG_GENERATION_MODE_CONFIG shape and values per mode
 *   - normalizeSongGenerationMode fallback to 'standard'
 *   - draft mode uses haiku model and lower token cap
 *   - standard mode has capped max tokens below premium
 *   - premium mode is distinct (not default)
 *   - brand interpretation cache works for single-song pipeline
 *   - Brand Doctor analyze/tune does NOT call generateMusic
 *   - existing-audio protection still prevents duplicate MiniMax calls
 *   - checkPhaseBudget reports overruns correctly
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  SONG_GENERATION_MODES,
  SONG_GENERATION_MODE_CONFIG,
  normalizeSongGenerationMode,
  getSongGenerationModeConfig,
  checkPhaseBudget,
} = await import('../src/shared/generation-cost-config.js');

const {
  makeBrandInterpretationSignature,
  getCachedBrandInterpretation,
  setCachedBrandInterpretation,
  clearBrandInterpretationCache,
} = await import('../src/shared/brand-interpretation-cache.js');

const {
  findExistingValidAudioFile,
} = await import(`../src/agents/music-generator.js?t=${Date.now()}`);

// ── SONG_GENERATION_MODE_CONFIG shape ─────────────────────────────────────────

test('SONG_GENERATION_MODES exports expected keys', () => {
  assert.equal(SONG_GENERATION_MODES.DRAFT, 'draft');
  assert.equal(SONG_GENERATION_MODES.STANDARD, 'standard');
  assert.equal(SONG_GENERATION_MODES.PREMIUM, 'premium');
  assert.ok(Object.isFrozen(SONG_GENERATION_MODES));
});

test('SONG_GENERATION_MODE_CONFIG has all three modes', () => {
  assert.ok(SONG_GENERATION_MODE_CONFIG.draft, 'draft mode missing');
  assert.ok(SONG_GENERATION_MODE_CONFIG.standard, 'standard mode missing');
  assert.ok(SONG_GENERATION_MODE_CONFIG.premium, 'premium mode missing');
});

const REQUIRED_FIELDS = [
  'label', 'description', 'lyricistMaxTokens', 'lyricistModel',
  'skipBrandReview', 'skipPerformanceBrief', 'researchCacheMinutes',
  'phaseBudgetCapsUsd', 'estimatedMaxCostUsd',
];

for (const mode of ['draft', 'standard', 'premium']) {
  test(`${mode} mode config has all required fields`, () => {
    const cfg = SONG_GENERATION_MODE_CONFIG[mode];
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in cfg, `${mode} missing field: ${field}`);
    }
  });
}

// ── draft mode specifics ───────────────────────────────────────────────────────

test('draft mode uses haiku model', () => {
  assert.ok(
    SONG_GENERATION_MODE_CONFIG.draft.lyricistModel.includes('haiku'),
    'draft lyricistModel must be a haiku variant'
  );
});

test('draft mode has lower token cap than standard', () => {
  assert.ok(
    SONG_GENERATION_MODE_CONFIG.draft.lyricistMaxTokens < SONG_GENERATION_MODE_CONFIG.standard.lyricistMaxTokens,
    'draft lyricistMaxTokens must be less than standard'
  );
});

test('draft mode skips brand review', () => {
  assert.equal(SONG_GENERATION_MODE_CONFIG.draft.skipBrandReview, true);
});

test('draft mode skips performance brief', () => {
  assert.equal(SONG_GENERATION_MODE_CONFIG.draft.skipPerformanceBrief, true);
});

test('draft mode estimated cost is lower than standard', () => {
  assert.ok(
    SONG_GENERATION_MODE_CONFIG.draft.estimatedMaxCostUsd < SONG_GENERATION_MODE_CONFIG.standard.estimatedMaxCostUsd,
    'draft estimated cost must be lower than standard'
  );
});

// ── standard mode specifics ───────────────────────────────────────────────────

test('standard mode uses sonnet model', () => {
  assert.ok(
    SONG_GENERATION_MODE_CONFIG.standard.lyricistModel.includes('sonnet'),
    'standard lyricistModel must be a sonnet variant'
  );
});

test('standard mode has capped tokens below premium', () => {
  assert.ok(
    SONG_GENERATION_MODE_CONFIG.standard.lyricistMaxTokens < SONG_GENERATION_MODE_CONFIG.premium.lyricistMaxTokens,
    'standard lyricistMaxTokens must be less than premium'
  );
});

test('standard mode does not skip brand review', () => {
  assert.equal(SONG_GENERATION_MODE_CONFIG.standard.skipBrandReview, false);
});

// ── premium mode is opt-in, not default ───────────────────────────────────────

test('normalizeSongGenerationMode defaults to standard, not premium', () => {
  assert.equal(normalizeSongGenerationMode(undefined), 'standard');
  assert.equal(normalizeSongGenerationMode(''), 'standard');
  assert.equal(normalizeSongGenerationMode('garbage'), 'standard');
  assert.equal(normalizeSongGenerationMode(null), 'standard');
});

test('normalizeSongGenerationMode accepts valid modes', () => {
  assert.equal(normalizeSongGenerationMode('draft'), 'draft');
  assert.equal(normalizeSongGenerationMode('standard'), 'standard');
  assert.equal(normalizeSongGenerationMode('premium'), 'premium');
  assert.equal(normalizeSongGenerationMode('PREMIUM'), 'premium');
  assert.equal(normalizeSongGenerationMode('  Standard  '), 'standard');
});

test('getSongGenerationModeConfig returns standard for unknown input', () => {
  const cfg = getSongGenerationModeConfig('unknown');
  assert.equal(cfg, SONG_GENERATION_MODE_CONFIG.standard);
});

test('premium has the highest token budget and cost estimate', () => {
  const { draft, standard, premium } = SONG_GENERATION_MODE_CONFIG;
  assert.ok(premium.lyricistMaxTokens >= standard.lyricistMaxTokens);
  assert.ok(premium.estimatedMaxCostUsd > standard.estimatedMaxCostUsd);
  assert.ok(premium.estimatedMaxCostUsd > draft.estimatedMaxCostUsd);
});

// ── checkPhaseBudget ──────────────────────────────────────────────────────────

test('checkPhaseBudget returns null when cap is 0 (no cap)', () => {
  const result = checkPhaseBudget('draft', 'brand_interpretation', 0.99);
  assert.equal(result, null);
});

test('checkPhaseBudget reports overrun correctly', () => {
  const result = checkPhaseBudget('standard', 'lyrics_generation', 0.99);
  assert.ok(result !== null);
  assert.equal(result.overrun, true);
  assert.ok(result.excess > 0);
});

test('checkPhaseBudget reports no overrun when within cap', () => {
  const result = checkPhaseBudget('standard', 'lyrics_generation', 0.01);
  assert.ok(result !== null);
  assert.equal(result.overrun, false);
});

// ── brand interpretation cache ────────────────────────────────────────────────

test('brand interpretation cache stores and retrieves by brand+signature', () => {
  clearBrandInterpretationCache();
  const profile = { brand_name: 'TestBrand', character: { name: 'T' }, music: {}, songwriting: {}, audience: {}, lyrics: {} };
  const sig = makeBrandInterpretationSignature(profile);
  const value = { brand_profile_id: 'test', signature: sig };

  assert.equal(getCachedBrandInterpretation('test', sig), null, 'should be empty before set');
  setCachedBrandInterpretation('test', sig, value);
  const retrieved = getCachedBrandInterpretation('test', sig);
  assert.deepEqual(retrieved, value);
});

test('brand interpretation cache is invalidated by profile change', () => {
  clearBrandInterpretationCache();
  const profileA = { brand_name: 'A', character: { name: 'A' }, music: {}, songwriting: {}, audience: {}, lyrics: {} };
  const profileB = { brand_name: 'B', character: { name: 'B' }, music: {}, songwriting: {}, audience: {}, lyrics: {} };
  const sigA = makeBrandInterpretationSignature(profileA);
  const sigB = makeBrandInterpretationSignature(profileB);

  assert.notEqual(sigA, sigB, 'different profiles must produce different signatures');
  setCachedBrandInterpretation('test', sigA, { brand_name: 'A' });
  assert.equal(getCachedBrandInterpretation('test', sigB), null, 'stale sig must not hit cache');
});

test('brand interpretation cache expires after TTL', () => {
  clearBrandInterpretationCache();
  const profile = { brand_name: 'TTLTest', character: {}, music: {}, songwriting: {}, audience: {}, lyrics: {} };
  const sig = makeBrandInterpretationSignature(profile);
  const pastTime = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
  setCachedBrandInterpretation('ttltest', sig, { brand_name: 'TTLTest' }, { now: pastTime });
  assert.equal(getCachedBrandInterpretation('ttltest', sig), null, 'expired entry must return null');
});

// ── Brand Doctor does not generate audio ─────────────────────────────────────

test('brand-doctor-service module does not import or call music generation', async () => {
  const serviceText = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/services/brand-doctor-service.js'),
    'utf8'
  );
  // Remove comment lines before checking — comments document the invariant, not violate it
  const codeOnly = serviceText
    .split('\n')
    .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');

  assert.ok(
    !codeOnly.includes('generateMusic'),
    'brand-doctor-service.js must not call generateMusic in non-comment code'
  );
  assert.ok(
    !codeOnly.includes('music-generator'),
    'brand-doctor-service.js must not import music-generator'
  );
  assert.ok(
    !codeOnly.match(/https?:\/\/.*minimax|MINIMAX_BASE|minimax\.io/),
    'brand-doctor-service.js must not reference minimax API URLs'
  );
});

test('brand-doctor-service callClaude defaults to haiku model', () => {
  const serviceText = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/services/brand-doctor-service.js'),
    'utf8'
  );
  // The default model parameter in callClaude must be haiku
  assert.ok(
    serviceText.includes("model = 'claude-haiku-4-5-20251001'"),
    'callClaude default model must be haiku'
  );
});

// ── existing-audio protection ─────────────────────────────────────────────────

test('findExistingValidAudioFile returns null for missing directory', () => {
  const nonexistent = path.join(os.tmpdir(), `gen-cost-test-missing-${Date.now()}`);
  assert.equal(findExistingValidAudioFile(nonexistent), null);
});

test('findExistingValidAudioFile returns null for empty directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-cost-empty-'));
  try {
    assert.equal(findExistingValidAudioFile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findExistingValidAudioFile returns existing valid audio path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-cost-audio-'));
  const audioPath = path.join(dir, 'master.mp3');
  try {
    fs.writeFileSync(audioPath, Buffer.alloc(1024));
    assert.equal(findExistingValidAudioFile(dir), audioPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('music-generator reuse guard: confirmPaidRerender=false prevents new generation', async () => {
  // This is a structural check — verify the guard logic exists in source
  const generatorText = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/agents/music-generator.js'),
    'utf8'
  );
  assert.ok(
    generatorText.includes('confirmPaidRerender'),
    'music-generator must have confirmPaidRerender guard'
  );
  assert.ok(
    generatorText.includes('skipped_existing_audio'),
    'music-generator must emit skipped_existing_audio flag'
  );
});
