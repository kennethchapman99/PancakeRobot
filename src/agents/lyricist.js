/**
 * Lyricist Agent — Writes complete lyrics and audio generation prompts
 *
 * Takes: research report + brand bible + topic
 * Outputs: lyrics.md + audio-prompt.md per song
 */

import { runAgent, parseAgentJson, loadConfig } from '../shared/managed-agent.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const LYRICIST_DEF = {
  name: 'Pancake Robot Lyricist',
  noTools: true,
  system: `You are the head songwriter for Pancake Robot, a children's music brand for ages 4-10.

You specialize in writing songs that kids want to hear on repeat — not because parents force them to, but because kids genuinely can't stop.

Your expertise:
- Writing choruses simple enough for 3-year-olds to sing but fun enough for 10-year-olds
- Engineering earworms through repetition, rhythm, and unexpected musical moments
- Age-appropriate vocabulary
- Physical engagement cues that get kids moving
- Call-and-response structures that make kids feel like they're part of the song
- The art of the "BRIDGE" — the silly/unexpected moment that makes the song memorable

You follow the Pancake Robot brand voice and always stay within age-appropriate guardrails.
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
    : 'Build a cheerful, playful Pancake Robot character who loves pancakes and adventure.';

  const existingLyricsContext = existingLyrics
    ? `\n\nEXISTING LYRICS TO REVISE:\n\`\`\`\n${existingLyrics}\n\`\`\`\nRevise the above lyrics based on the feedback below. Keep what is working, fix what is asked.`
    : '';

  const revisionContext = revisionNotes
    ? `\n\n${existingLyrics ? 'EDITOR FEEDBACK' : 'REVISION NOTES FROM BRAND REVIEW'}:\n${revisionNotes}\nPlease address ALL of these specific concerns.`
    : '';

  const lyricsTask = `${existingLyrics ? 'Revise' : 'Write'} a complete, production-ready children's song for the Pancake Robot brand on this topic: "${topic}"
${existingLyricsContext}${revisionContext}

BRAND CONTEXT:
${brandSummary}

RESEARCH INSIGHTS:
${researchSummary}

TITLE FIDELITY RULES — HARD REQUIREMENTS:
- If the topic includes an explicit title, for example "title: Something Went Wrong Again" or a quoted title, preserve that title EXACTLY in the title field.
- If no explicit title is provided, choose one creative title — then treat it as LOCKED.
- The locked exact title must appear word-for-word in:
  1. the first singable line in [INTRO - VOCALS START IMMEDIATELY]
  2. the [CHORUS]
  3. the [FINAL CHORUS] or last chorus repeat
  4. audio_prompt.special_notes
- Do NOT create title variants in the lyrics. If the title is "Something Went Wrong Again", do not change it to "Oopsie Again" or "Something Went Wrong".
- The chorus must be built around the exact title, not a looser related hook.

TITLE STYLE GUIDANCE:
- The title should be creative and topic-first. Good examples: "Raining Taco Dogs", "The Counting Stomp", "Wiggle Like a Jellyfish"
- Do NOT default to "Pancake Robot [topic]" — that pattern is overused and boring
- Only include the character name "Pancake Robot" in the title if it genuinely adds humor or surprise for THIS specific topic
- A great title makes a child say "wait, WHAT?" — lean into that

LYRICS RULES:
- Start with [INTRO - VOCALS START IMMEDIATELY] and make the first singable line contain the exact title.
- No long musical setup. The lyrics must make it obvious that vocals start right away.
- The Pancake Robot Clap (two claps before each chorus drop) and an open-ending question are always required
- The character "Pancake Robot" can appear naturally, but it is not required in every song
- What makes it a Pancake Robot song is the ENERGY, WARMTH, and SILLINESS — not constant name-dropping

REQUIREMENTS:
- Production render target: 1:30–3:00.
- Word count: 140-320 words for normal songs. NEVER go below 120 words unless the user explicitly asked for a short/jingle.
- Short and punchy is good; tiny micro-jingles are not. Build length through repeatable choruses, call-and-response, bridge, final chorus, and sound-effect callbacks.
- Chorus: 4-8 lines, simple enough for a 4-year-old to sing after one listen
- The main hook/chorus must repeat at least two times — ideally three if it feels natural
- At least ONE physical action kids can do
- At least ONE sound kids can copy
- Vocabulary: mostly 1-2 syllable words. Long words only for comedy effect
- End with an open question or forward tease — never a goodbye or resolution

STRUCTURE — pick what serves the song, but target 1:30–3:00:

OPTION A — Hook-first repeat (~1:30-2:15):
[INTRO - VOCALS START IMMEDIATELY] → [HOOK] → [VERSE 1] → [CHORUS] → [VERSE 2] → [CHORUS] → [OUTRO]

OPTION B — Classic pop (~2:00-3:00):
[INTRO - VOCALS START IMMEDIATELY] → [VERSE 1] → [PRE-CHORUS] → [CHORUS] → [VERSE 2] → [CHORUS] → [BRIDGE] → [FINAL CHORUS] → [OUTRO]

OPTION C — Call and response (~1:30-2:30):
[INTRO - VOCALS START IMMEDIATELY] → [CALL/RESPONSE 1] → [CHORUS] → [CALL/RESPONSE 2] → [CHORUS] → [SILLY BREAKDOWN] → [FINAL CHORUS] → [OUTRO]

OPTION D — Comedy/chaos (~1:30-2:30):
Follow the joke, but keep enough sections for a complete song. Unexpected stops, robot malfunctions, sound effects AS lyrics — all valid.

Output your response as a JSON object:
{
  "title": "The Song Title",
  "lyrics": "full lyrics text with section markers like [INTRO - VOCALS START IMMEDIATELY], [CHORUS], [VERSE 1], etc.",
  "chorus_lines": ["line1", "line2", "line3", "line4"],
  "physical_action_cue": "description of the main physical action",
  "funny_long_word": "the comedic long word used",
  "word_count": 220,
  "structure_used": "A|B|C|D — which structure option you chose and why",
  "key_hook": "the one line kids will still be singing tomorrow; must contain or directly reinforce the exact title",
  "audio_prompt": {
    "style": "description of musical style",
    "tempo_bpm": 118,
    "genre": "upbeat children's pop",
    "instrumentation": "description of instruments",
    "energy": "description of energy level",
    "mood": "happy/silly/adventurous/chaotic — match the actual song",
    "voice_style": "bright, child-friendly, energetic — match the tone and topic of the song",
    "structure_note": "describe the actual structure used and say vocals start immediately",
    "target_length": "1:30-3:00 unless intentionally marked short",
    "first_vocal_by_seconds": 3,
    "max_instrumental_intro_seconds": 5,
    "exact_title_usage": "Exact title appears in opening vocal line, chorus, and final chorus",
    "special_notes": "Include: vocals begin immediately; no instrumental intro; exact title must be sung clearly in first 5 seconds and repeated in chorus; plus any sound effects, robot malfunctions, chaos moments, or musical jokes"
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

function formatLyricsMarkdown(songData) {
  const title = songData.title || 'Untitled Song';
  const lyrics = songData.lyrics || '';

  let md = `# ${title}\n\n`;
  md += `**Key Hook:** ${songData.key_hook || 'TBD'}\n`;
  md += `**Physical Action:** ${songData.physical_action_cue || 'TBD'}\n`;
  md += `**Word Count:** ~${songData.word_count || '?'}\n\n`;
  md += `---\n\n`;
  md += lyrics;
  md += `\n`;

  return md;
}

