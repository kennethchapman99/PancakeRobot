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
  noTools: true, // Pure creative writing — no web search needed
  system: `You are the head songwriter for Pancake Robot, a children's music brand for ages 4-10.

You specialize in writing songs that kids want to hear on repeat — not because parents force them to, but because kids genuinely can't stop.

Your expertise:
- Writing choruses simple enough for 3-year-olds to sing but fun enough for 10-year-olds
- Engineering earworms through repetition, rhythm, and unexpected musical moments
- Age-appropriate vocabulary (mostly 1-2 syllable words, occasional funny long word for comedy)
- Physical engagement cues that get kids moving (clap, jump, spin, stomp)
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
    ? `\n\nEXISTING LYRICS TO REVISE:\n\`\`\`\n${existingLyrics}\n\`\`\`\nRevise the above lyrics based on the feedback below. Keep what's working, fix what's asked.`
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

TITLE RULES — read carefully:
- The title should be creative and topic-first. Good examples: "Raining Taco Dogs", "The Counting Stomp", "Wiggle Like a Jellyfish"
- Do NOT default to "Pancake Robot [topic]" — that pattern is overused and boring
- Only include the character name "Pancake Robot" in the title if it genuinely adds humor or surprise for THIS specific topic
- A great title makes a child say "wait, WHAT?" — lean into that

LYRICS RULES:
- The character "Pancake Robot" can appear in the lyrics naturally, but is not required in every song
- Songs can be about ANY topic — animals, weather, counting, space, silly food, emotions — not always about pancakes
- What makes it a Pancake Robot song is the ENERGY, WARMTH, and SILLINESS — not constant name-dropping
- The Pancake Robot Clap (two claps before each chorus drop) and an open-ending question are always required

REQUIREMENTS:
- Word count: 80-150 words is the sweet spot. NEVER exceed 200. Short and punchy beats long and wordy every time.
- If the song is done in 80 words, it's done — do not pad it
- Chorus: 2-6 lines, simple enough for a 4-year-old to sing after one listen
- The main hook/chorus must repeat at least twice — this IS the earworm
- At least ONE physical action kids can do (clap, jump, stomp, wiggle, spin)
- At least ONE sound kids can copy (beep, sizzle, WHOMP, clap pattern, robot noise)
- Vocabulary: mostly 1-2 syllable words. Long words only for comedy effect ("SPATULA!", "MALFUNCTIONING!")
- End with an open question or forward tease — never a goodbye or resolution

STRUCTURE — pick what serves the song, don't force a template:

OPTION A — Simple repeat (best for short silly songs, 60-90 sec):
[HOOK] → [VERSE] → [HOOK] → [VERSE] → [HOOK] → [OUTRO]

OPTION B — Classic pop (best for educational/narrative songs, ~2 min):
[INTRO] → [VERSE 1] → [CHORUS] → [VERSE 2] → [CHORUS] → [BRIDGE] → [CHORUS x2] → [OUTRO]

OPTION C — Call and response (best for movement songs):
[CALL] → [RESPONSE] repeated, no traditional structure needed

OPTION D — Comedy/chaos (best for absurdist concepts):
Follow the joke. Unexpected stops, robot malfunctions, sound effects AS lyrics — all valid.

Use whichever structure makes THIS song best. A 70-word chaos song is better than a padded 200-word one.

Output your response as a JSON object:
{
  "title": "The Song Title",
  "lyrics": "full lyrics text with section markers like [CHORUS], [VERSE 1], etc.",
  "chorus_lines": ["line1", "line2", "line3", "line4"],
  "physical_action_cue": "description of the main physical action",
  "funny_long_word": "the comedic long word used",
  "word_count": 100,
  "structure_used": "A|B|C|D — which structure option you chose and why",
  "key_hook": "the one line kids will still be singing tomorrow",
  "audio_prompt": {
    "style": "description of musical style",
    "tempo_bpm": 110,
    "genre": "upbeat children's pop",
    "instrumentation": "description of instruments",
    "energy": "description of energy level",
    "mood": "happy/silly/adventurous/chaotic — match the actual song",
    "voice_style": "bright, child-friendly, energetic — match the tone and topic of the song",
    "structure_note": "describe the actual structure used (e.g. 'simple repeating hook' or 'call and response')",
    "target_length": "match the lyrics — 60 seconds for short songs, up to 2 min for classic structure",
    "special_notes": "any specific sound effects, robot malfunctions, chaos moments, or musical jokes"
  }
}`;

  const result = await runAgent('lyricist', LYRICIST_DEF, lyricsTask);

  let songData;
  try {
    songData = parseAgentJson(result.text);
  } catch {
    // Fallback: extract what we can
    songData = {
      title: topic.substring(0, 50),
      lyrics: result.text,
      parse_error: true,
    };
  }

  // Save lyrics.md
  const lyricsContent = formatLyricsMarkdown(songData);
  const lyricsPath = join(songDir, 'lyrics.md');
  fs.writeFileSync(lyricsPath, lyricsContent);

  // Save audio-prompt.md
  const audioPromptContent = formatAudioPrompt(songData);
  const audioPromptPath = join(songDir, 'audio-prompt.md');
  fs.writeFileSync(audioPromptPath, audioPromptContent);

  // Save raw data
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
  prompt += `**Style:** ${ap.tempo_bpm || 110} BPM, ${ap.genre || 'upbeat children\'s pop'}\n`;
  prompt += `**Instrumentation:** ${ap.instrumentation || 'bright synths, light percussion, fun sound effects'}\n`;
  prompt += `**Energy:** ${ap.energy || 'high energy, bouncy'}\n`;
  prompt += `**Mood:** ${ap.mood || 'happy, silly'}\n`;
  prompt += `**Voice Style:** ${ap.voice_style || 'bright, child-friendly, slight robotic undertone'}\n`;
  prompt += `**Structure:** ${ap.structure_note || 'intro, verse, chorus x3, verse, chorus, bridge, chorus x2, outro'}\n`;
  prompt += `**Target Length:** ${ap.target_length || '~2 minutes'}\n`;
  if (ap.special_notes) {
    prompt += `**Special Notes:** ${ap.special_notes}\n`;
  }
  prompt += `\n---\n\n`;
  prompt += `## Full Lyrics\n\n`;
  prompt += lyrics;
  prompt += `\n`;

  return prompt;
}
