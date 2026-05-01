import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sueProfilePath = path.join(repoRoot, 'config/brand-profiles/my-new-brand.json');
const defaultProfilePath = path.join(repoRoot, 'config/brand-profile.json');

test('Sue profile forbidden-element QA catches contaminated lyricist output and accepts clean output', async () => {
  process.env.BRAND_PROFILE_PATH = sueProfilePath;
  const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
  clearBrandProfileCache();

  const { findForbiddenElementContamination } = await import(`../src/agents/lyricist.js?sueQa=${Date.now()}`);

  const dirty = {
    title: 'For Sue',
    lyrics: '[CHORUS]\nFor Sue, (clap clap), beep boop, pancake morning',
    key_hook: 'For Sue',
    chorus_lines: ['For Sue'],
    audio_prompt: { special_notes: 'beep boop' },
    metadata: { youtube_tags: ['pancake'] },
  };
  assert.deepEqual(
    findForbiddenElementContamination(dirty).map(item => item.element).sort(),
    ['beep boop', 'claps', 'pancake metaphors', 'pancakes'].sort()
  );

  const clean = {
    title: 'For Sue',
    lyrics: '[INTRO]\nFor Sue, eighteen years of love began at home\n[CHORUS]\nFor Sue, the heart of all we know',
    key_hook: 'For Sue, the heart of all we know',
    chorus_lines: ['For Sue, the heart of all we know'],
    audio_prompt: { style: 'tear-jerking emotional piano ballad' },
  };
  assert.deepEqual(findForbiddenElementContamination(clean), []);
});

test('default profile drives Pancake Robot songwriting mechanics through JSON', () => {
  const profile = JSON.parse(fs.readFileSync(defaultProfilePath, 'utf8'));
  assert.equal(profile.brand_name, 'Pancake Robot');
  assert.equal(profile.songwriting.output_schema.include_physical_action_cue, true);
  assert.equal(profile.songwriting.output_schema.include_funny_long_word, true);

  for (const expected of ['claps', 'physical action cues', 'call-and-response', 'robot sounds', 'pancake imagery', 'open question ending']) {
    assert.equal(profile.songwriting.allowed_elements.includes(expected), true, `missing ${expected}`);
  }
});

test('Sue metadata prompt uses active distribution profile and avoids positive kids metadata framing', async () => {
  process.env.BRAND_PROFILE_PATH = sueProfilePath;
  const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
  clearBrandProfileCache();

  const { buildMetadataTask } = await import(`../src/agents/product-manager.js?sueMeta=${Date.now()}`);
  const prompt = buildMetadataTask({
    title: 'For Sue',
    topic: 'title: For Sue',
    lyrics: 'For Sue, Ken and the kids sing with gratitude.',
    bpm: 72,
  });

  for (const expected of ['Singer-Songwriter', 'adult contemporary', "mother's day song", 'Sue Wong', 'Ken for Sue']) {
    assert.equal(prompt.includes(expected), true, `prompt missing ${expected}`);
  }

  assert.equal(/include at least 20 highly specific children's music search terms/i.test(prompt), false);
  assert.equal(/"youtube_tags_seed":\s*\[[^\]]*preschool/i.test(prompt), false);
  assert.equal(/"youtube_tags_seed":\s*\[[^\]]*toddler/i.test(prompt), false);
  assert.equal(/Generate metadata optimized for:[\s\S]*kids action/i.test(prompt), false);
});

test('metadata QA ignores internal compliance notes and negated checklist language', async () => {
  process.env.BRAND_PROFILE_PATH = defaultProfilePath;
  const { clearBrandProfileCache } = await import('../src/shared/brand-profile.js');
  clearBrandProfileCache();

  const { findMetadataForbiddenElements } = await import(`../src/agents/product-manager.js?metadataQa=${Date.now()}`);

  const metadataWithInternalChecklist = {
    title: 'Smooth In The Morning',
    artist: 'Pancake Robot',
    youtube_title: 'Morning Routine Song for Kids | Pancake Robot',
    youtube_description: 'A cheerful routine song for movement and breakfast time.',
    compliance_checklist: {
      youtube_kids_verification: [
        'No unsafe or scary imagery',
        'No adult themes',
        'No sarcasm that kids cannot parse',
      ],
    },
    rationale: 'This avoids unsafe or scary imagery and avoids adult themes.',
    performance_benchmarks: {
      note: 'No sarcasm that kids cannot parse.',
    },
  };

  assert.deepEqual(findMetadataForbiddenElements(metadataWithInternalChecklist), []);

  const publicFailure = {
    title: 'Smooth In The Morning',
    artist: 'Pancake Robot',
    youtube_description: 'This video includes unsafe or scary imagery.',
  };
  assert.deepEqual(findMetadataForbiddenElements(publicFailure), ['unsafe or scary imagery']);

  const negatedPublicCopy = {
    title: 'Smooth In The Morning',
    artist: 'Pancake Robot',
    youtube_description: 'No unsafe or scary imagery, no adult themes, and no sarcasm that kids cannot parse.',
  };
  assert.deepEqual(findMetadataForbiddenElements(negatedPublicCopy), []);
});

test('runtime static leak scan blocks hard-coded legacy assumptions in generic modules', () => {
  const targets = [
    'src/agents/lyricist.js',
    'src/agents/product-manager.js',
    'src/agents/music-generator.js',
    'src/shared/song-qa.js',
    'src/shared/suggest.js',
  ];
  const banned = [
    /production-ready children's song/i,
    /children's music brand/i,
    /Pancake Robot Flip/i,
    /beep boop/i,
    /\bpancake\b/i,
    /\bpreschool\b/i,
    /\btoddler\b/i,
  ];

  const leaks = [];
  for (const rel of targets) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const pattern of banned) {
      if (pattern.test(text)) leaks.push(`${rel}: ${pattern}`);
    }
  }

  assert.deepEqual(leaks, []);
});

test('Sue profile direct imports succeed', () => {
  const env = { ...process.env, BRAND_PROFILE_PATH: sueProfilePath };
  for (const modulePath of ['src/agents/lyricist.js', 'src/agents/product-manager.js', 'src/agents/music-generator.js']) {
    const out = execFileSync(process.execPath, ['-e', `import('./${modulePath}').then(()=>console.log('OK'))`], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.match(out, /OK/);
  }
});
