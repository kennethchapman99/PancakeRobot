/**
 * Lyricist Agent — Writes complete lyrics and audio generation prompts
 *
 * Takes: research report + brand bible + topic
 * Outputs: lyrics.md + audio-prompt.md per song
 */

import { runAgent, parseAgentJson, loadConfig } from '../shared/managed-agent.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import { findNonSingableLyricMarkup, sanitizeLyricsForQA, stripEmojis } from '../shared/song-qa.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const AUDIENCE_AGE_RANGE = BRAND_PROFILE.audience.age_range;
const AUDIENCE_DESCRIPTION = BRAND_PROFILE.audience.description;
const CHARACTER_NAME = BRAND_PROFILE.character.name;
const CHARACTER_CLAP_NAME = BRAND_PROFILE.character.clap_name;
const CHARACTER_FALLBACK_SUMMARY = BRAND_PROFILE.character.fallback_summary;
const TITLE_EXAMPLES = BRAND_PROFILE.lyrics.title_examples;
const MUSIC_TARGET_LENGTH = BRAND_PROFILE.music.target_length;
const MUSIC_NORMAL_WORD_RANGE = BRAND_PROFILE.music.normal_word_range;
const MUSIC_MIN_WORDS = BRAND_PROFILE.music.min_words;
const MUSIC_DEFAULT_BPM = BRAND_PROFILE.music.default_bpm;
const MUSIC_DEFAULT_STYLE = BRAND_PROFILE.music.default_style;
const FIRST_VOCAL_BY_SECONDS = BRAND_PROFILE.music.first_vocal_by_seconds;
const MAX_INSTRUMENTAL_INTRO_SECONDS = BRAND_PROFILE.music.max_instrumental_intro_seconds;

export const LYRICIST_DEF = {
  name: `${BRAND_NAME} Lyricist`,
  noTools: true,
  system: `You are the head songwriter for ${BRAND_NAME}, a children's music brand for ages ${AUDIENCE_AGE_RANGE}.

You specialize in writing songs that kids want to hear on repeat — not because parents force them to, but because kids genuinely can't stop.

Your expertise:
- Writing choruses simple enough for 3-year-olds to sing but fun enough for 10-year-olds
- Engineering earworms through repetition, rhythm, and unexpected musical moments
- Age-appropriate vocabulary
- Physical engagement cues that get kids moving
- Call-and-response structures that make kids feel like they're part of the song
- Writing a silly/unexpected bridge that is memorable without putting performance notes into the lyric text

You follow the ${BRAND_NAME} brand voice and always stay within age-appropriate guardrails.
You output structured, production-ready content.`,
};

/**
 * Write lyrics and audio prompt for a song
 */
