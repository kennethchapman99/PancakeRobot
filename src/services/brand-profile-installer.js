import fs from 'fs';
import { basename, dirname, join } from 'path';
import { parseAgentJson, runAgent } from '../shared/managed-agent.js';
import {
  clearBrandProfileCache,
  getBrandProfilesDir,
  resolveBrandProfilePath,
  validateBrandProfile,
} from '../shared/brand-profile.js';

const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugifyBrandName(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  if (!slug || !SAFE_SLUG.test(slug)) {
    throw new Error('Brand name must include at least one letter or number.');
  }

  return slug.slice(0, 80).replace(/-+$/g, '') || 'brand-profile';
}

export function sanitizeGeneratedJsonText(text = '') {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

export function parseBrandProfileJson(text = '') {
  const clean = sanitizeGeneratedJsonText(text);
  try {
    return JSON.parse(clean);
  } catch {
    return parseAgentJson(clean);
  }
}

export async function generateBrandProfileFromPrompt({ brandName, brandId, description }) {
  const safeName = String(brandName || '').trim();
  const safeId = String(brandId || slugifyBrandName(safeName)).trim();
  const safeDescription = String(description || '').trim();

  if (!safeName) throw new Error('Brand name is required.');
  if (!safeDescription) throw new Error('Brand description is required.');

  console.log(`[telegram-brand] generating profile ${safeId}`);

  let generated = null;
  try {
    const result = await runAgent('brand-manager', BRAND_PROFILE_CREATOR_DEF, buildGenerationTask({
      brandName: safeName,
      brandId: safeId,
      description: safeDescription,
    }), { maxRetries: 1, maxTokens: 6000 });
    generated = parseBrandProfileJson(result.text);
  } catch (err) {
    console.warn(`[telegram-brand] generation fallback for ${safeId}: ${err.message}`);
  }

  const profile = normalizeBrandProfile({
    generated,
    brandName: safeName,
    brandId: safeId,
    description: safeDescription,
  });

  return repairAndValidateProfile({ profile, brandName: safeName, brandId: safeId, description: safeDescription });
}

export async function repairAndValidateProfile({ profile, brandName, brandId, description }) {
  const normalized = normalizeBrandProfile({ generated: profile, brandName, brandId, description });

  try {
    validateBrandProfile(normalized, `generated brand profile ${brandId}`);
    console.log(`[telegram-brand] validation passed ${brandId}`);
    return normalized;
  } catch (firstError) {
    console.warn(`[telegram-brand] validation repair needed ${brandId}: ${firstError.message}`);

    try {
      const result = await runAgent('brand-manager', BRAND_PROFILE_REPAIR_DEF, buildRepairTask({
        profile: normalized,
        validationError: firstError.message,
      }), { maxRetries: 0, maxTokens: 6000 });
      const repaired = normalizeBrandProfile({
        generated: parseBrandProfileJson(result.text),
        brandName,
        brandId,
        description,
      });
      validateBrandProfile(repaired, `repaired brand profile ${brandId}`);
      console.log(`[telegram-brand] validation passed after repair ${brandId}`);
      return repaired;
    } catch (repairError) {
      const fallback = normalizeBrandProfile({ generated: null, brandName, brandId, description });
      validateBrandProfile(fallback, `fallback brand profile ${brandId}`);
      console.warn(`[telegram-brand] using deterministic fallback ${brandId}: ${repairError.message}`);
      return fallback;
    }
  }
}

export function installBrandProfile({ brandId, profile, overwrite = false }) {
  const safeId = String(brandId || '').trim();
  if (!SAFE_SLUG.test(safeId)) throw new Error(`Unsafe brand profile id: ${safeId}`);

  const profilePath = resolveBrandProfilePath(safeId);
  const expectedDir = getBrandProfilesDir();
  if (dirname(profilePath) !== expectedDir || basename(profilePath) !== `${safeId}.json`) {
    throw new Error(`Unsafe brand profile path resolved for ${safeId}`);
  }

  if (fs.existsSync(profilePath) && !overwrite) {
    const error = new Error(`Brand profile already exists: ${safeId}`);
    error.code = 'BRAND_PROFILE_EXISTS';
    throw error;
  }

  validateBrandProfile(profile, profilePath);
  fs.mkdirSync(expectedDir, { recursive: true });

  const tmpPath = join(expectedDir, `.${safeId}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(profile, null, 2) + '\n');
    validateBrandProfile(JSON.parse(fs.readFileSync(tmpPath, 'utf8')), tmpPath);
    fs.renameSync(tmpPath, profilePath);
    clearBrandProfileCache();
    console.log(`[telegram-brand] installed ${profilePath}`);
    return { brandId: safeId, path: profilePath, profile };
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

export function summarizeBrandProfile(profile = {}, brandId = '') {
  return [
    `Brand name: ${profile.brand_name || brandId}`,
    `Brand ID: ${brandId}`,
    `Audience: ${profile.audience?.age_range || 'unknown'} — ${profile.audience?.description || 'unknown'}`,
    `Music: ${profile.music?.default_style || 'unknown'} @ ${profile.music?.default_bpm || 'unknown'} BPM`,
    `Artist: ${profile.distribution?.default_artist || profile.character?.name || 'unknown'}`,
    `Genre: ${profile.distribution?.primary_genre || 'unknown'}`,
  ].join('\n');
}

function normalizeBrandProfile({ generated, brandName, brandId, description }) {
  const source = generated && typeof generated === 'object' && !Array.isArray(generated) ? generated : {};
  const audience = source.audience && typeof source.audience === 'object' ? source.audience : {};
  const character = source.character && typeof source.character === 'object' ? source.character : {};
  const music = source.music && typeof source.music === 'object' ? source.music : {};
  const lyrics = source.lyrics && typeof source.lyrics === 'object' ? source.lyrics : {};
  const visuals = source.visuals && typeof source.visuals === 'object' ? source.visuals : {};
  const distribution = source.distribution && typeof source.distribution === 'object' ? source.distribution : {};
  const ui = source.ui && typeof source.ui === 'object' ? source.ui : {};

  const characterName = cleanString(character.name) || cleanString(distribution.default_artist) || brandName;
  const defaultAlbum = cleanString(distribution.default_album) || `${brandName} Singles`;
  const primaryGenre = cleanString(distribution.primary_genre) || inferGenre(description);
  const defaultStyle = cleanString(music.default_style) || inferStyle(description);
  const bpm = coerceBpm(music.default_bpm, description);

  const profile = {
    ...source,
    brand_name: brandName,
    brand_type: cleanString(source.brand_type) || 'music',
    brand_description: cleanString(source.brand_description) || description,
    audience: {
      ...audience,
      age_range: cleanString(audience.age_range) || inferAgeRange(description),
      description: cleanString(audience.description) || inferAudience(description),
      guardrail: cleanString(audience.guardrail) || 'Keep every lyric, title, visual, and release asset appropriate for the stated audience and avoid unsafe, hateful, explicit, or exploitative content.',
    },
    character: {
      ...character,
      name: characterName,
      core_concept: cleanString(character.core_concept) || description,
      fallback_summary: cleanString(character.fallback_summary) || `${brandName}: ${description}`.slice(0, 500),
      visual_identity: cleanString(character.visual_identity) || `${brandName} visual identity inspired by: ${description}`,
      visual_reference: normalizeStringArray(character.visual_reference, [`Use ${brandName}'s own brand description as the visual reference.`]),
    },
    music: {
      ...music,
      default_style: defaultStyle,
      default_bpm: bpm,
      default_key: cleanString(music.default_key) || 'C Major',
      default_prompt: cleanString(music.default_prompt) || `Create a complete, polished song for ${brandName}. Style: ${defaultStyle}. Brand description: ${description}`,
      target_length: cleanString(music.target_length) || '2:00-3:00',
      normal_word_range: cleanString(music.normal_word_range) || '160-320',
      first_vocal_by_seconds: Number.isFinite(Number(music.first_vocal_by_seconds)) ? Number(music.first_vocal_by_seconds) : 5,
      max_instrumental_intro_seconds: Number.isFinite(Number(music.max_instrumental_intro_seconds)) ? Number(music.max_instrumental_intro_seconds) : 6,
    },
    lyrics: {
      ...lyrics,
      title_examples: normalizeStringArray(lyrics.title_examples, [`${brandName} Theme`, `The ${brandName} Song`, 'One More Chorus']),
      topic_variety: cleanString(lyrics.topic_variety) || `Songs should explore varied topics through the lens of ${brandName}: ${description}`,
      required_closing: cleanString(lyrics.required_closing) || `End with a memorable, brand-safe closing line that feels unmistakably like ${brandName}.`,
    },
    visuals: {
      ...visuals,
      style: cleanString(visuals.style) || 'Bold, clean, release-ready illustration with strong composition and no readable text baked into the image.',
      palette: normalizePalette(visuals.palette),
      negative_prompt: cleanString(visuals.negative_prompt) || 'text, words, letters, logos, watermark, blurry, low quality, unsafe content, explicit content',
      text_overlay_style: cleanString(visuals.text_overlay_style) || 'bold readable title treatment added by layout layer, not embedded in generated artwork',
    },
    distribution: {
      ...distribution,
      default_distributor: cleanString(distribution.default_distributor) || 'none',
      legacy_distributor: cleanString(distribution.legacy_distributor) || 'none',
      research_default_service: cleanString(distribution.research_default_service) || 'none',
      research_default_url: cleanString(distribution.research_default_url) || 'none',
      default_artist: cleanString(distribution.default_artist) || characterName,
      default_album: defaultAlbum,
      primary_genre: primaryGenre,
      spotify_genres: normalizeStringArray(distribution.spotify_genres, [primaryGenre.toLowerCase(), 'indie pop']),
      youtube_tags_seed: normalizeStringArray(distribution.youtube_tags_seed, [brandId, brandName, primaryGenre.toLowerCase(), 'music']),
      apple_music_genres: normalizeStringArray(distribution.apple_music_genres, [primaryGenre]),
      coppa_status: cleanString(distribution.coppa_status) || inferCoppaStatus(description),
      content_advisory: cleanString(distribution.content_advisory) || 'Brand-safe; no explicit content.',
    },
    ui: {
      ...ui,
      sidebar_subtitle: cleanString(ui.sidebar_subtitle) || `${brandName} Studio`,
      logo_path: cleanString(ui.logo_path) || '/logo.png',
    },
  };

  validateBrandProfile(profile, `normalized brand profile ${brandId}`);
  return profile;
}

