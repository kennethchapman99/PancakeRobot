/**
 * Product Manager Agent — Distribution research + SEO metadata
 *
 * First run: researches streaming distribution services
 * Per song: generates SEO-optimized metadata.json
 */

import { runAgent, parseAgentJson, loadConfig, saveConfig } from '../shared/managed-agent.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISTRIBUTION_DIR = join(__dirname, '../../output/distribution');
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const BRAND_DESCRIPTION = BRAND_PROFILE.brand_description;
const AUDIENCE = BRAND_PROFILE.audience;
const SONGWRITING = BRAND_PROFILE.songwriting || {};
const DEFAULT_DISTRIBUTOR = BRAND_PROFILE.distribution.default_distributor;
const LEGACY_DISTRIBUTOR = BRAND_PROFILE.distribution.legacy_distributor;
const RESEARCH_DEFAULT_SERVICE = BRAND_PROFILE.distribution.research_default_service;
const RESEARCH_DEFAULT_URL = BRAND_PROFILE.distribution.research_default_url;
const DEFAULT_ARTIST = BRAND_PROFILE.distribution.default_artist;
const DEFAULT_ALBUM = BRAND_PROFILE.distribution.default_album;
const PRIMARY_GENRE = BRAND_PROFILE.distribution.primary_genre;
const SPOTIFY_GENRES = BRAND_PROFILE.distribution.spotify_genres;
const YOUTUBE_TAGS_SEED = BRAND_PROFILE.distribution.youtube_tags_seed;
const APPLE_MUSIC_GENRES = BRAND_PROFILE.distribution.apple_music_genres;
const AUDIENCE_COMPLIANCE_STATUS = BRAND_PROFILE.distribution.coppa_status;
const CONTENT_ADVISORY = BRAND_PROFILE.distribution.content_advisory;

const METADATA_QA_STRICT = process.env.METADATA_QA_STRICT === 'true';

const METADATA_PUBLIC_SCAN_KEYS = new Set([
  'title',
  'artist',
  'artist_name',
  'album',
  'album_title',
  'genre',
  'spotify_genres',
  'youtube_tags',
  'youtube_title',
  'youtube_description',
  'apple_music_genres',
  'mood_tags',
  'bpm',
  'key',
  'duration_seconds',
  'content_advisory',
  'coppa_status',
  'artwork_prompt',
  'video_prompt',
  'short_description',
  'description',
  'tags',
  'lyrics',
  'release_title',
  'track_title',
]);

const METADATA_INTERNAL_IGNORE_KEYS = new Set([
  'compliance_checklist',
  'verification',
  'youtube_kids_verification',
  'metadata_compliance',
  'rationale',
  'design_rationale',
  'reasoning',
  'strategy',
  'performance_benchmarks',
  'distribution_platform_notes',
  'research_reference_distributor',
  'post_launch_momentum',
  'pre_launch_tactics',
  'metadata_optimization',
  'keyword_strategy',
]);

export const PRODUCT_MANAGER_DEF = {
  name: `${BRAND_NAME} Product Manager`,
  system: `You are the product manager and distribution strategist for ${BRAND_NAME}, ${BRAND_DESCRIPTION}.

Your expertise covers:
- Music streaming distribution platforms and their economics
- YouTube SEO for the active audience and genre
- Metadata optimization for discoverability on Spotify, Apple Music, and YouTube
- Release timing strategies for maximum algorithmic boost
- Content compliance requirements from the active brand profile

You research thoroughly and provide specific, actionable recommendations with real numbers.
Always output valid JSON.`,
};

const DISTRIBUTION_RESEARCH_TASK = `Do 1-2 web searches to compare music distribution services for ${BRAND_NAME}, ${BRAND_DESCRIPTION}.

Active audience: ${AUDIENCE.description}
Primary genre: ${PRIMARY_GENRE}
Preferred/default service: ${RESEARCH_DEFAULT_SERVICE}
Legacy service to compare if relevant: ${LEGACY_DISTRIBUTOR}

Focus on services appropriate to this profile. Compare the preferred/default service, legacy service when present, and credible alternatives when relevant.
Key questions: royalty split, days to publish, YouTube Content ID included?

Output compact JSON only:
{
  "services": [
    {
      "name": "...",
      "annual_cost_usd": 0,
      "royalty_split": "...",
      "days_to_publish": "...",
      "youtube_content_id": true,
      "free_tier": true,
      "recommended": true
    }
  ],
  "recommendation": {
    "service": "...",
    "reasoning": "...",
    "signup_url": "..."
  },
  "release_strategy": {
    "best_day": "Friday",
    "singles_vs_album": "singles to start",
    "release_cadence": "1-2 per month"
  }
}`;

/**
 * Research distribution services (first run)
 */
