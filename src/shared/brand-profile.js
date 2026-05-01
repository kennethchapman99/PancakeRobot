/**
 * Brand profile loader.
 *
 * The active brand profile is the source of truth. Custom profiles must not be
 * deep-merged into Pancake Robot defaults, because that leaks legacy brand
 * concepts into unrelated brands.
 */

import fs from 'fs';
import { resolveActiveBrandProfilePath, DEFAULT_BRAND_PROFILE_PATH } from './brand-profile-switcher.js';

const FALLBACK_PROFILE = {
  brand_name: 'Default Music Brand',
  app_title: 'Music Pipeline',
  brand_type: 'music',
  brand_description: 'a configurable music brand',
  audience: {
    age_range: 'general',
    description: 'general audience',
    guardrail: 'appropriate for the active audience',
  },
  character: {
    name: 'Default Artist',
    core_concept: 'a configurable artist identity',
    fallback_summary: 'configurable artist identity',
    visual_identity: 'profile-driven visual identity',
    visual_reference: ['Use the active profile visual identity'],
  },
  music: {
    default_style: 'profile-driven pop',
    default_bpm: 100,
    default_key: 'C Major',
    default_prompt: 'Profile-driven complete song arrangement',
    target_length: '2:00-3:30',
    min_words: 120,
    normal_word_range: '160-360',
    first_vocal_by_seconds: 5,
    max_instrumental_intro_seconds: 5,
  },
  lyrics: {
    title_examples: ['A Complete Song'],
    topic_variety: 'profile-driven topic variety',
    required_closing: 'End in a way that matches the active profile',
  },
  visuals: {
    style: 'Bold cartoon illustration, clean black outlines, bright saturated colors — NOT photorealistic',
    palette: {
      syrup_gold: '#D4860A',
      silver_grey: '#B0B8C1',
      sky_blue: '#7EC8E3',
      cream: '#F5ECD7',
      dark_red: '#8B0000',
    },
    negative_prompt: 'text, words, letters, photorealistic, dark colors, scary, violent, blurry',
    text_overlay_style: 'bold rounded font, white fill with thick dark red outline, drop shadow',
  },
  distribution: {
    default_distributor: 'none',
    legacy_distributor: 'none',
    research_default_service: 'none',
    research_default_url: 'none',
    default_artist: 'Default Artist',
    default_album: 'Default Album',
    primary_genre: 'Pop',
    spotify_genres: ['pop'],
    youtube_tags_seed: ['music'],
    apple_music_genres: ['Pop'],
    coppa_status: 'profile-defined',
    content_advisory: 'suitable for all ages',
  },
  ui: {
    sidebar_subtitle: 'Music Studio',
    logo_path: '/logo.png',
  },
};

let cachedProfile = null;

export function loadBrandProfile() {
  if (cachedProfile) return cachedProfile;

  const selection = resolveActiveBrandProfilePath();
  const profilePath = selection.profilePath;

  try {
    if (fs.existsSync(profilePath)) {
      const loaded = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      validateBrandProfile(loaded, profilePath);
      cachedProfile = {
        ...loaded,
        __profile_path: profilePath,
        __profile_relative_path: selection.relativePath,
        __profile_source: selection.source,
      };
      return cachedProfile;
    }

    if (selection.source === 'env') {
      throw new Error(`BRAND_PROFILE_PATH does not exist: ${profilePath}`);
    }
  } catch (err) {
    if (selection.source === 'env') {
      throw new Error(`[BRAND-PROFILE] Failed to load required profile ${profilePath}: ${err.message}`);
    }

    console.warn(`[BRAND-PROFILE] Failed to load active profile ${profilePath}: ${err.message}`);
  }

  try {
    if (fs.existsSync(DEFAULT_BRAND_PROFILE_PATH)) {
      const loaded = JSON.parse(fs.readFileSync(DEFAULT_BRAND_PROFILE_PATH, 'utf8'));
      validateBrandProfile(loaded, DEFAULT_BRAND_PROFILE_PATH);
      cachedProfile = {
        ...loaded,
        __profile_path: DEFAULT_BRAND_PROFILE_PATH,
        __profile_relative_path: 'brand-profile.json',
        __profile_source: 'default_fallback',
      };
      return cachedProfile;
    }
  } catch (err) {
    console.warn(`[BRAND-PROFILE] Failed to load ${DEFAULT_BRAND_PROFILE_PATH}: ${err.message}`);
  }

  validateBrandProfile(FALLBACK_PROFILE, 'built-in fallback profile');
  cachedProfile = {
    ...FALLBACK_PROFILE,
    __profile_path: null,
    __profile_relative_path: null,
    __profile_source: 'built_in_fallback',
  };
  return cachedProfile;
}

export function clearBrandProfileCache() {
  cachedProfile = null;
}

export function validateBrandProfile(profile, profilePath = 'brand profile') {
  const requiredPaths = [
    'brand_name',
    'brand_type',
    'brand_description',
    'audience.age_range',
    'audience.description',
    'audience.guardrail',
    'character.name',
    'character.core_concept',
    'character.fallback_summary',
    'music.default_style',
    'music.default_bpm',
    'music.default_prompt',
    'music.target_length',
    'music.min_words',
    'music.normal_word_range',
    'music.first_vocal_by_seconds',
    'music.max_instrumental_intro_seconds',
    'lyrics.title_examples',
    'lyrics.topic_variety',
    'lyrics.required_closing',
    'distribution.default_artist',
    'distribution.default_album',
    'distribution.primary_genre',
    'distribution.spotify_genres',
    'distribution.youtube_tags_seed',
    'distribution.apple_music_genres',
    'distribution.coppa_status',
    'distribution.content_advisory',
    'ui.sidebar_subtitle',
    'ui.logo_path',
  ];

  const missing = requiredPaths.filter(path => isMissingPath(profile, path));

  if (missing.length > 0) {
    throw new Error(`${profilePath} is missing required field(s): ${missing.join(', ')}`);
  }

  if (!Array.isArray(profile.lyrics.title_examples) || profile.lyrics.title_examples.length === 0) {
    throw new Error(`${profilePath} must define lyrics.title_examples as a non-empty array`);
  }

  if (!Number.isFinite(Number(profile.music.default_bpm))) {
    throw new Error(`${profilePath} must define music.default_bpm as a number`);
  }

  validateStringArray(profile.distribution.spotify_genres, `${profilePath} distribution.spotify_genres`);
  validateStringArray(profile.distribution.youtube_tags_seed, `${profilePath} distribution.youtube_tags_seed`);
  validateStringArray(profile.distribution.apple_music_genres, `${profilePath} distribution.apple_music_genres`);

  if (profile.songwriting) validateSongwriting(profile.songwriting, profilePath);
}

function validateSongwriting(songwriting, profilePath) {
  for (const key of ['allowed_elements', 'forbidden_elements', 'required_elements', 'structure_preferences']) {
    if (songwriting[key] !== undefined) validateStringArray(songwriting[key], `${profilePath} songwriting.${key}`);
  }

  if (songwriting.output_schema !== undefined) {
    const schema = songwriting.output_schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error(`${profilePath} songwriting.output_schema must be an object`);
    }
    for (const [key, value] of Object.entries(schema)) {
      if (typeof value !== 'boolean') {
        throw new Error(`${profilePath} songwriting.output_schema.${key} must be boolean`);
      }
    }
  }
}

function validateStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be a non-empty array of strings`);
  }
}

function isMissingPath(obj, path) {
  const value = path.split('.').reduce((current, key) => current?.[key], obj);
  if (Array.isArray(value)) return value.length === 0;
  return value === undefined || value === null || value === '';
}
