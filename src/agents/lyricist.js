/**
 * Lyricist Agent — Writes complete lyrics and audio generation prompts.
 *
 * The active brand profile is the source of truth. This file intentionally avoids
 * hard-coded assumptions from any single brand.
 */

import { runAgent, parseAgentJson } from '../shared/managed-agent.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import { sanitizeLyricsForQA, stripEmojis } from '../shared/song-qa.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const CHARACTER_NAME = BRAND_PROFILE.character.name;
const MUSIC = BRAND_PROFILE.music;
const SONGWRITING = BRAND_PROFILE.songwriting || {};
const OUTPUT_SCHEMA = SONGWRITING.output_schema || {};
const MUSIC_TARGET_LENGTH = MUSIC.target_length;
const MUSIC_DEFAULT_BPM = MUSIC.default_bpm;
const MUSIC_DEFAULT_STYLE = MUSIC.default_style;
const MUSIC_DEFAULT_PROMPT = MUSIC.default_prompt;
const FIRST_VOCAL_BY_SECONDS = MUSIC.first_vocal_by_seconds;
const MAX_INSTRUMENTAL_INTRO_SECONDS = MUSIC.max_instrumental_intro_seconds;

export const LYRICIST_DEF = {
  name: `${BRAND_NAME} Lyricist`,
  noTools: true,
  system: `You are the head songwriter for ${BRAND_NAME}. Follow the active brand profile exactly. Do not import characters, references, sound effects, structures, genre rules, or motifs from unrelated brands. Output valid production-ready JSON.`,
};

export async function writeLyrics({ songId, topic, researchReport, brandData, revisionNotes, existingLyrics }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  const lyricsTask = buildLyricsTask({ topic, researchReport, brandData, revisionNotes, existingLyrics });
  const result = await runAgent('lyricist', LYRICIST_DEF, lyricsTask);

  let songData;
  try {
    songData = parseAgentJson(result.text);
  } catch {
    songData = {
      title: topic.substring(0, 50),
      lyrics: result.text,
      parse_error: true,
    };
  }

  songData = sanitizeSongData(songData, topic);

  const lyricsContent = formatLyricsMarkdown(songData);
  const lyricsPath = join(songDir, 'lyrics.md');
  fs.writeFileSync(lyricsPath, lyricsContent);

  const audioPromptContent = formatAudioPrompt(songData);
  const audioPromptPath = join(songDir, 'audio-prompt.md');
  fs.writeFileSync(audioPromptPath, audioPromptContent);

  fs.writeFileSync(join(songDir, 'lyrics-data.json'), JSON.stringify(songData, null, 2));

  console.log(`\nLyrics saved to ${lyricsPath}`);
  console.log(`Audio prompt saved to ${audioPromptPath}`);

  return {
    songData,
    lyricsPath,
    audioPromptPath,
    title: songData.title || topic,
    lyricsText: lyricsContent,
    audioPromptText: audioPromptContent,
    costUsd: result.costUsd || 0,
  };
}

export function buildLyricsTask({ topic, researchReport, brandData, revisionNotes, existingLyrics }) {
  const existingLyricsContext = existingLyrics
    ? `\n\nEXISTING LYRICS TO REVISE:\n\`\`\`\n${existingLyrics}\n\`\`\`\nRevise based on the feedback below. Keep what works and fix what is requested.`
    : '';

  const revisionContext = revisionNotes
    ? `\n\n${existingLyrics ? 'EDITOR FEEDBACK' : 'REVISION NOTES'}:\n${revisionNotes}\nAddress all specific concerns.`
    : '';

  return `${existingLyrics ? 'Revise' : 'Write'} a complete, production-ready song for the active ${BRAND_NAME} brand on this topic: "${topic}"
${existingLyricsContext}${revisionContext}

ACTIVE BRAND PROFILE — SOURCE OF TRUTH:
${JSON.stringify(BRAND_PROFILE, null, 2)}

SONGWRITING DIRECTION:
${formatSongwritingGuidance()}

COMPATIBLE GENERATED BRAND DATA:
${JSON.stringify(getCompatibleGeneratedBrandData(brandData), null, 2)}

RESEARCH / CONTEXT INSIGHTS:
${JSON.stringify(summarizeResearch(researchReport), null, 2)}

MUSIC DIRECTION:
${MUSIC_DEFAULT_PROMPT}

TITLE RULES:
- If the topic includes an explicit title, preserve that title exactly in the title field.
- If no explicit title is provided, choose one creative title and treat it as locked.
- The locked exact title must appear word-for-word in the first singable line, chorus, final chorus or last chorus repeat, and audio_prompt.special_notes.
- Do not create title variants in the lyrics.
- Good title examples for this brand: ${BRAND_PROFILE.lyrics.title_examples.map(t => `"${t}"`).join(', ')}.

LYRIC RULES:
- Use only the active brand profile as brand truth.
- Make the song specific to ${BRAND_NAME}, ${CHARACTER_NAME}, and the topic details.
- Do not import characters, references, sound effects, structures, genre rules, or motifs from unrelated brands.
- Follow every forbidden element in SONGWRITING DIRECTION.
- Include required elements naturally when they fit the topic.
- Keep the tone aligned to this guardrail: ${BRAND_PROFILE.audience.guardrail}.
- Use specific memories, images, names, relationships, and emotional details from the active profile.
- Follow the required closing: ${BRAND_PROFILE.lyrics.required_closing}.

REQUIREMENTS:
- Production render target: ${MUSIC.target_length}.
- Word count: ${MUSIC.normal_word_range}. Never go below ${MUSIC.min_words} words unless explicitly requested.
- Start with [INTRO].
- First singable line must contain the exact title.
- Chorus: 4-8 lines, memorable, and built around the exact title.
- Main hook/chorus repeats at least two times.
- The lyrics field may be sung by the renderer; include only section labels and words safe to sing or speak aloud.

STRUCTURE OPTIONS:
${formatStructurePreferences()}

Output valid JSON only:
${formatOutputSchema()}`;
}

