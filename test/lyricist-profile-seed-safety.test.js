import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildLyricsTask,
  collectProfileSeedTerms,
  findProfileSeedOveruse,
} = await import('../src/agents/lyricist.js');

function seedProfile(overrides = {}) {
  return {
    brand_name: 'Seed Safe Band',
    character: {
      name: 'Seed Safe Band',
      catchphrases: ['Moon key'],
      visual_reference: ['hidden studio door marked 47'],
      ...(overrides.character || {}),
    },
    lyrics: {
      title_examples: ['Signal 47'],
      topic_variety: 'rain, rooftops, basement signals, late-night reflection',
      ...(overrides.lyrics || {}),
    },
    songwriting: {
      reference_artists_for_internal_vibe_only: ['Q-Tip'],
      ...(overrides.songwriting || {}),
    },
    distribution: {
      default_artist: 'Seed Safe Band',
      ...(overrides.distribution || {}),
    },
    ...(overrides.root || {}),
  };
}

test('buildLyricsTask includes profile seed safety guidance', () => {
  const task = buildLyricsTask({ topic: 'rainy rooftop', researchReport: null });

  assert.match(task, /PROFILE SEED SAFETY:/);
  assert.match(task, /creative guidance, not a lyric ingredient list/);
  assert.match(task, /Title examples in the active profile are style references only/);
  assert.doesNotMatch(task, /Good title examples for this brand/);
});

test('collectProfileSeedTerms includes title examples, reference artists, catchphrases, and distinctive lore numbers', () => {
  const terms = collectProfileSeedTerms(seedProfile());
  const normalized = terms.map(term => `${term.type}:${term.normalized}`);

  assert.ok(normalized.includes('title_example:signal 47'));
  assert.ok(normalized.includes('reference_artist:q tip'));
  assert.ok(normalized.includes('catchphrase:moon key'));
  assert.ok(normalized.includes('background_lore_number:47'));
  assert.ok(!normalized.includes('title_example:seed safe band'));
});

test('findProfileSeedOveruse flags exact title examples and distinctive numbers when not requested', () => {
  const profile = seedProfile();
  const issues = findProfileSeedOveruse({
    title: 'Signal 47',
    lyrics: '[INTRO]\nSignal 47 is glowing on the rainy rooftop',
    chorus_lines: ['Signal 47'],
    key_hook: 'Signal 47',
    audio_prompt: { voice_style: 'clean indie vocal' },
  }, profile, 'rainy rooftop');

  assert.ok(issues.some(issue => issue.type === 'title_example' && issue.normalized === 'signal 47'));
  assert.ok(issues.some(issue => issue.type === 'background_lore_number' && issue.normalized === '47'));
});

test('findProfileSeedOveruse allows explicitly requested title examples', () => {
  const profile = seedProfile();
  const issues = findProfileSeedOveruse({
    title: 'Signal 47',
    lyrics: '[INTRO]\nSignal 47 is glowing on the rainy rooftop',
    chorus_lines: ['Signal 47'],
    key_hook: 'Signal 47',
    audio_prompt: { voice_style: 'clean indie vocal' },
  }, profile, 'Title: Signal 47');

  assert.equal(issues.length, 0);
});

test('findProfileSeedOveruse flags reference artist names in lyrics or audio prompt', () => {
  const profile = seedProfile();
  const issues = findProfileSeedOveruse({
    title: 'Rain on Concrete',
    lyrics: '[INTRO]\nThe rain keeps time under the streetlight',
    chorus_lines: ['Rain on concrete'],
    key_hook: 'Rain on concrete',
    audio_prompt: { voice_style: 'laid-back Q-Tip style vocal' },
  }, profile, 'rainy rooftop');

  assert.ok(issues.some(issue => issue.type === 'reference_artist' && issue.normalized === 'q tip'));
});

test('findProfileSeedOveruse does not flag brand name or default artist', () => {
  const profile = seedProfile();
  const issues = findProfileSeedOveruse({
    title: 'Rain on Concrete',
    lyrics: '[INTRO]\nSeed Safe Band walks through rain with a new melody',
    chorus_lines: ['Seed Safe Band in the rain'],
    key_hook: 'Seed Safe Band',
    audio_prompt: { voice_style: 'profile-aligned vocal' },
  }, profile, 'rainy rooftop');

  assert.equal(issues.length, 0);
});

test('findProfileSeedOveruse flags repeated catchphrases but allows rare single use by default', () => {
  const profile = seedProfile();
  const oneUse = findProfileSeedOveruse({
    title: 'Rain on Concrete',
    lyrics: '[INTRO]\nMoon key turns once under the rain',
    chorus_lines: ['Rain on concrete'],
    key_hook: 'Rain on concrete',
    audio_prompt: { voice_style: 'profile-aligned vocal' },
  }, profile, 'rainy rooftop');

  const repeated = findProfileSeedOveruse({
    title: 'Rain on Concrete',
    lyrics: '[INTRO]\nMoon key turns once under the rain\n[CHORUS]\nMoon key, moon key, open the room',
    chorus_lines: ['Moon key, moon key'],
    key_hook: 'Moon key',
    audio_prompt: { voice_style: 'profile-aligned vocal' },
  }, profile, 'rainy rooftop');

  assert.equal(oneUse.length, 0);
  assert.ok(repeated.some(issue => issue.type === 'catchphrase' && issue.normalized === 'moon key'));
});