export async function researchDistribution() {
  fs.mkdirSync(DISTRIBUTION_DIR, { recursive: true });

  const result = await runAgent('product-manager', PRODUCT_MANAGER_DEF, DISTRIBUTION_RESEARCH_TASK);

  let research;
  try {
    research = parseAgentJson(result.text);
  } catch {
    research = { raw_text: result.text, parse_error: true };
  }

  // Save markdown report
  const mdPath = join(DISTRIBUTION_DIR, 'distribution-research.md');
  let md = `# Distribution Research\n\n*Researched: ${new Date().toISOString()}*\n\n`;
  if (research.services) {
    for (const svc of research.services) {
      md += `## ${svc.name}\n`;
      md += `- **Annual Cost:** $${svc.annual_cost_usd}\n`;
      md += `- **Royalty Split:** ${svc.royalty_split}\n`;
      md += `- **Days to Publish:** ${svc.days_to_publish}\n`;
      md += `- **YouTube Content ID:** ${svc.youtube_content_id ? '✓' : '✗'}\n`;
      md += `- **Free Tier:** ${svc.free_tier ? '✓' : '✗'}\n`;
      if (svc.pros) md += `- **Pros:** ${svc.pros.join(', ')}\n`;
      if (svc.cons) md += `- **Cons:** ${svc.cons.join(', ')}\n`;
      md += `\n`;
    }
    if (research.recommendation) {
      md += `## ✓ Recommendation\n\n**${research.recommendation.service}** — ${research.recommendation.reasoning}\n\n`;
    }
  } else {
    md += result.text;
  }
  fs.writeFileSync(mdPath, md);

  // Save JSON
  fs.writeFileSync(join(DISTRIBUTION_DIR, 'distribution-research.json'), JSON.stringify(research, null, 2));

  // Update config
  const config = loadConfig();
  config.distribution = {
    profile_brand_name: BRAND_NAME,
    recommended_service: research.recommendation?.service || DEFAULT_DISTRIBUTOR,
    recommended_url: research.recommendation?.signup_url || RESEARCH_DEFAULT_URL,
    release_strategy: research.release_strategy,
    researched_at: new Date().toISOString(),
  };
  saveConfig(config);

  console.log(`\nDistribution research saved to ${mdPath}`);
  return research;
}

/**
 * Generate SEO-optimized metadata for a song
 */
export async function generateMetadata({ songId, title, topic, lyrics, bpm, researchReport }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  const config = loadConfig();
  const releaseStrategy = config.distribution?.profile_brand_name === BRAND_NAME
    ? config.distribution.release_strategy
    : null;

  const metadataTask = buildMetadataTask({ title, topic, lyrics, bpm, releaseStrategy, researchReport });

  // Metadata is structured JSON generation — Haiku is sufficient and cheaper
  const metaDef = { ...PRODUCT_MANAGER_DEF, name: `${BRAND_NAME} Metadata Generator`, model: 'claude-haiku-4-5-20251001', noTools: true };
  const result = await runAgent('product-manager', metaDef, metadataTask);

  let metadata;
  try {
    metadata = parseAgentJson(result.text);
  } catch {
    metadata = {
      title,
      artist: DEFAULT_ARTIST,
      topic,
      parse_error: true,
      raw_text: result.text.substring(0, 500),
    };
  }

  const qaFailures = findMetadataForbiddenElements(metadata);
  if (qaFailures.length > 0) {
    const warning = {
      title,
      warned_at: new Date().toISOString(),
      forbidden_elements: qaFailures,
      note: 'Metadata profile QA is advisory by default. Human review remains the final approval gate.',
      strict_mode: METADATA_QA_STRICT,
    };
    const warningsPath = join(songDir, 'metadata-qa-warnings.json');
    fs.writeFileSync(warningsPath, JSON.stringify(warning, null, 2));

    const message = `Metadata profile QA warning for "${title}". Potential issue(s): ${qaFailures.join(', ')}. Saved ${warningsPath}`;
    if (METADATA_QA_STRICT) {
      throw new Error(message);
    }
    console.warn(`\n⚠ ${message}`);
  }

  const metadataPath = join(songDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`\nMetadata saved to ${metadataPath}`);

  return { metadata, metadataPath };
}

