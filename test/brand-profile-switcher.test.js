import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  CONFIG_DIR,
  ACTIVE_BRAND_SELECTION_PATH,
  listBrandProfiles,
  setActiveBrandProfile,
  resolveActiveBrandProfilePath,
} from '../src/shared/brand-profile-switcher.js';
import { clearBrandProfileCache, loadBrandProfile } from '../src/shared/brand-profile.js';

test('brand picker selection is loaded by the active brand profile loader used by generation agents', () => {
  const previousEnvBrandProfilePath = process.env.BRAND_PROFILE_PATH;
  delete process.env.BRAND_PROFILE_PATH;

  const previousSelection = fs.existsSync(ACTIVE_BRAND_SELECTION_PATH)
    ? fs.readFileSync(ACTIVE_BRAND_SELECTION_PATH, 'utf8')
    : null;

  const testDir = path.join(CONFIG_DIR, 'test-fixtures');
  const testProfileRelativePath = 'test-fixtures/switcher-test-brand.json';
  const testProfilePath = path.join(CONFIG_DIR, testProfileRelativePath);

  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(testProfilePath, JSON.stringify(buildTestBrandProfile(), null, 2));

  try {
    const profilesBeforeSelection = listBrandProfiles();
    assert.equal(
      profilesBeforeSelection.some(profile => profile.relative_path === testProfileRelativePath),
      true,
      'brand picker did not discover nested *brand.json file'
    );

    setActiveBrandProfile(testProfileRelativePath);
    clearBrandProfileCache();

    const selection = resolveActiveBrandProfilePath();
    assert.equal(selection.source, 'active_selection');
    assert.equal(selection.relativePath, testProfileRelativePath);

    const activeProfile = loadBrandProfile();
    assert.equal(activeProfile.brand_name, 'Switcher Test Brand');
    assert.equal(activeProfile.distribution.default_artist, 'Switcher Test Artist');
    assert.equal(activeProfile.music.default_style, 'test synth pop');
    assert.equal(activeProfile.__profile_relative_path, testProfileRelativePath);
    assert.equal(activeProfile.__profile_source, 'active_selection');

    const profilesAfterSelection = listBrandProfiles();
    const selectedProfile = profilesAfterSelection.find(profile => profile.relative_path === testProfileRelativePath);
    assert.equal(selectedProfile?.active, true, 'selected brand was not marked active in picker list');
  } finally {
    clearBrandProfileCache();
    if (previousSelection === null) {
      fs.rmSync(ACTIVE_BRAND_SELECTION_PATH, { force: true });
    } else {
      fs.writeFileSync(ACTIVE_BRAND_SELECTION_PATH, previousSelection);
    }

    fs.rmSync(testProfilePath, { force: true });
    try { fs.rmdirSync(testDir); } catch {}

    if (previousEnvBrandProfilePath === undefined) {
      delete process.env.BRAND_PROFILE_PATH;
    } else {
      process.env.BRAND_PROFILE_PATH = previousEnvBrandProfilePath;
    }
    clearBrandProfileCache();
  }
});

function buildTestBrandProfile() {
  return {
    brand_name: 'Switcher Test Brand',
    app_title: 'Switcher Test Brand',
    brand_type: 'test_music_brand',
    brand_description: 'a synthetic test brand used to verify active brand switching',
    audience: {
      age_range: 'all ages',
      description: 'test listeners',
      guardrail: 'safe and testable',
    },
    character: {
      name: 'Switcher Bot',
      core_concept: 'a test character proving brand switching works',
      fallback_summary: 'test character',
      clap_name: 'none',
      visual_identity: 'simple test mascot',
      visual_reference: ['test mascot reference'],
    },
    music: {
      default_style: 'test synth pop',
      default_bpm: 101,
      default_key: 'G Major',
      default_prompt: 'test synth pop with immediate vocals',
      target_length: '1:00-2:00',
      min_words: 80,
      normal_word_range: '100-180',
      first_vocal_by_seconds: 3,
      max_instrumental_intro_seconds: 5,
    },
    lyrics: {
      title_examples: ['Switcher Song'],
      topic_variety: 'tests, switching, profiles',
      required_closing: 'End with a clear test resolution.',
    },
    visuals: {
      style: 'test visual style',
      palette: {},
      negative_prompt: 'none',
      text_overlay_style: 'none',
    },
    distribution: {
      default_distributor: 'test_distributor',
      legacy_distributor: 'none',
      research_default_service: 'none',
      research_default_url: 'none',
      default_artist: 'Switcher Test Artist',
      default_album: 'Switcher Test Album',
      primary_genre: 'Test Genre',
      spotify_genres: ['test genre'],
      youtube_tags_seed: ['test song'],
      apple_music_genres: ['Test Genre'],
      coppa_status: 'not directed to children under 13',
      content_advisory: 'suitable for all ages',
    },
    ui: {
      sidebar_subtitle: 'Test Studio',
      logo_path: '/logo.png',
    },
  };
}