export async function writeLyrics({ songId, topic, researchReport, brandData, revisionNotes, existingLyrics }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  const researchSummary = researchReport
    ? JSON.stringify({
        lyric_patterns: researchReport.lyric_patterns?.slice(0, 3),
        ideal_bpm_range: researchReport.ideal_bpm_range,
        ideal_length_seconds: researchReport.ideal_length_seconds,
        viral_signals: researchReport.viral_signals?.slice(0, 5),
      }, null, 2)
    : 'No research data available. Use your expertise.';

  const brandSummary = brandData
    ? JSON.stringify({
        personality_traits: brandData.character?.personality_traits,
        catchphrases: brandData.character?.catchphrases,
        voice_tone: brandData.voice?.tone,
        formula: brandData.voice?.formula,
        replay_formula: brandData.music_dna?.replay_formula,
        always: brandData.rules?.always?.slice(0, 5),
        never: brandData.rules?.never?.slice(0, 5),
      }, null, 2)
    : `Build a cheerful, playful ${CHARACTER_NAME} character who loves pancakes and adventure.`;

  const existingLyricsContext = existingLyrics
    ? `\n\nEXISTING LYRICS TO REVISE:\n\`\`\`\n${existingLyrics}\n\`\`\`\nRevise the above lyrics based on the feedback below. Keep what is working, fix what is asked.`
    : '';

  const revisionContext = revisionNotes
    ? `\n\n${existingLyrics ? 'EDITOR FEEDBACK' : 'REVISION NOTES FROM BRAND REVIEW'}:\n${revisionNotes}\nPlease address ALL of these specific concerns.`
    : '';

  const titleExamples = TITLE_EXAMPLES.map(t => `"${t}"`).join(', ');

  const lyricsTask = `${existingLyrics ? 'Revise' : 'Write'} a complete, production-ready children's song for the ${BRAND_NAME} brand on this topic: "${topic}"
${existingLyricsContext}${revisionContext}

BRAND CONTEXT:
${brandSummary}

RESEARCH INSIGHTS:
${researchSummary}

TITLE FIDELITY RULES — HARD REQUIREMENTS:
- If the topic includes an explicit title, for example "title: Something Went Wrong Again" or a quoted title, preserve that title EXACTLY in the title field.
- If no explicit title is provided, choose one creative title — then treat it as LOCKED.
- The locked exact title must appear word-for-word in:
  1. the first singable line in [INTRO]
  2. the [CHORUS]
  3. the [FINAL CHORUS] or last chorus repeat
  4. audio_prompt.special_notes
- Do NOT create title variants in the lyrics. If the title is "Something Went Wrong Again", do not change it to "Oopsie Again" or "Something Went Wrong".
- The chorus must be built around the exact title, not a looser related hook.

TITLE STYLE GUIDANCE:
- The title should be creative and topic-first. Good examples: ${titleExamples}
- Do NOT default to "${CHARACTER_NAME} [topic]" — that pattern is overused and boring
- Only include the character name "${CHARACTER_NAME}" in the title if it genuinely adds humor or surprise for THIS specific topic
- A great title makes a child say "wait, WHAT?" — lean into that

LYRICS CLEANLINESS RULES — HARD REQUIREMENTS:
- No emoji anywhere in the title, lyrics, chorus_lines, key_hook, or audio_prompt.
- Use only these plain section labels, exactly as written: [INTRO], [HOOK], [VERSE 1], [VERSE 2], [VERSE 3], [PRE-CHORUS], [CHORUS], [BRIDGE], [BREAKDOWN], [SILLY BREAKDOWN], [CALL/RESPONSE 1], [CALL/RESPONSE 2], [FINAL CHORUS], [OUTRO].
- Never add descriptors, jokes, performance notes, or emoji inside brackets. Bad: [BRIDGE — ROBOT MALFUNCTION SEQUENCE]. Good: [BRIDGE].
- Never write stage directions as lyric lines. Bad: *music slows down, glitchy warping sounds*. Good: Beep boop, pancake reboot, wobble wobble wow.
- Sound effects, robot malfunctions, chaos moments, and spoken bits are allowed ONLY when written as singable/spoken lyric words, never as instructions.
- The music service may sing any text in the lyrics field. Therefore the lyrics field must contain only section labels plus words that are safe to sing/spoken aloud.

LYRICS RULES:
- Start with [INTRO] and make the first singable line contain the exact title.
- No long musical setup. The lyrics must make it obvious that vocals start right away.
- The ${CHARACTER_CLAP_NAME} (two claps before each chorus drop) and an open-ending question are always required
- The character "${CHARACTER_NAME}" can appear naturally, but it is not required in every song
- What makes it a ${BRAND_NAME} song is the ENERGY, WARMTH, and SILLINESS — not constant name-dropping

REQUIREMENTS:
- Production render target: ${MUSIC_TARGET_LENGTH}.
- Word count: ${MUSIC_NORMAL_WORD_RANGE} words for normal songs. NEVER go below ${MUSIC_MIN_WORDS} words unless the user explicitly asked for a short/jingle.
- Short and punchy is good; tiny micro-jingles are not. Build length through repeatable choruses, call-and-response, bridge, final chorus, and sound-effect callbacks.
- Chorus: 4-8 lines, simple enough for a 4-year-old to sing after one listen
- The main hook/chorus must repeat at least two times — ideally three if it feels natural
- At least ONE physical action kids can do
- At least ONE sound kids can copy
- Vocabulary: mostly 1-2 syllable words. Long words only for comedy effect
- ${BRAND_PROFILE.lyrics.required_closing}

STRUCTURE — pick what serves the song, but target ${MUSIC_TARGET_LENGTH}:

OPTION A — Hook-first repeat (~1:30-2:15):
[INTRO] → [HOOK] → [VERSE 1] → [CHORUS] → [VERSE 2] → [CHORUS] → [OUTRO]

OPTION B — Classic pop (~2:00-3:00):
[INTRO] → [VERSE 1] → [PRE-CHORUS] → [CHORUS] → [VERSE 2] → [CHORUS] → [BRIDGE] → [FINAL CHORUS] → [OUTRO]

OPTION C — Call and response (~1:30-2:30):
[INTRO] → [CALL/RESPONSE 1] → [CHORUS] → [CALL/RESPONSE 2] → [CHORUS] → [SILLY BREAKDOWN] → [FINAL CHORUS] → [OUTRO]

OPTION D — Comedy/chaos (~1:30-2:30):
Follow the joke, but keep enough sections for a complete song. Unexpected stops, robot malfunctions, and sound effects are valid only as lyric words, not bracket notes or stage directions.

Output your response as a JSON object:
{
  "title": "The Song Title",
  "lyrics": "full lyrics text with only plain section markers like [INTRO], [CHORUS], [VERSE 1]. No emoji. No stage directions. No bracket descriptors.",
  "chorus_lines": ["line1", "line2", "line3", "line4"],
  "physical_action_cue": "description of the main physical action",
  "funny_long_word": "the comedic long word used",
  "word_count": 220,
  "structure_used": "A|B|C|D — which structure option you chose and why",
  "key_hook": "the one line kids will still be singing tomorrow; must contain or directly reinforce the exact title",
  "audio_prompt": {
    "style": "description of musical style",
    "tempo_bpm": ${MUSIC_DEFAULT_BPM},
    "genre": "${MUSIC_DEFAULT_STYLE}",
    "instrumentation": "description of instruments",
    "energy": "description of energy level",
    "mood": "happy/silly/adventurous/chaotic — match the actual song",
    "voice_style": "bright, child-friendly, energetic — match the tone and topic of the song",
    "structure_note": "describe the actual structure used and say vocals start immediately",
    "target_length": "${MUSIC_TARGET_LENGTH} unless intentionally marked short",
    "first_vocal_by_seconds": ${FIRST_VOCAL_BY_SECONDS},
    "max_instrumental_intro_seconds": ${MAX_INSTRUMENTAL_INTRO_SECONDS},
    "exact_title_usage": "Exact title appears in opening vocal line, chorus, and final chorus",
    "special_notes": "Include: vocals begin immediately; no instrumental intro; exact title must be sung clearly in first 5 seconds and repeated in chorus; no lyric stage directions, no bracket descriptors, no emoji"
  }
}`;

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
  };
}

