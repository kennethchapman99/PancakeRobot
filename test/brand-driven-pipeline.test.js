import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const defaultProfilePath = path.join(repoRoot, 'config/brand-profile.json');
const baseProfile = JSON.parse(fs.readFileSync(defaultProfilePath, 'utf8'));

function isolatedProfile(overrides = {}) {
  const profile = structuredClone(baseProfile);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  profile.brand_name = overrides.brand_name || `Isolated Test Artist ${id}`;
  profile.app_title = overrides.app_title || `Isolated Test Studio ${id}`;
  profile.brand_type = overrides.brand_type || 'test music brand';
  profile.brand_description = overrides.brand_description || `profile-driven isolated test brand ${id}`;
  profile.audience = {
    ...profile.audience,
    age_range: overrides.audience?.age_range || 'profile-defined test audience',
    description: overrides.audience?.description || `profile-defined test listeners ${id}`,
    guardrail: overrides.audience?.guardrail || `follow isolated profile guardrail ${id}`,
  };
  profile.character = {
    ...profile.character,
    name: overrides.character?.name || `Isolated Test Character ${id}`,
    core_concept: overrides.character?.core_concept || `isolated test character concept ${id}`,
    fallback_summary: overrides.character?.fallback_summary || `isolated test fallback ${id}`,
  };
  profile.music = {
    ...profile.music,
    default_style: overrides.music?.default_style || `isolated test style ${id}`,
    default_prompt: overrides.music?.default_prompt || `isolated test arrangement ${id}`,
  };
  profile.distribution = {
    ...profile.distribution,
    default_artist: overrides.distribution?.default_artist || `Isolated Distribution Artist ${id}`,
    default_album: overrides.distribution?.default_album || `Isolated Distribution Album ${id}`,
    primary_genre: overrides.distribution?.primary_genre || `Isolated Genre ${id}`,
    spotify_genres: overrides.distribution?.spotify_genres || [`isolated-spotify-${id}`],
    youtube_tags_seed: overrides.distribution?.youtube_tags_seed || [`isolated-youtube-${id}`],
    apple_music_genres: overrides.distribution?.apple_music_genres || [`Isolated Apple Genre ${id}`],
    coppa_status: overrides.distribution?.coppa_status || `isolated compliance ${id}`,
    content_advisory: overrides.distribution?.content_advisory || `isolated advisory ${id}`,
  };
  profile.songwriting = {
    ...(profile.songwriting || {}),
    ...(overrides.songwriting || {}),
  };

  return profile;
}

function writeTempProfile(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-pipeline-profile-'));
  const profilePath = path.join(dir, 'active-profile.json');
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  return profilePath;
}

async function clearProfileCache() {
  const { clearBrandProfileCache } = await import(`../src/shared/brand-profile.js?clear=${Date.now()}`);
  clearBrandProfileCache();
}

test('active profile forbidden-element QA is driven by profile data only', async () => {
  const forbiddenElements = ['forbidden echo phrase', 'legacy mascot marker', 'off profile cue'];
  const profile = isolatedProfile({
    songwriting: {
      ...(baseProfile.songwriting || {}),
      forbidden_elements: forbiddenElements,
    },
  });
  process.env.BRAND_PROFILE_PATH = writeTempProfile(profile);
  await clearProfileCache();

  const { findForbiddenElementContamination } = await import(`../src/agents/lyricist.js?profileQa=${Date.now()}`);

  const dirty = {
    title: 'Profile QA Song',
    lyrics: `[CHORUS]\nThis line says ${forbiddenElements[0]} and ${forbiddenElements[1]}`,
    key_hook: 'Profile QA Song',
    chorus_lines: ['Profile QA Song'],
    audio_prompt: { special_notes: forbiddenElements[2] },
  };

  assert.deepEqual(
    findForbiddenElementContamination(dirty).map(item => item.element).sort(),
    forbiddenElements.sort()
  );

  const clean = {
    title: 'Profile QA Song',
    lyrics: '[INTRO]\nProfile QA Song begins with clean active-profile language\n[CHORUS]\nProfile QA Song keeps the profile intact',
    key_hook: 'Profile QA Song keeps the profile intact',
    chorus_lines: ['Profile QA Song keeps the profile intact'],
    audio_prompt: { style: profile.music.default_style },
  };

  assert.deepEqual(findForbiddenElementContamination(clean), []);
});

test('default profile validates required songwriting mechanics from its own JSON', () => {
  assert.equal(typeof baseProfile.brand_name, 'string');
  assert.equal(Boolean(baseProfile.brand_name.trim()), true);
  assert.equal(typeof baseProfile.songwriting.output_schema.include_physical_action_cue, 'boolean');
  assert.equal(typeof baseProfile.songwriting.output_schema.include_funny_long_word, 'boolean');

  for (const requiredField of ['allowed_elements', 'forbidden_elements', 'required_elements', 'structure_preferences']) {
    assert.equal(Array.isArray(baseProfile.songwriting[requiredField]), true, `${requiredField} must be an array`);
  }
});

