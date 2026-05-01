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
import { loadBrandProfile } from './brand-profile.js';
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

/**
 * Run the song suggester pipeline.
 * @param {function} onLog  - called with each log line string
 * @param {object} options  - optional controls, including { themePrompt }
 * @returns {object}        - { recommendations, recommended_next }
 */
export async function runSuggestPipeline(onLog = () => {}, options = {}) {
  const log = (msg) => onLog(msg);
  const themePrompt = typeof options.themePrompt === 'string'
    ? options.themePrompt.trim()
    : '';

  log('🔍 Loading brand profile and catalog...');
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

  // Summarize existing songs
  const existingSongs = songs.length > 0
    ? `\nEXISTING SONGS (avoid repeating these themes):\n${songs.map(s => `- "${s.title}" (${s.topic}) — score: ${s.brand_score || '?'}`).join('\n')}`
    : '\nEXISTING SONGS: None yet — this will be the first!';

  if (songs.length > 0) {
    log(`📀 Found ${songs.length} existing song(s) — avoiding duplicate topics.`);
  }

  const brandSummary = `Brand: ${BRAND_NAME} — ${CHARACTER_FALLBACK_SUMMARY}; audience: ${AUDIENCE_DESCRIPTION}`;

  const titleExamples = TITLE_EXAMPLES.map(t => `"${t}"`).join(', ');
  const themeGuidance = themePrompt
    ? `\nUSER THEME / VIBE GUIDANCE:\nThe user wants this batch of ideas to share this common theme, vibe, or creative lane:\n"${themePrompt}"\n\nUse this to create thematic consistency across the 5 ideas. Do not hard-code or overfit to fixed categories. Do not ignore brand rules, audience fit, title rules, or duplicate-topic avoidance. Each idea should still feel distinct, replayable, and song-worthy.`
    : '\nUSER THEME / VIBE GUIDANCE:\nNo theme was provided. Generate unrelated fresh ideas with strong variety.';

  const task = `You are the song strategist for ${BRAND_NAME}, ${BRAND_PROFILE.brand_description}.

${brandSummary}
${existingSongs}
${researchSummary}
${themeGuidance}

ACTIVE SONGWRITING RULES:
${JSON.stringify(SONGWRITING, null, 2)}

Recommend the 5 best next song topics. For each:
1. Pick topics that are NOT already covered by existing songs
2. Prioritize high replay-ability and viral potential
3. Consider the season/timing (current date: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})
4. Mix educational + pure fun topics
5. Think BIG on variety — ${TOPIC_VARIETY}
6. If theme guidance is provided, keep all 5 ideas aligned to that theme while making each idea distinct

TITLE RULES — this is critical:
- Most titles should be creative and topic-first: ${titleExamples}
- Do NOT default to "${CHARACTER_NAME} [topic]" — that pattern is overused
- The character name "${CHARACTER_NAME}" should appear in a title at most once per 5 songs, and only when it genuinely adds humor or meaning
- Great titles are specific, memorable, and aligned to the active brand profile.

Output as JSON:
{
  "recommendations": [
    {
      "rank": 1,
      "title": "Creative topic-first title (NOT '${CHARACTER_NAME} ___')",
      "topic": "One-line topic description for --new command",
      "why": "Why this will work right now (2-3 sentences)",
      "hook_idea": "The key lyrical or musical hook concept",
      "profile_specific_element": "A profile-aligned detail, motif, memory, or mechanic",
      "bpm_target": 110,
      "urgency": "evergreen|seasonal|trending"
    }
  ],
  "recommended_next": "topic string to paste directly into --new command"
}`;

  const suggesterDef = {
    name: `${BRAND_NAME} Song Suggester`,
    model: 'claude-haiku-4-5-20251001',
    noTools: true,
    system: "You are a music content strategist. You recommend song topics that maximize profile fit, replay value, and brand consistency. Always output valid JSON.",
  };

  log('🤖 Asking the AI strategist for recommendations...');
  const result = await runAgent('product-manager', suggesterDef, task);

  let suggestions;
  try {
    suggestions = parseAgentJson(result.text);
  } catch {
    throw new Error('Could not parse AI response as JSON. Raw: ' + result.text?.slice(0, 200));
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
        target_age_range: AUDIENCE_AGE_RANGE,
        category: rec.urgency === 'seasonal' ? 'seasonal' : null,
        mood: rec.bpm_target ? `upbeat, ${rec.bpm_target} BPM` : null,
        tags: [rec.urgency || 'evergreen', themePrompt ? `theme:${themePrompt}` : null].filter(Boolean),
        lyric_seed: rec.hook_idea || null,
        notes: [rec.profile_specific_element || null, themePrompt ? `Theme guidance: ${themePrompt}` : null].filter(Boolean).join('\n') || null,
        source_type: 'generated',
        source_ref: themePrompt
          ? `suggest_${new Date().toISOString().slice(0, 10)}_${themePrompt.slice(0, 40)}`
          : `suggest_${new Date().toISOString().slice(0, 10)}`,
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