function buildGenerationTask({ brandName, brandId, description }) {
  return `Create a complete Pancake Robot brand profile JSON object for a new music brand.

Brand name: ${brandName}
Brand ID: ${brandId}
User description:
${description}

Return JSON only. No markdown fences. No comments.

The JSON must include every required field used by Pancake Robot:
brand_name, brand_type, brand_description, audience.age_range, audience.description, audience.guardrail, character.name, character.core_concept, character.fallback_summary, music.default_style, music.default_bpm, music.default_prompt, music.target_length, music.normal_word_range, music.first_vocal_by_seconds, music.max_instrumental_intro_seconds, lyrics.title_examples, lyrics.topic_variety, lyrics.required_closing, distribution.default_artist, distribution.default_album, distribution.primary_genre, distribution.spotify_genres, distribution.youtube_tags_seed, distribution.apple_music_genres, distribution.coppa_status, distribution.content_advisory, ui.sidebar_subtitle, ui.logo_path.

Use this shape:
{
  "brand_name": "${brandName}",
  "brand_type": "music",
  "brand_description": "",
  "audience": { "age_range": "", "description": "", "guardrail": "" },
  "character": { "name": "", "core_concept": "", "fallback_summary": "", "visual_identity": "", "visual_reference": [] },
  "music": { "default_style": "", "default_bpm": 120, "default_key": "C Major", "default_prompt": "", "target_length": "2:00-3:00", "normal_word_range": "160-320", "first_vocal_by_seconds": 5, "max_instrumental_intro_seconds": 6 },
  "lyrics": { "title_examples": [], "topic_variety": "", "required_closing": "" },
  "visuals": { "style": "", "palette": { "primary": "#111827", "secondary": "#E5E7EB", "accent": "#2563EB", "background": "#F9FAFB" }, "negative_prompt": "", "text_overlay_style": "" },
  "distribution": { "default_artist": "", "default_album": "", "primary_genre": "", "spotify_genres": [], "youtube_tags_seed": [], "apple_music_genres": [], "coppa_status": "", "content_advisory": "" },
  "ui": { "sidebar_subtitle": "", "logo_path": "/logo.png" }
}`;
}