function formatSongwritingGuidance() {
  if (!Object.keys(SONGWRITING).length) {
    return 'No dedicated songwriting section provided. Infer songwriting direction from music, lyrics, audience, and character fields.';
  }

  return JSON.stringify({
    song_type: SONGWRITING.song_type,
    primary_emotional_goal: SONGWRITING.primary_emotional_goal,
    voice_perspective: SONGWRITING.voice_perspective,
    allowed_elements: SONGWRITING.allowed_elements || [],
    forbidden_elements: SONGWRITING.forbidden_elements || [],
    required_elements: SONGWRITING.required_elements || [],
    output_schema: OUTPUT_SCHEMA,
  }, null, 2);
}

function formatStructurePreferences() {
  const structures = SONGWRITING.structure_preferences;
  const defaults = [
    '[INTRO] -> [VERSE 1] -> [CHORUS] -> [VERSE 2] -> [CHORUS] -> [BRIDGE] -> [FINAL CHORUS] -> [OUTRO]',
    '[INTRO] -> [VERSE 1] -> [PRE-CHORUS] -> [CHORUS] -> [VERSE 2] -> [PRE-CHORUS] -> [CHORUS] -> [BRIDGE] -> [FINAL CHORUS] -> [OUTRO]',
    '[INTRO] -> [VERSE 1] -> [VERSE 2] -> [CHORUS] -> [BRIDGE] -> [FINAL CHORUS] -> [OUTRO]'
  ];

  return (Array.isArray(structures) && structures.length ? structures : defaults)
    .map((structure, index) => `${index + 1}. ${structure}`)
    .join('\n');
}

function formatOutputSchema() {
  const fields = [
    '  "title": "The Song Title"',
    '  "lyrics": "full lyrics text with section markers"',
    '  "chorus_lines": ["line1", "line2", "line3", "line4"]',
    '  "word_count": 320',
    '  "structure_used": "which structure option was used"',
    '  "key_hook": "the memorable hook line"'
  ];

  if (OUTPUT_SCHEMA.include_physical_action_cue) {
    fields.push('  "physical_action_cue": "description of the main physical action"');
  }

  if (OUTPUT_SCHEMA.include_funny_long_word) {
    fields.push('  "funny_long_word": "the comedic long word used if any"');
  }

  if (OUTPUT_SCHEMA.include_audio_prompt !== false) {
    fields.push(`  "audio_prompt": {
    "style": "${MUSIC.default_style}",
    "tempo_bpm": ${MUSIC.default_bpm},
    "genre": "${MUSIC.default_style}",
    "instrumentation": "match the active profile music direction",
    "energy": "match the emotional arc of the song",
    "mood": "match the song",
    "voice_style": "match the active brand profile, audience, and topic",
    "structure_note": "describe the actual structure used and say vocals start immediately",
    "target_length": "${MUSIC.target_length}",
    "first_vocal_by_seconds": ${MUSIC.first_vocal_by_seconds},
    "max_instrumental_intro_seconds": ${MUSIC.max_instrumental_intro_seconds},
    "exact_title_usage": "Exact title appears in opening vocal line, chorus, and final chorus",
    "special_notes": "Vocals begin immediately; exact title must be sung clearly early and repeated in chorus; follow the active brand profile only."
  }`);
  }

  return `{
${fields.join(',\n')}
}`;
}

function getCompatibleGeneratedBrandData(brandData) {
  if (!brandData) return 'None supplied.';

  const serialized = JSON.stringify(brandData).toLowerCase();
  const activeBrand = BRAND_NAME.toLowerCase();
  const activeCharacter = CHARACTER_NAME.toLowerCase();

  if (!serialized.includes(activeBrand) && !serialized.includes(activeCharacter)) {
    console.log('[BRAND] Ignoring stale generated brand bible for different brand');
    return 'Ignored stale generated brand bible for different brand.';
  }

  return {
    personality_traits: brandData.character?.personality_traits,
    catchphrases: brandData.character?.catchphrases,
    voice_tone: brandData.voice?.tone,
    formula: brandData.voice?.formula,
    replay_formula: brandData.music_dna?.replay_formula,
    always: brandData.rules?.always?.slice(0, 5),
    never: brandData.rules?.never?.slice(0, 5),
  };
}

