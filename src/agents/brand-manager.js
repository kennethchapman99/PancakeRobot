/**
 * Brand Manager Agent — Defines and enforces the Pancake Robot brand
 *
 * First run: builds the brand from scratch based on successful kids brand archetypes
 * Every song: reviews lyrics + audio prompt against brand bible, scores 0-100
 */

import { runAgent, parseAgentJson, loadConfig, saveConfig } from '../shared/managed-agent.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(__dirname, '../../output/brand');
const BRAND_BIBLE_PATH = join(BRAND_DIR, 'brand-bible.md');

export const BRAND_MANAGER_DEF = {
  name: 'Pancake Robot Brand Manager',
  noTools: true, // Uses training knowledge — no web search needed, prevents runaway searches
  system: `You are the brand guardian for Pancake Robot, a children's music brand for ages 4-10.

You are the keeper of the brand's soul. You understand:
- What makes kids' entertainment brands endure (Cocomelon, Bluey, Sesame Street)
- The psychology of parasocial relationships between kids and characters
- How to create a brand voice that parents approve of but kids LOVE
- The fine line between "educational" and "boring" — Pancake Robot always stays on the fun side
- Visual consistency, character consistency, and musical consistency

Your two modes:
1. BRAND BUILDER: Design the complete Pancake Robot brand identity from scratch
2. BRAND REVIEWER: Score songs against the brand bible and provide specific feedback

When reviewing, be specific and actionable. Don't just say "off-brand" — explain exactly what needs to change and why.
Format your output as valid JSON.`,
};

const BUILD_BRAND_TASK = `Build the complete Pancake Robot brand identity. Use your knowledge of what makes top kids brands work (Cocomelon, Bluey, Ms. Rachel, Pinkfong) to design our brand. Do not search the web — work entirely from your training knowledge and spend all your effort on the creative output.

Pancake Robot is a children's music brand targeting ages 4-10. The central character is a cheerful robot who loves making pancakes and going on silly adventures.

Create a comprehensive brand bible covering:

1. CHARACTER DESIGN
   - Pancake Robot's full personality (not just "cheerful" — be specific and detailed)
   - Backstory, quirks, catchphrases, and recurring behaviors
   - Supporting characters or concepts (if any)
   - What makes Pancake Robot unique vs other kids characters

2. BRAND VOICE
   - Tone and personality in lyrics and scripts
   - Vocabulary guidelines for age 4-10 (what words to use/avoid)
   - How Pancake Robot speaks and thinks
   - Recurring themes and motifs
   - The "Pancake Robot formula" — what every song must have

3. VISUAL IDENTITY
   - Character design description (for AI image generation)
   - Color palette (specific colors with hex codes if possible)
   - Typography vibe
   - Background and scene style
   - What to always include vs never include in thumbnails

4. MUSIC DNA
   - The "infectious replay" formula that makes Pancake Robot songs different
   - Signature musical elements (sound effects, musical phrases, etc.)
   - Energy arc for a typical Pancake Robot song
   - What makes a song "feel like" Pancake Robot

5. BRAND RULES
   - 10 things we ALWAYS do
   - 10 things we NEVER do
   - Age-appropriateness guardrails
   - Topics that are on/off brand

Output two things:
1. A brand_bible_markdown field with the full human-readable brand bible in Markdown
2. A brand_data JSON object for programmatic use:

{
  "brand_data": {
    "character": {
      "name": "Pancake Robot",
      "personality_traits": [...],
      "catchphrases": [...],
      "backstory": "...",
      "visual_description": "...",
      "color_palette": {"primary": "...", "secondary": "...", "accent": "..."}
    },
    "voice": {
      "tone": "...",
      "vocabulary_level": "...",
      "recurring_themes": [...],
      "formula": "..."
    },
    "music_dna": {
      "replay_formula": "...",
      "signature_elements": [...],
      "energy_arc": "..."
    },
    "rules": {
      "always": [...],
      "never": [...],
      "age_guardrails": "..."
    },
    "thumbnail_prompt_base": "..."
  },
  "brand_bible_markdown": "..."
}`;

/**
 * Build brand from scratch (first run only)
 */