function buildRepairTask({ profile, validationError }) {
  return `Repair this Pancake Robot brand profile JSON so it validates.

Validation error:
${validationError}

Profile JSON:
${JSON.stringify(profile, null, 2)}

Return repaired JSON only. No markdown fences. No comments.`;
}

const BRAND_PROFILE_CREATOR_DEF = {
  name: 'Telegram Brand Profile Creator',
  model: process.env.TELEGRAM_BRAND_PROFILE_MODEL || 'claude-haiku-4-5-20251001',
  noTools: true,
  system: 'You create complete, valid JSON brand profiles for a music-generation pipeline. Return JSON only. Never use markdown fences.',
};

const BRAND_PROFILE_REPAIR_DEF = {
  ...BRAND_PROFILE_CREATOR_DEF,
  name: 'Telegram Brand Profile Repair',
  system: 'You repair JSON brand profiles to satisfy the provided schema validation error. Return JSON only. Never use markdown fences.',
};

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeStringArray(value, fallback) {
  if (Array.isArray(value)) {
    const cleaned = value.map(item => cleanString(item)).filter(Boolean);
    if (cleaned.length) return cleaned;
  }
  return fallback;
}

function normalizePalette(value) {
  const palette = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    primary: cleanHex(palette.primary) || '#111827',
    secondary: cleanHex(palette.secondary) || '#E5E7EB',
    accent: cleanHex(palette.accent) || '#2563EB',
    background: cleanHex(palette.background) || '#F9FAFB',
  };
}

