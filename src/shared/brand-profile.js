/**
 * Brand profile helpers
 *
 * Goal: keep the music production pipeline generic while letting the active
 * brand bible define audience, tone, visual identity, metadata defaults, and
 * render expectations.
 *
 * Runtime overrides are intentionally non-destructive:
 *   BRAND_BIBLE=brand-bibles/mothers-day-sue.md npm run new -- "topic"
 *   node src/orchestrator.js --brand-bible brand-bibles/foo.md --new "topic"
 *   node src/orchestrator.js --brand mothers-day-sue --new "topic"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');

const RUNTIME_KEYS = new Set([
  '_runtime_brand_override',
  '_runtime_brand_source',
  '_base_brand_for_save',
  'active_brand_source',
]);

function cliValue(...names) {
  const argv = process.argv || [];
  for (const name of names) {
    const eqPrefix = `${name}=`;
    const eqMatch = argv.find(arg => arg.startsWith(eqPrefix));
    if (eqMatch) return eqMatch.slice(eqPrefix.length);

    const idx = argv.indexOf(name);
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) {
      return argv[idx + 1];
    }
  }
  return null;
}

function resolvePathMaybeRelative(value) {
  if (!value) return null;
  const expanded = value.startsWith('~/')
    ? path.join(process.env.HOME || '', value.slice(2))
    : value;
  return path.isAbsolute(expanded) ? expanded : path.join(process.cwd(), expanded);
}

function findBrandProfileBySlug(slug) {
  if (!slug) return null;
  const clean = slug.replace(/[^a-zA-Z0-9_-]/g, '');
  const candidates = [
    path.join(process.cwd(), 'brand-bibles', `${clean}.md`),
    path.join(process.cwd(), 'brand-bibles', `${clean}.json`),
    path.join(process.cwd(), 'brand_bibles', `${clean}.md`),
    path.join(process.cwd(), 'brand_bibles', `${clean}.json`),
    path.join(REPO_ROOT, 'brand-bibles', `${clean}.md`),
    path.join(REPO_ROOT, 'brand-bibles', `${clean}.json`),
    path.join(REPO_ROOT, 'brand_bibles', `${clean}.md`),
    path.join(REPO_ROOT, 'brand_bibles', `${clean}.json`),
  ];
  return candidates.find(fs.existsSync) || null;
}

export function resolveRuntimeBrandPath() {
  const explicitPath =
    cliValue('--brand-bible', '--brand-profile') ||
    process.env.BRAND_BIBLE ||
    process.env.BRAND_BIBLE_PATH ||
    process.env.BRAND_PROFILE ||
    process.env.BRAND_PROFILE_PATH;

  if (explicitPath) return resolvePathMaybeRelative(explicitPath);

  const slug = cliValue('--brand') || process.env.BRAND_SLUG;
  return findBrandProfileBySlug(slug);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstMarkdownHeading(markdown) {
  const match = String(markdown || '').match(/^#\s+(.+)$/m);
  return match?.[1]?.replace(/brand bible/i, '').replace(/[#:]/g, '').trim() || null;
}

function normalizeBrandProfile(input, { sourcePath } = {}) {
  const parsed = typeof input === 'string' ? safeJsonParse(input) : input;

  if (parsed && typeof parsed === 'object') {
    const brandData = parsed.brand_data || parsed.brand || parsed;
    const normalized = { ...brandData };

    normalized.identity = {
      ...(brandData.identity || {}),
      name: brandData.identity?.name || brandData.character?.name || parsed.name || brandData.name,
      artist_name: brandData.identity?.artist_name || brandData.artist_name || brandData.character?.name || parsed.artist,
      audience: brandData.identity?.audience || brandData.audience || brandData.rules?.age_guardrails,
      genre: brandData.identity?.genre || brandData.genre,
      album: brandData.identity?.album || brandData.album,
    };

    if (parsed.brand_bible_markdown && !normalized.brand_bible_markdown) {
      normalized.brand_bible_markdown = parsed.brand_bible_markdown;
    }

    normalized.source_path = sourcePath || parsed.source_path;
    return normalized;
  }

  const rawText = String(input || '').trim();
  const inferredName = firstMarkdownHeading(rawText) || path.basename(sourcePath || 'custom-brand', path.extname(sourcePath || ''));

  return {
    identity: {
      name: inferredName,
      artist_name: inferredName,
      audience: 'Defined by the brand bible markdown',
      genre: 'Defined by the brand bible markdown',
      album: `${inferredName} Singles`,
    },
    brand_bible_markdown: rawText,
    raw_text: rawText,
    source_path: sourcePath,
  };
}

export function loadRuntimeBrandOverride() {
  const brandPath = resolveRuntimeBrandPath();
  if (!brandPath) return null;

  if (!fs.existsSync(brandPath)) {
    throw new Error(`Brand bible override not found: ${brandPath}`);
  }

  const text = fs.readFileSync(brandPath, 'utf8');
  const brand = normalizeBrandProfile(text, { sourcePath: brandPath });
  brand.runtime_override = true;
  return brand;
}

export function applyRuntimeBrandOverride(config) {
  const runtimeBrand = loadRuntimeBrandOverride();
  if (!runtimeBrand) return config;

  return {
    ...config,
    _runtime_brand_override: true,
    _runtime_brand_source: runtimeBrand.source_path,
    _base_brand_for_save: config.brand || null,
    active_brand_source: runtimeBrand.source_path,
    brand: runtimeBrand,
  };
}

export function stripRuntimeBrandFields(config) {
  const clean = { ...config };

  if (clean._runtime_brand_override) {
    clean.brand = clean._base_brand_for_save || null;
  }

  for (const key of RUNTIME_KEYS) delete clean[key];
  return clean;
}

export function getBrandDisplayName(brandData) {
  return brandData?.identity?.name || brandData?.character?.name || brandData?.name || 'Active Music Brand';
}

export function getArtistName(brandData) {
  return brandData?.identity?.artist_name || brandData?.artist_name || getBrandDisplayName(brandData);
}

export function getAlbumName(brandData) {
  return brandData?.identity?.album || brandData?.album || `${getArtistName(brandData)} Singles`;
}

export function getBrandAudience(brandData) {
  return brandData?.identity?.audience || brandData?.audience || brandData?.rules?.age_guardrails || 'Defined by active brand bible';
}

export function getBrandGenre(brandData) {
  return brandData?.identity?.genre || brandData?.genre || brandData?.music_dna?.genre || 'brand-defined music';
}

export function getProductionDefaults(brandData = {}) {
  const defaults = brandData.production_defaults || {};
  return {
    target_length: defaults.target_length || brandData.music_dna?.target_length || '1:30-3:00',
    min_words: defaults.min_words || 120,
    max_words: defaults.max_words || 320,
    first_vocal_by_seconds: defaults.first_vocal_by_seconds ?? 5,
    max_instrumental_intro_seconds: defaults.max_instrumental_intro_seconds ?? 5,
    title_must_open: defaults.title_must_open ?? true,
    title_must_repeat_in_chorus: defaults.title_must_repeat_in_chorus ?? true,
  };
}

export function isKidsBrand(brandData = {}) {
  const haystack = [
    getBrandAudience(brandData),
    getBrandGenre(brandData),
    brandData.rules?.age_guardrails,
    brandData.voice?.vocabulary_level,
    brandData.brand_bible_markdown,
    brandData.raw_text,
  ].filter(Boolean).join(' ').toLowerCase();

  return /\b(kids?|children|childrens|children's|ages?\s*\d|kindergarten|family-friendly|under\s*13)\b/.test(haystack);
}

export function buildBrandContext(brandData, { maxChars = 6000 } = {}) {
  if (!brandData) return 'No brand bible loaded. Use neutral, high-quality music production defaults.';

  const context = {
    identity: brandData.identity || {},
    character: brandData.character,
    voice: brandData.voice,
    music_dna: brandData.music_dna,
    rules: brandData.rules,
    production_defaults: getProductionDefaults(brandData),
    visual_identity: brandData.visual_identity,
    thumbnail_prompt_base: brandData.thumbnail_prompt_base,
    brand_bible_markdown: brandData.brand_bible_markdown || brandData.raw_text,
  };

  return JSON.stringify(context, null, 2).substring(0, maxChars);
}
