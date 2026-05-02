/**
 * Song Suggester (shared, callable from CLI or web)
 *
 * Generates 5 next-song recommendations using the product-manager agent.
 * Accepts an `onLog(msg)` callback so it can stream output to any consumer
 * (console, SSE stream, etc).
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);

const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import fs from 'fs';
import { runAgent, parseAgentJson } from './managed-agent.js';
import { loadBrandProfile, loadBrandProfileById } from './brand-profile.js';
import { getAllSongs, createIdea } from './db.js';

const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const AUDIENCE_AGE_RANGE = BRAND_PROFILE.audience.age_range;
const AUDIENCE_DESCRIPTION = BRAND_PROFILE.audience.description;
const CHARACTER_NAME = BRAND_PROFILE.character.name;
const CHARACTER_FALLBACK_SUMMARY = BRAND_PROFILE.character.fallback_summary;
const TITLE_EXAMPLES = BRAND_PROFILE.lyrics.title_examples;
const TOPIC_VARIETY = BRAND_PROFILE.lyrics.topic_variety;
const SONGWRITING = BRAND_PROFILE.songwriting || {};

export function normalizeThemePrompt(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

export function buildThemeGuidance(themePrompt) {
  const normalizedTheme = normalizeThemePrompt(themePrompt);

  if (!normalizedTheme) {
    return '\nUSER THEME / VIBE GUIDANCE:\nNo theme was provided. Generate unrelated fresh ideas with strong variety. Set theme_alignment to null for every recommendation.';
  }

  return `\nUSER THEME / VIBE GUIDANCE — HARD BATCH CONSTRAINT:\nThe user wants this entire batch of ideas to share this common theme, vibe, or creative lane:\n"${normalizedTheme}"\n\nNon-negotiable requirements:\n- Every recommendation must be rooted in this exact theme/vibe.\n- Do not satisfy the theme with only rank 1. Ranks 1, 2, 3, 4, and 5 must each visibly fit the theme.\n- Distinct ideas are welcome, but distinct means different angles inside the same theme — not unrelated topics.\n- For every recommendation, include a non-empty theme_alignment field explaining how that specific idea fits the theme.\n- Before outputting JSON, audit all 5 recommendations and replace anything that is not clearly aligned to the theme.\n- Do not hard-code canned categories; interpret the user's wording naturally while preserving brand, audience, title, and duplicate-topic rules.`;
}

export function buildSuggestTask({ songs = [], researchSummary = '', themePrompt = '', currentDate = new Date(), profile = BRAND_PROFILE } = {}) {
  const normalizedTheme = normalizeThemePrompt(themePrompt);

  const brandName = profile.brand_name;
  const characterName = profile.character?.name;
  const characterFallbackSummary = profile.character?.fallback_summary;
  const audienceDescription = profile.audience?.description;
  const titleExamplesList = profile.lyrics?.title_examples || [];
  const topicVariety = profile.lyrics?.topic_variety;
  const songwriting = profile.songwriting || {};

  const existingSongs = songs.length > 0
    ? `\nEXISTING SONGS (avoid repeating these themes):\n${songs.map(s => `- "${s.title}" (${s.topic}) — score: ${s.brand_score || '?'}`).join('\n')}`
    : '\nEXISTING SONGS: None yet — this will be the first!';

  const brandSummary = `Brand: ${brandName} — ${characterFallbackSummary}; audience: ${audienceDescription}`;
  const titleExamples = titleExamplesList.map(t => `"${t}"`).join(', ');
  const themeGuidance = buildThemeGuidance(normalizedTheme);
  const currentMonth = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return `You are the song strategist for ${brandName}, ${profile.brand_description}.

${brandSummary}
${existingSongs}
${researchSummary}
${themeGuidance}

ACTIVE SONGWRITING RULES:
${JSON.stringify(songwriting, null, 2)}

Recommend the 5 best next song topics. For each:
1. Pick topics that are NOT already covered by existing songs
2. Prioritize high replay-ability and viral potential
3. Consider the season/timing (current date: ${currentMonth})
4. Mix educational + pure fun topics
5. Think BIG on variety — ${topicVariety}
6. If theme guidance is provided, keep all 5 ideas aligned to that same theme while making each idea distinct
7. If theme guidance is provided, do not include any recommendation unless you can explain its theme fit in theme_alignment

TITLE RULES — this is critical:
- Most titles should be creative and topic-first: ${titleExamples}
- Do NOT default to "${characterName} [topic]" — that pattern is overused
- The character name "${characterName}" should appear in a title at most once per 5 songs, and only when it genuinely adds humor or meaning
- Great titles are specific, memorable, and aligned to the active brand profile.

Output as JSON:
{
  "recommendations": [
    {
      "rank": 1,
      "title": "Creative topic-first title (NOT '${characterName} ___')",
      "topic": "One-line topic description for --new command",
      "why": "Why this will work right now (2-3 sentences)",
      "hook_idea": "The key lyrical or musical hook concept",
      "profile_specific_element": "A profile-aligned detail, motif, memory, or mechanic",
      "theme_alignment": ${normalizedTheme ? '"How this specific idea clearly fits the user-provided theme"' : 'null'},
      "bpm_target": 110,
      "urgency": "evergreen|seasonal|trending"
    }
  ],
  "recommended_next": "topic string to paste directly into --new command"
}`;
}

export function buildThemeAuditTask({ themePrompt, suggestions }) {
  const normalizedTheme = normalizeThemePrompt(themePrompt);

  return `You are the final QA auditor for themed song-idea generation.

Theme/vibe that MUST apply to every idea:
"${normalizedTheme}"

Draft JSON to audit:
${JSON.stringify(suggestions, null, 2)}

Audit and repair instructions:
- Return the same JSON shape with exactly 5 recommendations.
- Every recommendation must clearly fit the theme/vibe, not only the first recommendation.
- If any recommendation is off-theme, replace it with a new distinct idea that fits the theme.
- Preserve strong brand fit, audience fit, title quality, and duplicate-topic avoidance.
- Every recommendation must include a non-empty theme_alignment field explaining how that specific idea fits the theme.
- recommended_next must be a topic string from the strongest themed recommendation.
- Output valid JSON only. No markdown, no commentary.`;
}

export function getThemeValidationFailures(suggestions, themePrompt) {
  const normalizedTheme = normalizeThemePrompt(themePrompt);
  if (!normalizedTheme) return [];

  const failures = [];
  const recommendations = suggestions?.recommendations;

  if (!Array.isArray(recommendations)) {
    return ['Missing recommendations array'];
  }

  if (recommendations.length !== 5) {
    failures.push(`Expected exactly 5 recommendations, got ${recommendations.length}`);
  }

  recommendations.forEach((rec, index) => {
    const rank = rec?.rank || index + 1;
    if (!normalizeThemePrompt(rec?.theme_alignment)) {
      failures.push(`Recommendation ${rank} is missing theme_alignment`);
    }
  });

  return failures;
}

async function auditThemedSuggestions({ suggestions, themePrompt, suggesterDef, log }) {
  log('🧭 Auditing recommendations against the theme...');

  const auditTask = buildThemeAuditTask({ themePrompt, suggestions });
  const auditResult = await runAgent('product-manager', suggesterDef, auditTask);
  const auditedSuggestions = parseAgentJson(auditResult.text);
  const failures = getThemeValidationFailures(auditedSuggestions, themePrompt);

  if (failures.length > 0) {
    throw new Error(`Theme audit failed: ${failures.join('; ')}`);
  }

  log('✅ Theme audit passed for all 5 recommendations.');
  return auditedSuggestions;
}

/**
 * Run the song suggester pipeline.
 * @param {function} onLog  - called with each log line string
 * @param {object} options  - optional controls, including { themePrompt }
 * @returns {object}        - { recommendations, recommended_next }
 */