function cleanHex(value) {
  const clean = cleanString(value);
  return /^#[0-9a-fA-F]{6}$/.test(clean) ? clean : '';
}

function inferGenre(description) {
  const lower = String(description || '').toLowerCase();
  if (lower.includes('hip hop') || lower.includes('boom bap') || lower.includes('rap')) return 'Hip-Hop/Rap';
  if (lower.includes('reggae') || lower.includes('dancehall')) return 'Reggae';
  if (lower.includes('country')) return 'Country';
  if (lower.includes('rock')) return 'Rock';
  if (lower.includes('electronic') || lower.includes('synth')) return 'Electronic';
  if (lower.includes('kids') || lower.includes('children')) return 'Children\'s Music';
  return 'Pop';
}

function inferStyle(description) {
  const lower = String(description || '').toLowerCase();
  if (lower.includes('reggae')) return 'modern roots reggae with warm bass, relaxed drums, melodic hooks, and polished vocal production';
  if (lower.includes('boom bap')) return 'classic boom-bap hip hop with crisp drums, sample-inspired textures, and confident vocal delivery';
  if (lower.includes('synth')) return 'bright synth-pop with punchy drums, neon textures, and memorable melodic hooks';
  if (lower.includes('kids') || lower.includes('children')) return 'catchy family-friendly pop with simple hooks, clear vocals, and upbeat production';
  return 'polished profile-driven pop with clear vocals, strong hooks, and release-ready arrangement';
}

function inferAudience(description) {
  const lower = String(description || '').toLowerCase();
  if (lower.includes('kids') || lower.includes('children')) return 'children and families who want catchy, safe, repeatable songs';
  if (lower.includes('adult')) return 'adult listeners who appreciate distinctive, polished independent music';
  return 'general listeners who respond to clear hooks and a distinctive brand point of view';
}

function inferAgeRange(description) {
  const lower = String(description || '').toLowerCase();
  if (lower.includes('kids') || lower.includes('children')) return 'children and families';
  if (lower.includes('adult')) return 'adult';
  return 'general';
}

function inferCoppaStatus(description) {
  const lower = String(description || '').toLowerCase();
  if (lower.includes('kids') || lower.includes('children')) return 'made for kids / family-safe';
  return 'not specifically made for kids';
}

function coerceBpm(value, description) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 60 && parsed <= 220) return parsed;
  const lower = String(description || '').toLowerCase();
  if (lower.includes('high-energy') || lower.includes('dance')) return 124;
  if (lower.includes('reggae')) return 84;
  if (lower.includes('boom bap') || lower.includes('hip hop')) return 92;
  if (lower.includes('ballad') || lower.includes('slow')) return 76;
  return 110;
}