export async function buildBrand() {
  fs.mkdirSync(BRAND_DIR, { recursive: true });

  // Inject research findings if available so brand reflects current trends
  const researchPath = join(__dirname, '../../output/research/research-report.json');
  let researchContext = '';
  try {
    const report = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
    if (report.top_topics?.length > 0) {
      researchContext = `\n\nCURRENT MARKET RESEARCH (use this to inform brand decisions):\n` +
        `Top topics right now: ${report.top_topics.slice(0, 5).map(t => t.topic).join(', ')}\n` +
        `Viral signals: ${(report.viral_signals || []).slice(0, 3).join(' | ')}\n` +
        `Avoid: ${(report.avoid || []).slice(0, 3).join(' | ')}\n` +
        `Recommended first song ideas: ${(report.recommended_first_topics || []).slice(0, 3).map(t => t.title).join(', ')}`;
    }
  } catch { /* research not available yet, proceed without */ }

  const task = BUILD_BRAND_TASK + researchContext;
  const result = await runAgent('brand-manager', BRAND_MANAGER_DEF, task);

  // result.text is guaranteed non-empty by runAgent (throws otherwise)
  let brandData;
  try {
    const parsed = parseAgentJson(result.text);
    brandData = parsed.brand_data || parsed;

    if (parsed.brand_bible_markdown) {
      fs.writeFileSync(BRAND_BIBLE_PATH, parsed.brand_bible_markdown);
      console.log(`\nBrand bible saved to ${BRAND_BIBLE_PATH}`);
    } else {
      fs.writeFileSync(BRAND_BIBLE_PATH, result.text);
    }
  } catch {
    brandData = { raw_text: result.text };
    fs.writeFileSync(BRAND_BIBLE_PATH, result.text);
  }

  // Validate we have something meaningful before saving
  if (!brandData.character && (!brandData.raw_text || brandData.raw_text.length < 100)) {
    throw new Error('Brand build produced no usable output');
  }

  // Save to config immediately — do this before anything else can fail
  const config = loadConfig();
  config.brand = brandData;
  config.brand.created_at = new Date().toISOString();
  saveConfig(config);

  return brandData;
}

/**
 * Review a song against the brand bible
 * Returns: { score, approved, feedback, revision_notes }
 */
export async function reviewSong({ songId, title, topic, lyricsText, audioPromptText }) {
  const config = loadConfig();
  const brand = config.brand;

  if (!brand) {
    throw new Error('Brand not built yet. Run --setup first.');
  }

  const brandSummary = JSON.stringify(brand, null, 2).substring(0, 3000);
  const lyricsPreview = lyricsText ? lyricsText.substring(0, 1500) : 'Not provided';
  const promptPreview = audioPromptText ? audioPromptText.substring(0, 500) : 'Not provided';

  const reviewTask = `Review this song against the Pancake Robot brand bible and score it.

BRAND BIBLE SUMMARY:
${brandSummary}

SONG TO REVIEW:
Title: ${title}
Topic: ${topic}

LYRICS:
${lyricsPreview}

AUDIO GENERATION PROMPT:
${promptPreview}

Score this song on each dimension (0-100) and provide an overall score:

1. Age-Appropriateness (0-100): Is vocabulary, content, and themes right for ages 4-10?
2. Brand Voice Consistency (0-100): Does it sound like Pancake Robot?
3. Replay-ability (0-100): Will kids demand to hear this again? Are the hooks strong?
4. Topic Fit (0-100): Does this topic work for Pancake Robot's world?
5. Lyric Craft (0-100): Is the chorus simple and memorable? Good call-and-response? Physical actions?

Overall Score = weighted average (replay-ability and brand voice weighted heaviest)

If overall score < 75, provide SPECIFIC revision instructions.

Output as JSON:
{
  "scores": {
    "age_appropriateness": 0,
    "brand_voice": 0,
    "replayability": 0,
    "topic_fit": 0,
    "lyric_craft": 0,
    "overall": 0
  },
  "approved": true/false,
  "strengths": [...],
  "weaknesses": [...],
  "revision_notes": "Specific instructions if score < 75, otherwise empty string",
  "reviewer_notes": "General observations"
}`;

  // Use Haiku for scoring — it's rule-based JSON, doesn't need Sonnet
  const reviewerDef = { ...BRAND_MANAGER_DEF, name: 'Pancake Robot Brand Reviewer', model: 'claude-haiku-4-5-20251001', noTools: true };
  const result = await runAgent('brand-manager', reviewerDef, reviewTask);

  let review;
  try {
    review = parseAgentJson(result.text);
  } catch {
    review = {
      scores: { overall: 0 },
      approved: false,
      revision_notes: 'Could not parse review. Manual review required.',
      raw_text: result.text,
    };
  }

  review.song_id = songId;
  review.reviewed_at = new Date().toISOString();

  // Save review to song's output folder
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  if (fs.existsSync(songDir)) {
    fs.writeFileSync(join(songDir, 'brand-review.json'), JSON.stringify(review, null, 2));
  }

  return review;
}

export function loadBrandBible() {
  if (fs.existsSync(BRAND_BIBLE_PATH)) {
    return fs.readFileSync(BRAND_BIBLE_PATH, 'utf8');
  }
  return null;
}