test('metadata prompt uses active distribution profile without importing inactive profile values', async () => {
  const profile = isolatedProfile({
    brand_name: 'Metadata Fixture Brand',
    brand_description: 'metadata fixture brand description',
    audience: {
      description: 'metadata fixture audience',
      guardrail: 'metadata fixture guardrail',
    },
    distribution: {
      default_artist: 'Metadata Fixture Artist',
      default_album: 'Metadata Fixture Album',
      primary_genre: 'Metadata Fixture Genre',
      spotify_genres: ['metadata-fixture-spotify'],
      youtube_tags_seed: ['metadata-fixture-youtube'],
      apple_music_genres: ['Metadata Fixture Apple'],
      coppa_status: 'metadata fixture compliance',
      content_advisory: 'metadata fixture advisory',
    },
    songwriting: {
      ...(baseProfile.songwriting || {}),
      forbidden_elements: ['metadata forbidden fixture'],
    },
  });

  process.env.BRAND_PROFILE_PATH = writeTempProfile(profile);
  await clearProfileCache();

  const { buildMetadataTask } = await import(`../src/agents/product-manager.js?profileMeta=${Date.now()}`);
  const prompt = buildMetadataTask({
    title: 'Metadata Fixture Song',
    topic: 'profile-driven metadata fixture topic',
    lyrics: 'Metadata Fixture Song uses only active profile terms.',
    bpm: 88,
  });

  for (const expected of [
    profile.brand_name,
    profile.brand_description,
    profile.audience.description,
    profile.distribution.default_artist,
    profile.distribution.default_album,
    profile.distribution.primary_genre,
    profile.distribution.spotify_genres[0],
    profile.distribution.youtube_tags_seed[0],
    profile.distribution.apple_music_genres[0],
    profile.distribution.content_advisory,
    profile.distribution.coppa_status,
  ]) {
    assert.equal(prompt.includes(expected), true, `prompt missing active profile value: ${expected}`);
  }

  const inactiveDistributionValues = [
    baseProfile.distribution.default_artist,
    baseProfile.distribution.default_album,
    baseProfile.distribution.primary_genre,
    ...(baseProfile.distribution.spotify_genres || []),
    ...(baseProfile.distribution.youtube_tags_seed || []),
    ...(baseProfile.distribution.apple_music_genres || []),
  ]
    .filter(Boolean)
    .filter(value => !JSON.stringify(profile).includes(value));

  for (const inactiveValue of inactiveDistributionValues.slice(0, 10)) {
    assert.equal(prompt.includes(inactiveValue), false, `prompt leaked inactive profile value: ${inactiveValue}`);
  }
});

test('metadata QA ignores internal compliance notes and negated checklist language', async () => {
  const forbiddenElements = ['unsafe fixture imagery', 'adult fixture theme', 'unparseable fixture sarcasm'];
  const profile = isolatedProfile({
    songwriting: {
      ...(baseProfile.songwriting || {}),
      forbidden_elements: forbiddenElements,
    },
  });

  process.env.BRAND_PROFILE_PATH = writeTempProfile(profile);
  await clearProfileCache();

  const { findMetadataForbiddenElements } = await import(`../src/agents/product-manager.js?metadataQa=${Date.now()}`);

  const metadataWithInternalChecklist = {
    title: 'Metadata QA Song',
    artist: profile.distribution.default_artist,
    youtube_title: 'Metadata QA Song',
    youtube_description: 'A profile-aligned description for active listeners.',
    compliance_checklist: {
      verification: forbiddenElements.map(item => `No ${item}`),
    },
    rationale: `This avoids ${forbiddenElements[0]} and avoids ${forbiddenElements[1]}.`,
    performance_benchmarks: {
      note: `No ${forbiddenElements[2]}.`,
    },
  };

  assert.deepEqual(findMetadataForbiddenElements(metadataWithInternalChecklist), []);

  const publicFailure = {
    title: 'Metadata QA Song',
    artist: profile.distribution.default_artist,
    youtube_description: `This public copy includes ${forbiddenElements[0]}.`,
  };
  assert.deepEqual(findMetadataForbiddenElements(publicFailure), [forbiddenElements[0]]);

  const negatedPublicCopy = {
    title: 'Metadata QA Song',
    artist: profile.distribution.default_artist,
    youtube_description: `No ${forbiddenElements[0]}, no ${forbiddenElements[1]}, and no ${forbiddenElements[2]}.`,
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

test('active profile direct imports succeed with isolated profile path', () => {
  const profile = isolatedProfile();
  const env = { ...process.env, BRAND_PROFILE_PATH: writeTempProfile(profile) };

  for (const modulePath of ['src/agents/lyricist.js', 'src/agents/product-manager.js', 'src/agents/music-generator.js']) {
    const out = execFileSync(process.execPath, ['-e', `import('./${modulePath}').then(()=>console.log('OK'))`], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.match(out, /OK/);
  }
});
