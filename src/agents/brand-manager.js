/**
 * Brand Manager Agent — Defines and enforces the configured brand.
 *
 * Active brand profile is source of truth. Generated brand data is optional and
 * ignored when it belongs to a different brand.
 */

import { runAgent, parseAgentJson } from '../shared/managed-agent.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(__dirname, '../../output/brand');
const BRAND_BIBLE_PATH = join(BRAND_DIR, 'brand-bible.md');
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const BRAND_DESCRIPTION = BRAND_PROFILE.brand_description;
const AUDIENCE_AGE_RANGE = BRAND_PROFILE.audience.age_range;
const AUDIENCE_DESCRIPTION = BRAND_PROFILE.audience.description;
const AUDIENCE_GUARDRAIL = BRAND_PROFILE.audience.guardrail;
const CHARACTER_NAME = BRAND_PROFILE.character.name;

export const BRAND_MANAGER_DEF = {
  name: `${BRAND_NAME} Brand Manager`,
  noTools: true,
  system: `You are the brand guardian for ${BRAND_NAME}, ${BRAND_DESCRIPTION}. Audience: ${AUDIENCE_DESCRIPTION}. Guardrail: ${AUDIENCE_GUARDRAIL}. Use only the active brand profile as source of truth. Output valid JSON.`,
};

const BUILD_BRAND_TASK = `Build a complete brand bible for ${BRAND_NAME}.

ACTIVE BRAND PROFILE:
${JSON.stringify(BRAND_PROFILE, null, 2)}

Create a brand bible that expands the active profile without changing its facts.

Output JSON:
{
  "brand_data": {
    "brand_name": "${BRAND_NAME}",
    "brand_type": "${BRAND_PROFILE.brand_type}",
    "character": {
      "name": "${CHARACTER_NAME}",
      "personality_traits": [],
      "catchphrases": [],
      "backstory": "",
      "visual_description": "",
      "color_palette": {}
    },
    "voice": {
      "tone": "",
      "vocabulary_level": "",
      "recurring_themes": [],
      "formula": ""
    },
    "music_dna": {
      "replay_formula": "",
      "signature_elements": [],
      "energy_arc": ""
    },
    "rules": {
      "always": [],
      "never": [],
      "age_guardrails": "${AUDIENCE_GUARDRAIL}"
    },
    "thumbnail_prompt_base": ""
  },
  "brand_bible_markdown": ""
}`;

export async function buildBrand() {
  fs.mkdirSync(BRAND_DIR, { recursive: true });

  const result = await runAgent('brand-manager', BRAND_MANAGER_DEF, BUILD_BRAND_TASK);

  let generatedBrand;
  try {
    const parsed = parseAgentJson(result.text);
    generatedBrand = parsed.brand_data || parsed;

    if (parsed.brand_bible_markdown) {
      fs.writeFileSync(BRAND_BIBLE_PATH, parsed.brand_bible_markdown);
      console.log(`\nBrand bible saved to ${BRAND_BIBLE_PATH}`);
    } else {
      fs.writeFileSync(BRAND_BIBLE_PATH, result.text);
    }
  } catch {
    generatedBrand = { brand_name: BRAND_NAME, raw_text: result.text };
    fs.writeFileSync(BRAND_BIBLE_PATH, result.text);
  }

  if (!generatedBrand.brand_name) generatedBrand.brand_name = BRAND_NAME;
  if (!generatedBrand.brand_type) generatedBrand.brand_type = BRAND_PROFILE.brand_type;

  return generatedBrand;
}

export async function reviewSong({ songId, title, topic, lyricsText, audioPromptText }) {
  const brandSummary = JSON.stringify({ active_brand_profile: BRAND_PROFILE }, null, 2).substring(0, 5000);
  const lyricsPreview = lyricsText ? lyricsText.substring(0, 3000) : 'Not provided';
  const promptPreview = audioPromptText ? audioPromptText.substring(0, 1200) : 'Not provided';

  const reviewTask = `Review this song against the active ${BRAND_NAME} brand profile and score it.

BRAND CONTEXT:
${brandSummary}

SONG TO REVIEW:
Title: ${title}
Topic: ${topic}

LYRICS:
${lyricsPreview}

AUDIO GENERATION PROMPT:
${promptPreview}

Score this song on each dimension from 0-100:
1. Audience Fit: Is vocabulary, content, and emotional level right for ${AUDIENCE_AGE_RANGE} / ${AUDIENCE_DESCRIPTION}?
2. Brand Voice: Does it match ${BRAND_NAME} and ${BRAND_DESCRIPTION}?
3. Hook Strength: Is the chorus memorable and centered on the locked title?
4. Topic Fit: Does it use the topic and profile-specific details well?
5. Lyric Craft: Is it singable, specific, coherent, and production-ready?

Overall Score = weighted average with brand voice, topic fit, and lyric craft weighted highest.
If overall score < 75, provide specific revision instructions.

Output valid JSON:
{
  "scores": {
    "audience_fit": 0,
    "brand_voice": 0,
    "hook_strength": 0,
    "topic_fit": 0,
    "lyric_craft": 0,
    "overall": 0
  },
  "approved": true,
  "strengths": [],
  "weaknesses": [],
  "revision_notes": "",
  "reviewer_notes": ""
}`;

  const reviewerDef = { ...BRAND_MANAGER_DEF, name: `${BRAND_NAME} Brand Reviewer`, model: 'claude-haiku-4-5-20251001', noTools: true };
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
