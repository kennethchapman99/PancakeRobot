/**
 * Brand profile loader.
 *
 * The active brand profile is the source of truth. Custom profiles must not be
 * deep-merged into default profile values, because that leaks brand
 * concepts into unrelated brands.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, extname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
const DEFAULT_PROFILE_PATH = join(ROOT_DIR, 'config/brand-profile.json');
const BRAND_PROFILES_DIR = join(ROOT_DIR, 'config/brand-profiles');
const BRAND_MEDIA_DIR = join(ROOT_DIR, 'config/brand-media');
const ACTIVE_PROFILE_PATH = join(ROOT_DIR, 'config/active-profile.json');
export const DEFAULT_PROFILE_ID = 'default';
const SAFE_PROFILE_ID = /^[a-zA-Z0-9._-]+$/;
const ALLOWED_BRAND_DEFAULT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

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
      primary: '#111827',
      secondary: '#E5E7EB',
      accent: '#2563EB',
      background: '#F9FAFB',
    },
    negative_prompt: 'text, words, letters, photorealistic, dark colors, scary, violent, blurry',
    text_overlay_style: 'bold rounded font, white fill with thick dark red outline, drop shadow',
  },
  media: {
    default_image_url: '',
    default_image_path: '',
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

export function getDefaultBrandProfilePath() {
  return DEFAULT_PROFILE_PATH;
}

export function getBrandProfilesDir() {
  return BRAND_PROFILES_DIR;
}

export function getBrandProfileMediaDir(profileId = DEFAULT_PROFILE_ID) {
  return join(BRAND_MEDIA_DIR, normalizeSafeProfileId(profileId));
}

export function listBrandProfiles() {
  const defaultProfile = loadBrandProfileById(DEFAULT_PROFILE_ID);
  const profiles = [{
    id: DEFAULT_PROFILE_ID,
    name: defaultProfile.display_name || defaultProfile.brand_name || defaultProfile.character?.name || 'Default profile',
    path: DEFAULT_PROFILE_PATH,
    isDefault: true,
  }];

  if (!fs.existsSync(BRAND_PROFILES_DIR)) return profiles;

  const files = fs.readdirSync(BRAND_PROFILES_DIR)
    .filter(file => file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const id = file.slice(0, -'.json'.length);

    try {
      const profilePath = resolveBrandProfilePath(id);
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new Error('profile must be a JSON object');
      }

      profiles.push({
        id,
        name: profile.display_name || profile.brand_name || id,
        path: profilePath,
        isDefault: false,
      });
    } catch (err) {
      console.warn(`[BRAND-PROFILE] Skipping invalid profile ${file}: ${err.message}`);
    }
  }

  return profiles;
}

export function resolveBrandProfilePath(profileId = DEFAULT_PROFILE_ID) {
  const raw = normalizeSafeProfileId(profileId);
  if (raw === DEFAULT_PROFILE_ID) return DEFAULT_PROFILE_PATH;
  return join(BRAND_PROFILES_DIR, `${raw}.json`);
}

export function loadBrandProfileById(profileId = DEFAULT_PROFILE_ID) {
  const profilePath = resolveBrandProfilePath(profileId);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  validateBrandProfile(profile, profilePath);
  return profile;
}

export function saveBrandProfileById(profileId, profile) {
  const profilePath = resolveBrandProfilePath(profileId);
  validateBrandProfile(profile, profilePath);
  fs.mkdirSync(dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n');
}

export function loadBrandProfile() {
  if (cachedProfile) return cachedProfile;

  const explicitProfilePath = process.env.BRAND_PROFILE_PATH;
  const profilePath = explicitProfilePath || DEFAULT_PROFILE_PATH;

  try {
    if (fs.existsSync(profilePath)) {
      const loaded = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      validateBrandProfile(loaded, profilePath);
      cachedProfile = loaded;
      return cachedProfile;
    }

    if (explicitProfilePath) {
      throw new Error(`BRAND_PROFILE_PATH does not exist: ${explicitProfilePath}`);
    }
  } catch (err) {
    if (explicitProfilePath) {
      throw new Error(`[BRAND-PROFILE] Failed to load required profile ${profilePath}: ${err.message}`);
    }

    console.warn(`[BRAND-PROFILE] Failed to load ${profilePath}: ${err.message}`);
  }

  validateBrandProfile(FALLBACK_PROFILE, 'built-in fallback profile');
  cachedProfile = FALLBACK_PROFILE;
  return cachedProfile;
}

export function clearBrandProfileCache() {
  cachedProfile = null;
}

export const DISTROKID_DEFAULT_PROFILE_ARTIST = 'Pancake Robot';
export const DISTROKID_NON_DEFAULT_PROFILE_ARTIST = 'Figment Factory';

/**
 * The brand profile's own DistroKid artist name, or '' when it can't be resolved.
 * The default Pancake Robot profile releases as "Pancake Robot"; every other brand
 * releases under ITS OWN name (distribution.default_artist, falling back to
 * display_name / brand_name). Unlike resolveDistroKidArtist this does NOT fall back
 * to the "Figment Factory" umbrella, so callers can supply their own fallback
 * (e.g. a manifest-provided artist) before reaching for the umbrella.
 */