export async function runSuggestPipeline(onLog = () => {}, options = {}) {
  const log = (msg) => onLog(msg);
  const themePrompt = normalizeThemePrompt(options.themePrompt);
  const brandProfileId = options.brandProfileId || null;

  log('🔍 Loading brand profile and catalog...');
  const profile = brandProfileId ? loadBrandProfileById(brandProfileId) : BRAND_PROFILE;
  const songs = getAllSongs();

  if (themePrompt) {
    log(`🎯 Theme guidance: ${themePrompt}`);
  }

  // Load research if available
  let researchSummary = '';
  const researchPath = join(__dirname, '../../output/research/research-report.json');
  try {
    const report = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
    const topics = (report.top_topics || []).slice(0, 5)
      .map(t => `- ${t.topic}: ${t.profile_angle || t.why_it_works || ''}`)
      .join('\n');
    const viral = (report.viral_signals || []).slice(0, 3).join('; ');
    researchSummary = `\nMARKET RESEARCH:\nTop topics:\n${topics}\nViral signals: ${viral}`;
    log('📊 Market research loaded.');
  } catch {
    log('ℹ️  No market research found — generating without it.');
  }

  if (songs.length > 0) {
    log(`📀 Found ${songs.length} existing song(s) — avoiding duplicate topics.`);
  }

  const task = buildSuggestTask({ songs, researchSummary, themePrompt, profile });

  const suggesterDef = {
    name: `${profile.brand_name} Song Suggester`,
    model: 'claude-haiku-4-5-20251001',
    noTools: true,
    system: 'You are a music content strategist. You recommend song topics that maximize profile fit, replay value, and brand consistency. Always output valid JSON.',
  };

  log('🤖 Asking the AI strategist for recommendations...');
  const result = await runAgent('product-manager', suggesterDef, task);

  let suggestions;
  try {
    suggestions = parseAgentJson(result.text);
  } catch {
    throw new Error('Could not parse AI response as JSON. Raw: ' + result.text?.slice(0, 200));
  }

  if (themePrompt) {
    suggestions = await auditThemedSuggestions({ suggestions, themePrompt, suggesterDef, log });
  }

  log(`✅ Got ${(suggestions.recommendations || []).length} recommendations!`);

  // Save to file
  const outPath = join(__dirname, '../../output/suggestions.json');
  fs.mkdirSync(join(__dirname, '../../output'), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), theme_prompt: themePrompt || null, ...suggestions }, null, 2));
  log('💾 Saved to output/suggestions.json');

  // Auto-save each to Idea Vault
  let savedCount = 0;
  const savedIds = [];
  for (const rec of suggestions.recommendations || []) {
    try {
      const ideaId = createIdea({
        title: rec.title,
        concept: rec.why || null,
        hook: rec.hook_idea || null,
        target_age_range: profile.audience?.age_range,
        category: rec.urgency === 'seasonal' ? 'seasonal' : null,
        mood: rec.bpm_target ? `upbeat, ${rec.bpm_target} BPM` : null,
        tags: [rec.urgency || 'evergreen', themePrompt ? `theme:${themePrompt}` : null].filter(Boolean),
        lyric_seed: rec.hook_idea || null,
        notes: [
          rec.profile_specific_element || null,
          rec.theme_alignment ? `Theme alignment: ${rec.theme_alignment}` : null,
          themePrompt ? `Theme guidance: ${themePrompt}` : null,
        ].filter(Boolean).join('\n') || null,
        source_type: 'generated',
        source_ref: themePrompt
          ? `suggest_${new Date().toISOString().slice(0, 10)}_${themePrompt.slice(0, 40)}`
          : `suggest_${new Date().toISOString().slice(0, 10)}`,
        brand_profile_id: brandProfileId,
      });
      savedIds.push({ rank: rec.rank, ideaId });
      savedCount++;
    } catch { /* may already exist */ }
  }

  if (savedCount > 0) {
    log(`💡 ${savedCount} idea(s) added to the Idea Vault.`);
  }

  // Attach ideaIds to recommendations
  const recs = (suggestions.recommendations || []).map(rec => {
    const match = savedIds.find(s => s.rank === rec.rank);
    return { ...rec, ideaId: match?.ideaId || null };
  });

  return { recommendations: recs, recommended_next: suggestions.recommended_next };
}