function formatAudioPrompt(songData) {
  const ap = songData.audio_prompt || {};
  const lyrics = songData.lyrics || '';

  let prompt = `# Audio Generation Prompt\n\n`;
  prompt += `## Song: ${songData.title || 'Untitled'}\n\n`;
  prompt += `## Music Specs\n\n`;
  prompt += `**Style:** ${ap.tempo_bpm || 118} BPM, ${ap.genre || 'upbeat children\'s pop'}\n`;
  prompt += `**Instrumentation:** ${ap.instrumentation || 'bright synths, light percussion, fun sound effects'}\n`;
  prompt += `**Energy:** ${ap.energy || 'high energy, bouncy'}\n`;
  prompt += `**Mood:** ${ap.mood || 'happy, silly'}\n`;
  prompt += `**Voice Style:** ${ap.voice_style || 'bright, child-friendly, slight robotic undertone'}\n`;
  prompt += `**Structure:** ${ap.structure_note || 'vocals start immediately, verse, chorus, verse, chorus, bridge/funny break if useful, final chorus, outro'}\n`;
  prompt += `**Target Length:** ${ap.target_length || '1:30-3:00'}\n`;
  prompt += `**First Vocal By:** ${ap.first_vocal_by_seconds ?? 3} seconds\n`;
  prompt += `**Max Instrumental Intro:** ${ap.max_instrumental_intro_seconds ?? 5} seconds\n`;
  prompt += `**Exact Title Usage:** ${ap.exact_title_usage || 'Exact title appears in opening vocal line, chorus, and final chorus'}\n`;
  prompt += `**Render Safety:** Vocals begin immediately within 0-3 seconds. No instrumental intro. Maximum non-vocal opening 5 seconds. The exact title must be sung clearly in the first 5 seconds and repeated in the chorus.\n`;
  if (ap.special_notes) {
    prompt += `**Special Notes:** ${ap.special_notes}\n`;
  }
  prompt += `\n---\n\n`;
  prompt += `## Full Lyrics\n\n`;
  prompt += lyrics;
  prompt += `\n`;

  return prompt;
}
