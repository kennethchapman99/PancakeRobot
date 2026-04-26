/**
 * Pancake Robot — Song Suggester (shared, callable from CLI or web)
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
import { loadConfig, runAgent, parseAgentJson } from './managed-agent.js';
import { getAllSongs, createIdea } from './db.js';

/**
 * Run the song suggester pipeline.
 * @param {function} onLog  - called with each log line string
 * @returns {object}        - { recommendations, recommended_next }
 */
export async function runSuggestPipeline(onLog = () => {}) {
  const log = (msg) => onLog(msg);

  log('🔍 Loading config and catalog...');
  const config = loadConfig();
  const songs = getAllSongs();

  // Load research if available
  let researchSummary = '';
  const researchPath = join(__dirname, '../../output/research/research-report.json');
  try {
    const report = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
    const topics = (report.top_topics || []).slice(0, 5)
      .map(t => `- ${t.topic}: ${t.pancake_robot_angle || t.why_it_works || ''}`)
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

  const brandSummary = config.brand?.voice?.recurring_themes
    ? `Brand themes: ${config.brand.voice.recurring_themes.join(', ')}`
    : 'Brand: Pancake Robot — cheerful robot who loves pancakes and silly adventures, ages 4-10';

  const task = `You are the song strategist for Pancake Robot, a children's music brand (ages 4-10).

${brandSummary}
${existingSongs}
${researchSummary}

Recommend the 5 best next song topics. For each:
1. Pick topics that are NOT already covered by existing songs
2. Prioritize high replay-ability and viral potential
3. Consider the season/timing (current date: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})
4. Mix educational + pure fun topics
5. Think BIG on variety — animals, weather, space, vehicles, silly food, emotions, counting, colors, nature, dinosaurs, robots, dance

TITLE RULES — this is critical:
- Most titles should be creative and topic-first: "Raining Taco Dogs", "The Counting Stomp", "Wiggle Like a Jellyfish", "Five Silly Dinosaurs"
- Do NOT default to "Pancake Robot [topic]" — that pattern is overused
- The character name "Pancake Robot" should appear in a title at most once per 5 songs, and only when it genuinely adds humor or meaning
- Great kids song titles are short, funny, or surprising — they make a child say "wait, WHAT?"

Output as JSON:
{
  "recommendations": [
    {
      "rank": 1,
      "title": "Creative topic-first title (NOT 'Pancake Robot ___')",
      "topic": "One-line topic description for --new command",
      "why": "Why this will work right now (2-3 sentences)",
      "hook_idea": "The key lyrical or musical hook concept",
      "physical_action": "Suggested body movement kids can do",
      "bpm_target": 110,
      "urgency": "evergreen|seasonal|trending"
    }
  ],
  "recommended_next": "topic string to paste directly into --new command"
}`;

  const suggesterDef = {
    name: 'Pancake Robot Song Suggester',
    model: 'claude-haiku-4-5-20251001',
    noTools: true,
    system: "You are a children's music strategist. You recommend song topics that maximize replay-ability, virality, and brand consistency. Always output valid JSON.",
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
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), ...suggestions }, null, 2));
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
        target_age_range: '4-10',
        category: rec.urgency === 'seasonal' ? 'seasonal' : null,
        mood: rec.bpm_target ? `upbeat, ${rec.bpm_target} BPM` : null,
        tags: [rec.urgency || 'evergreen'].filter(Boolean),
        lyric_seed: rec.hook_idea || null,
        notes: rec.physical_action ? `Physical action: ${rec.physical_action}` : null,
        source_type: 'generated',
        source_ref: `suggest_${new Date().toISOString().slice(0, 10)}`,
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