export function buildMetadataTask({ title, topic, lyrics, bpm, releaseStrategy, researchReport } = {}) {
  const spotifyGenresJson = JSON.stringify(SPOTIFY_GENRES);
  const youtubeTagsJson = JSON.stringify(YOUTUBE_TAGS_SEED);
  const appleGenresJson = JSON.stringify(APPLE_MUSIC_GENRES);

  return `Generate comprehensive, SEO-optimized metadata for this ${BRAND_NAME} song.

ACTIVE BRAND PROFILE:
${JSON.stringify({
    brand_name: BRAND_NAME,
    brand_description: BRAND_DESCRIPTION,
    audience: AUDIENCE,
    distribution: BRAND_PROFILE.distribution,
    songwriting: SONGWRITING,
  }, null, 2)}

SONG DETAILS:
Title: ${title}
Topic: ${topic}
BPM: ${bpm || 'unknown'}

LYRICS PREVIEW:
${(lyrics || '').substring(0, 800)}

RELEASE STRATEGY CONTEXT:
${releaseStrategy ? JSON.stringify(releaseStrategy) : 'Use an appropriate release strategy for the active profile audience and genre.'}

RESEARCH CONTEXT:
${researchReport ? JSON.stringify(researchReport).substring(0, 1200) : 'None supplied.'}

Generate metadata optimized for:
1. Spotify discoverability using the active genre and profile audience
2. YouTube SEO for the active profile audience
3. Apple Music categorization

Rules for YouTube title: primary keyword first, max 70 chars, no clickbait. Include "${BRAND_NAME}" only if it appears naturally and adds searchability.
Rules for YouTube tags: start from the active profile youtube_tags_seed, then add relevant tags that do not violate forbidden_elements.
Do not add metadata for audiences, genres, compliance statuses, playlists, or search terms that are not in the active brand profile.
Do not invent algorithm guarantees, stream thresholds, editorial playlist promises, benchmark claims, or distributor changes.
Do not include compliance checklists, marketing plans, tactical calendars, rationales, markdown, code fences, or commentary.
Return exactly one JSON object matching the schema below and nothing else.

Output as JSON:
{
  "title": "${title}",
  "artist": "${DEFAULT_ARTIST}",
  "album": "${DEFAULT_ALBUM}",
  "genre": "${PRIMARY_GENRE}",
  "spotify_genres": ${spotifyGenresJson},
  "youtube_tags": ${youtubeTagsJson},
  "youtube_title": "SEO title here",
  "youtube_description": "Full description with keywords naturally woven in and call-to-action appropriate to the active profile",
  "apple_music_genres": ${appleGenresJson},
  "mood_tags": ["profile-aligned mood"],
  "bpm": ${bpm || BRAND_PROFILE.music.default_bpm},
  "key": "${BRAND_PROFILE.music.default_key || 'profile-aligned key'}",
  "duration_seconds": 180,
  "release_strategy": {
    "best_day": "Friday",
    "best_time_utc": "17:00",
    "reason": "..."
  },
  "thumbnail_specs": {
    "youtube": "1280x720",
    "spotify": "3000x3000",
    "apple_music": "3000x3000"
  },
  "isrc_needed": true,
  "content_advisory": "${CONTENT_ADVISORY}",
  "coppa_status": "${AUDIENCE_COMPLIANCE_STATUS}"
}`;
}

export function findMetadataForbiddenElements(metadata, forbiddenElements = SONGWRITING.forbidden_elements || []) {
  const normalized = normalizeForMetadataMatch(collectMetadataPublicText(metadata));
  return forbiddenElements.filter(element => {
    const term = normalizeForMetadataMatch(element).trim();
    if (!term || term.length < 3) return false;
    return containsUnnegatedMetadataTerm(normalized, term);
  });
}

function collectMetadataPublicText(metadata) {
  const parts = [];
  collectPublicMetadataStrings(metadata, parts);
  return parts.join(' ');
}

function collectPublicMetadataStrings(value, parts, active = false, key = '') {
  const normalizedKey = normalizeMetadataKey(key);
  if (METADATA_INTERNAL_IGNORE_KEYS.has(normalizedKey)) return;

  const shouldScan = active || METADATA_PUBLIC_SCAN_KEYS.has(normalizedKey);

  if (value == null) return;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (shouldScan) parts.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPublicMetadataStrings(item, parts, shouldScan, key);
    return;
  }

  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectPublicMetadataStrings(childValue, parts, shouldScan, childKey);
    }
  }
}

function containsUnnegatedMetadataTerm(normalized, term) {
  const escaped = escapeRegExp(term).replace(/\\ /g, '\\s+');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'g');
  let match;

  while ((match = pattern.exec(normalized)) !== null) {
    const prefix = normalized.slice(Math.max(0, match.index - 80), match.index).trim();
    if (isNegatedMetadataPrefix(prefix)) continue;
    return true;
  }

  return false;
}

function isNegatedMetadataPrefix(prefix) {
  return /(?:^|\s)(?:no|not|never|without|avoid|avoids|free of|does not contain|do not include|must not include)(?:\s+\w+){0,6}\s*$/.test(prefix);
}

function normalizeMetadataKey(key = '') {
  return String(key)
    .replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function normalizeForMetadataMatch(value = '') {
  return ` ${String(value).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