function summarizeResearch(researchReport) {
  if (!researchReport) return { note: 'No research data available. Use the active brand profile and songwriting expertise.' };

  return {
    lyric_patterns: researchReport.lyric_patterns?.slice(0, 3),
    ideal_bpm_range: researchReport.ideal_bpm_range,
    ideal_length_seconds: researchReport.ideal_length_seconds,
    viral_signals: researchReport.viral_signals?.slice(0, 5),
  };
}

function sanitizeSongData(songData, topic) {
  const sanitized = {
    ...songData,
    title: stripEmojis(songData.title || topic.substring(0, 50)).trim(),
    lyrics: sanitizeLyricsForQA(songData.lyrics || ''),
    key_hook: songData.key_hook ? stripEmojis(songData.key_hook).trim() : songData.key_hook,
    chorus_lines: Array.isArray(songData.chorus_lines)
      ? songData.chorus_lines.map(line => stripEmojis(line).trim())
      : songData.chorus_lines,
    audio_prompt: sanitizeAudioPrompt(songData.audio_prompt || {}),
  };

  if (!OUTPUT_SCHEMA.include_physical_action_cue) delete sanitized.physical_action_cue;
  if (!OUTPUT_SCHEMA.include_funny_long_word) delete sanitized.funny_long_word;

  return sanitized;
}

function sanitizeAudioPrompt(audioPrompt) {
  const cleaned = { ...audioPrompt };
  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') cleaned[key] = stripEmojis(value).trim();
  }
  return cleaned;
}

function formatLyricsMarkdown(songData) {
  const title = songData.title || 'Untitled Song';
  const lyrics = sanitizeLyricsForQA(songData.lyrics || '');

  let md = `# ${title}\n\n`;
  md += `**Key Hook:** ${songData.key_hook || 'TBD'}\n`;
  if (OUTPUT_SCHEMA.include_physical_action_cue) {
    md += `**Physical Action:** ${songData.physical_action_cue || 'TBD'}\n`;
  }
  md += `**Word Count:** ~${songData.word_count || '?'}\n\n`;
  md += `---\n\n`;
  md += lyrics;
  md += `\n`;

  return md;
}

function formatAudioPrompt(songData) {
  const ap = songData.audio_prompt || {};
  const lyrics = sanitizeLyricsForQA(songData.lyrics || '');

  let prompt = `# Audio Generation Prompt\n\n`;
  prompt += `## Song: ${songData.title || 'Untitled'}\n\n`;
  prompt += `## Music Specs\n\n`;
  prompt += `**Style:** ${ap.tempo_bpm || MUSIC_DEFAULT_BPM} BPM, ${ap.genre || MUSIC_DEFAULT_STYLE}\n`;
  prompt += `**Instrumentation:** ${ap.instrumentation || MUSIC_DEFAULT_PROMPT}\n`;
  prompt += `**Energy:** ${ap.energy || 'profile-aligned'}\n`;
  prompt += `**Mood:** ${ap.mood || MUSIC_DEFAULT_STYLE}\n`;
  prompt += `**Voice Style:** ${ap.voice_style || 'profile-aligned'}\n`;
  prompt += `**Structure:** ${ap.structure_note || 'vocals start immediately, verse, chorus, verse, chorus, bridge, final chorus, outro'}\n`;
  prompt += `**Target Length:** ${ap.target_length || MUSIC_TARGET_LENGTH}\n`;
  prompt += `**First Vocal By:** ${ap.first_vocal_by_seconds ?? FIRST_VOCAL_BY_SECONDS} seconds\n`;
  prompt += `**Max Instrumental Intro:** ${ap.max_instrumental_intro_seconds ?? MAX_INSTRUMENTAL_INTRO_SECONDS} seconds\n`;
  prompt += `**Exact Title Usage:** ${ap.exact_title_usage || 'Exact title appears in opening vocal line, chorus, and final chorus'}\n`;
  prompt += `**Render Safety:** Vocals begin immediately within 0-${FIRST_VOCAL_BY_SECONDS} seconds. Maximum non-vocal opening ${MAX_INSTRUMENTAL_INTRO_SECONDS} seconds. The exact title must be sung clearly early and repeated in the chorus.\n`;
  if (ap.special_notes) prompt += `**Special Notes:** ${ap.special_notes}\n`;
  prompt += `\n---\n\n`;
  prompt += `## Full Lyrics\n\n`;
  prompt += lyrics;
  prompt += `\n`;

  return prompt;
}