function sanitizeSongData(songData, topic) {
  const rawLyrics = songData.lyrics || '';
  const markupIssues = findNonSingableLyricMarkup(rawLyrics);
  const cleanedAudioPrompt = sanitizeAudioPrompt(songData.audio_prompt || {});

  const sanitized = {
    ...songData,
    title: stripEmojis(songData.title || topic.substring(0, 50)).trim(),
    lyrics: sanitizeLyricsForQA(rawLyrics),
    key_hook: songData.key_hook ? stripEmojis(songData.key_hook).trim() : songData.key_hook,
    physical_action_cue: songData.physical_action_cue ? stripEmojis(songData.physical_action_cue).trim() : songData.physical_action_cue,
    funny_long_word: songData.funny_long_word ? stripEmojis(songData.funny_long_word).trim() : songData.funny_long_word,
    chorus_lines: Array.isArray(songData.chorus_lines)
      ? songData.chorus_lines.map(line => stripEmojis(line).trim())
      : songData.chorus_lines,
    audio_prompt: cleanedAudioPrompt,
  };

  if (markupIssues.length > 0) {
    sanitized.lyric_markup_warnings = markupIssues;
  }

  return sanitized;
}

function sanitizeAudioPrompt(audioPrompt) {
  const cleaned = { ...audioPrompt };

  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value !== 'string') continue;
    cleaned[key] = stripEmojis(value).trim();
  }

  if (cleaned.special_notes) {
    cleaned.special_notes = cleaned.special_notes
      .replace(/\[[^\]]+\]/g, '')
      .replace(/\*[^*]+\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return cleaned;
}

function formatLyricsMarkdown(songData) {
  const title = songData.title || 'Untitled Song';
  const lyrics = sanitizeLyricsForQA(songData.lyrics || '');

  let md = `# ${title}\n\n`;
  md += `**Key Hook:** ${songData.key_hook || 'TBD'}\n`;
  md += `**Physical Action:** ${songData.physical_action_cue || 'TBD'}\n`;
  md += `**Word Count:** ~${songData.word_count || '?'}\n`;
  if (songData.lyric_markup_warnings?.length) {
    md += `**Auto-cleaned lyric markup:** ${songData.lyric_markup_warnings.length} issue(s) removed before render\n`;
  }
  md += `\n---\n\n`;
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
  prompt += `**Instrumentation:** ${ap.instrumentation || 'bright synths, light percussion, fun sound effects'}\n`;
  prompt += `**Energy:** ${ap.energy || 'high energy, bouncy'}\n`;
  prompt += `**Mood:** ${ap.mood || 'happy, silly'}\n`;
  prompt += `**Voice Style:** ${ap.voice_style || 'bright, child-friendly, slight robotic undertone'}\n`;
  prompt += `**Structure:** ${ap.structure_note || 'vocals start immediately, verse, chorus, verse, chorus, bridge/funny break if useful, final chorus, outro'}\n`;
  prompt += `**Target Length:** ${ap.target_length || MUSIC_TARGET_LENGTH}\n`;
  prompt += `**First Vocal By:** ${ap.first_vocal_by_seconds ?? FIRST_VOCAL_BY_SECONDS} seconds\n`;
  prompt += `**Max Instrumental Intro:** ${ap.max_instrumental_intro_seconds ?? MAX_INSTRUMENTAL_INTRO_SECONDS} seconds\n`;
  prompt += `**Exact Title Usage:** ${ap.exact_title_usage || 'Exact title appears in opening vocal line, chorus, and final chorus'}\n`;
  prompt += `**Render Safety:** Vocals begin immediately within 0-3 seconds. No instrumental intro. Maximum non-vocal opening 5 seconds. The exact title must be sung clearly in the first 5 seconds and repeated in the chorus. Lyrics sent to the renderer are cleaned to singable words only with no emoji, section labels, or stage directions.\n`;
  if (ap.special_notes) {
    prompt += `**Special Notes:** ${ap.special_notes}\n`;
  }
  prompt += `\n---\n\n`;
  prompt += `## Full Lyrics\n\n`;
  prompt += lyrics;
  prompt += `\n`;

  return prompt;
}