export function resolveBrandProfileArtistName(profileId) {
  const raw = String(profileId || '').trim();
  if (!raw || raw === DEFAULT_PROFILE_ID) return DISTROKID_DEFAULT_PROFILE_ARTIST;
  try {
    const profile = loadBrandProfileById(raw);
    return String(
      profile?.distribution?.default_artist || profile?.display_name || profile?.brand_name || '',
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Resolves the DistroKid artist name from a release's brand profile id, guaranteed
 * non-empty: the profile's own name, or the "Figment Factory" umbrella as a last
 * resort when a non-default profile can't be read.
 */
export function resolveDistroKidArtist(profileId) {
  return resolveBrandProfileArtistName(profileId) || DISTROKID_NON_DEFAULT_PROFILE_ARTIST;
}

export function getActiveProfileId() {
  try {
    if (fs.existsSync(ACTIVE_PROFILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(ACTIVE_PROFILE_PATH, 'utf8'));
      if (data?.activeProfileId) return String(data.activeProfileId);
    }
  } catch {}
  return DEFAULT_PROFILE_ID;
}

export function setActiveProfileId(profileId) {
  resolveBrandProfilePath(profileId); // throws if unsafe id
  loadBrandProfileById(profileId);    // throws if file missing or invalid
  fs.writeFileSync(ACTIVE_PROFILE_PATH, JSON.stringify({ activeProfileId: profileId }, null, 2) + '\n');
}

export function findBrandProfileDefaultImage(profileId = DEFAULT_PROFILE_ID, profile = null) {
  const safeProfileId = normalizeSafeProfileId(profileId);
  const loadedProfile = profile || safeLoadBrandProfileById(safeProfileId);
  const media = loadedProfile?.media || {};
  const configuredUrl = cleanString(media.default_image_url || loadedProfile?.visuals?.default_image_url || '');
  const configuredPath = cleanString(media.default_image_path || '');

  const resolvedConfiguredPath = resolveConfiguredBrandImagePath(configuredPath, configuredUrl);
  if (resolvedConfiguredPath && fs.existsSync(resolvedConfiguredPath)) {
    return buildBrandDefaultImageResult(safeProfileId, loadedProfile, resolvedConfiguredPath, configuredUrl);
  }

  if (configuredUrl && /^https?:\/\//i.test(configuredUrl)) {
    return {
      path: null,
      url: configuredUrl,
      name: configuredUrl.split('/').pop() || 'brand-default-image',
      profileId: safeProfileId,
      profileName: loadedProfile?.brand_name || safeProfileId,
      source: 'brand_profile_default',
      sourceLabel: `Brand default image: ${loadedProfile?.brand_name || safeProfileId}`,
      generation_source: 'brand_default_image',
    };
  }

  const mediaDir = getBrandProfileMediaDir(safeProfileId);
  const fileName = fs.existsSync(mediaDir)
    ? fs.readdirSync(mediaDir).find(name => /^default-image\.(png|jpe?g|webp)$/i.test(name))
    : null;
  if (!fileName) return null;
  return buildBrandDefaultImageResult(safeProfileId, loadedProfile, join(mediaDir, fileName), brandMediaUrl(safeProfileId, fileName));
}

export function setBrandProfileDefaultImageFile(profileId, fileName) {
  const safeProfileId = normalizeSafeProfileId(profileId);
  const safeFileName = assertSafeBrandImageFileName(fileName);
  const imagePath = join(getBrandProfileMediaDir(safeProfileId), safeFileName);
  if (!fs.existsSync(imagePath)) throw new Error(`Brand default image file does not exist: ${safeFileName}`);

  const profile = loadBrandProfileById(safeProfileId);
  const defaultImage = buildBrandDefaultImageResult(safeProfileId, profile, imagePath, brandMediaUrl(safeProfileId, safeFileName));
  const nextProfile = {
    ...profile,
    media: {
      ...(profile.media || {}),
      default_image_url: defaultImage.url,
      default_image_path: '',
    },
  };
  saveBrandProfileById(safeProfileId, nextProfile);
  return { profile: nextProfile, defaultImage };
}

export function clearBrandProfileDefaultImage(profileId = DEFAULT_PROFILE_ID) {
  const safeProfileId = normalizeSafeProfileId(profileId);
  const mediaDir = getBrandProfileMediaDir(safeProfileId);
  if (fs.existsSync(mediaDir)) {
    for (const name of fs.readdirSync(mediaDir)) {
      if (/^default-image\.(png|jpe?g|webp)$/i.test(name)) fs.unlinkSync(join(mediaDir, name));
    }
  }

  const profile = loadBrandProfileById(safeProfileId);
  const nextProfile = {
    ...profile,
    media: {
      ...(profile.media || {}),
      default_image_url: '',
      default_image_path: '',
    },
  };
  saveBrandProfileById(safeProfileId, nextProfile);
  return { profile: nextProfile, defaultImage: null };
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
  validateDurationWordRangeConsistency(profile.music, profilePath);
}

function parseTargetLengthMaxSeconds(targetLength) {
  if (!targetLength) return null;
  const parts = String(targetLength).split('-');
  const maxPart = parts[parts.length - 1].trim();
  const match = maxPart.match(/^(\d+):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseWordRangeMax(wordRange) {
  if (!wordRange) return null;
  if (Array.isArray(wordRange)) {
    const val = Number(wordRange[wordRange.length - 1]);
    return Number.isFinite(val) && val > 0 ? val : null;
  }
  const parts = String(wordRange).split('-');
  const maxStr = (parts.length >= 2 ? parts[1] : parts[0]).trim();
  const val = Number(maxStr);
  return Number.isFinite(val) && val > 0 ? val : null;
}

export { parseTargetLengthMaxSeconds, parseWordRangeMax };

function validateDurationWordRangeConsistency(music, profilePath) {
  if (!music) return;
  if (music.sparse_format === true) return;

  const targetMaxSecs = parseTargetLengthMaxSeconds(music.target_length);
  const wordMax = parseWordRangeMax(music.normal_word_range);

  if (targetMaxSecs === null || wordMax === null) return;

  if (targetMaxSecs > 240 && wordMax < 450) {
    throw new Error(
      `${profilePath}: music.target_length max exceeds 4:00 but music.normal_word_range max (${wordMax}) is under 450. ` +
      `Songs targeting over 4:00 require at least 450 max words. Increase normal_word_range or set music.sparse_format: true for intentionally sparse formats.`
    );
  }

  if (targetMaxSecs > 180 && wordMax < 380) {
    console.warn(
      `[BRAND-PROFILE] ${profilePath}: target_length max exceeds 3:00 but normal_word_range max (${wordMax}) is under 380. ` +
      `Consider increasing normal_word_range or set music.sparse_format: true for intentionally sparse formats.`
    );
  }
}

function validateSongwriting(songwriting, profilePath) {
  for (const key of ['allowed_elements', 'forbidden_elements', 'required_elements', 'structure_preferences']) {
    const val = songwriting[key];
    if (val !== undefined && !(Array.isArray(val) && val.length === 0)) {
      validateStringArray(val, `${profilePath} songwriting.${key}`);
    }
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

  // Optional enriched performance-identity fields (all backward-compatible).
  if (songwriting.vocal_performance_engine !== undefined) {
    validateVocalPerformanceEngine(songwriting.vocal_performance_engine, profilePath);
  }
  if (songwriting.album_mode_lanes !== undefined) {
    validateAlbumModeLanes(songwriting.album_mode_lanes, profilePath);
  }
  for (const key of ['song_differentiation_rules', 'anti_generic_rules', 'do_not_repeat_across_album', 'hidden_brief_requirements', 'performance_conceit_bank']) {
    const val = songwriting[key];
    if (val !== undefined && !(Array.isArray(val) && val.length === 0)) {
      validateStringArray(val, `${profilePath} songwriting.${key}`);
    }
  }
}

function validateVocalPerformanceEngine(engine, profilePath) {
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) {
    throw new Error(`${profilePath} songwriting.vocal_performance_engine must be an object`);
  }
  for (const key of ['vocal_textures', 'timing_behaviors', 'adlib_behaviors', 'avoid']) {
    if (engine[key] !== undefined) {
      validateStringArray(engine[key], `${profilePath} songwriting.vocal_performance_engine.${key}`);
    }
  }
  for (const key of ['priority']) {
    if (engine[key] !== undefined && typeof engine[key] !== 'string') {
      throw new Error(`${profilePath} songwriting.vocal_performance_engine.${key} must be a string`);
    }
  }
}

function validateAlbumModeLanes(lanes, profilePath) {
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new Error(`${profilePath} songwriting.album_mode_lanes must be a non-empty array`);
  }
  for (const [idx, lane] of lanes.entries()) {
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
      throw new Error(`${profilePath} songwriting.album_mode_lanes[${idx}] must be an object`);
    }
    if (typeof lane.name !== 'string' || !lane.name.trim()) {
      throw new Error(`${profilePath} songwriting.album_mode_lanes[${idx}].name must be a non-empty string`);
    }
    if (typeof lane.description !== 'string' || !lane.description.trim()) {
      throw new Error(`${profilePath} songwriting.album_mode_lanes[${idx}].description must be a non-empty string`);
    }
  }
}

export function hasEnrichedPerformanceFields(profile) {
  const sw = profile?.songwriting || {};
  return !!(sw.vocal_performance_engine || sw.performance_conceit_bank?.length > 0 || sw.album_mode_lanes?.length > 0);
}

function normalizeSafeProfileId(profileId = DEFAULT_PROFILE_ID) {
  const raw = String(profileId || '').trim() || DEFAULT_PROFILE_ID;
  if (
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.includes('..') ||
    !SAFE_PROFILE_ID.test(raw)
  ) {
    throw new Error(`Unsafe brand profile id: ${raw}`);
  }
  return raw;
}

function safeLoadBrandProfileById(profileId) {
  try {
    return loadBrandProfileById(profileId);
  } catch {
    return null;
  }
}

function resolveConfiguredBrandImagePath(configuredPath, configuredUrl) {
  const pathCandidate = resolveConfiguredImagePathValue(configuredPath);
  if (pathCandidate) return pathCandidate;
  return resolveConfiguredImagePathValue(configuredUrl);
}

function resolveConfiguredImagePathValue(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return null;
  if (raw.startsWith('/brand-media/')) {
    const parts = raw.split('/').filter(Boolean).map(part => decodeURIComponent(part));
    if (parts.length !== 3) return null;
    const [, profileId, fileName] = parts;
    return join(getBrandProfileMediaDir(profileId), assertSafeBrandImageFileName(fileName));
  }
  if (raw.startsWith('/base-images/')) {
    const fileName = decodeURIComponent(raw.replace(/^\/base-images\//, ''));
    return join(ROOT_DIR, 'base images', assertSafeBrandImageFileName(fileName));
  }
  if (raw.startsWith('/media/')) {
    const relativePath = decodeURIComponent(raw.replace(/^\/media\//, ''));
    if (relativePath.includes('..')) return null;
    return resolve(ROOT_DIR, 'output', relativePath);
  }
  if (fs.existsSync(raw)) return raw;
  return null;
}

function buildBrandDefaultImageResult(profileId, profile, imagePath, url = '') {
  const fileName = basename(imagePath);
  return {
    path: imagePath,
    url: url || brandMediaUrl(profileId, fileName),
    name: fileName,
    profileId,
    profileName: profile?.brand_name || profileId,
    source: 'brand_profile_default',
    sourceLabel: `Brand default image: ${profile?.brand_name || profileId}`,
    source_label: `Brand default image: ${profile?.brand_name || profileId}`,
    generation_source: 'brand_default_image',
  };
}

function brandMediaUrl(profileId, fileName) {
  return `/brand-media/${encodeURIComponent(normalizeSafeProfileId(profileId))}/${encodeURIComponent(assertSafeBrandImageFileName(fileName))}`;
}

function assertSafeBrandImageFileName(fileName) {
  const raw = String(fileName || '').trim();
  const safe = basename(raw);
  if (!safe || safe !== raw) throw new Error(`Unsafe brand image file name: ${raw}`);
  const ext = extname(safe).toLowerCase();
  if (!ALLOWED_BRAND_DEFAULT_IMAGE_EXTS.has(ext)) throw new Error(`Unsupported brand image extension: ${ext || '(none)'}`);
  return safe;
}

function cleanString(value) {
  return String(value || '').trim();
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
