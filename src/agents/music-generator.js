/**
 * Music Generator Agent — MiniMax Music 2.6
 *
 * Converts the lyricist's audio-prompt.md into an actual audio file via MiniMax.
 * Falls back to human instructions if MINIMAX_API_KEY is not set.
 *
 * MiniMax Music API docs: https://platform.minimax.io/docs/api-reference/music-generation
 * Set MINIMAX_API_KEY in .env to enable automated generation.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MINIMAX_BASE = 'https://api.minimax.io/v1';
const MODEL = 'music-2.6-free';   // free tier; swap to 'music-2.6' for paid
const POLL_INTERVAL_MS = 8000;    // 8s between status checks
const MAX_POLL_ATTEMPTS = 45;     // 6 minutes max wait

/**
 * Generate music for a song using MiniMax Music 2.6.
 * Returns { audioFiles, skipped, instructionsPath }
 */
export async function generateMusic({ songId, title, lyricsText, audioPromptData }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  const audioDir = join(songDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const apiKey = process.env.MINIMAX_API_KEY;

  if (!apiKey) {
    console.log('\n[MUSIC-GEN] MINIMAX_API_KEY not set — skipping music generation');
    console.log('[MUSIC-GEN] Add MINIMAX_API_KEY=<your-key> to .env (get key at platform.minimax.io)');

    const instructionsPath = join(audioDir, 'MUSIC_GENERATION_INSTRUCTIONS.md');
    fs.writeFileSync(instructionsPath, buildManualInstructions({ title, lyricsText, audioPromptData }));
    console.log(`[MUSIC-GEN] Manual instructions saved to ${instructionsPath}`);

    return { audioFiles: [], skipped: true, instructionsPath };
  }

  const prompt = buildStylePrompt(audioPromptData);
  const cleanLyrics = stripStageDirections(lyricsText);

  console.log(`\n[MUSIC-GEN] Submitting "${title}" to MiniMax Music 2.6...`);
  console.log(`[MUSIC-GEN] Style prompt: ${prompt.substring(0, 100)}...`);
  console.log(`[MUSIC-GEN] Lyrics length: ${cleanLyrics.length} chars`);

  let audioHex;
  try {
    const result = await submitToMiniMax({ prompt, lyrics: cleanLyrics, apiKey });

    if (result.done) {
      // Synchronous — audio came back immediately (common for music-2.6-free)
      console.log('[MUSIC-GEN] ✓ Synchronous completion');
      audioHex = result.audioHex;
    } else {
      // Async — need to poll by task ID
      const taskId = result;
      console.log(`[MUSIC-GEN] Task submitted: ${taskId}`);
      console.log(`[MUSIC-GEN] Polling for completion (up to ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60000} min)...`);
      audioHex = await pollUntilComplete({ taskId, apiKey });
    }
  } catch (err) {
    console.log(`[MUSIC-GEN] MiniMax submission failed: ${err.message}`);
    const instructionsPath = join(audioDir, 'MUSIC_GENERATION_INSTRUCTIONS.md');
    fs.writeFileSync(instructionsPath, buildManualInstructions({ title, lyricsText, audioPromptData }));
    return { audioFiles: [], skipped: false, apiError: err.message, instructionsPath };
  }

  if (!audioHex) {
    console.log('[MUSIC-GEN] No audio returned — generation timed out or failed');
    const instructionsPath = join(audioDir, 'MUSIC_GENERATION_INSTRUCTIONS.md');
    fs.writeFileSync(instructionsPath, buildManualInstructions({ title, lyricsText, audioPromptData }));
    return { audioFiles: [], skipped: false, error: 'generation timed out or failed', instructionsPath };
  }

  // Write MP3
  const filename = `${songId}-v1.mp3`;
  const filePath = join(audioDir, filename);

  try {
    const buffer = hexToBuffer(audioHex);
    fs.writeFileSync(filePath, buffer);
    console.log(`[MUSIC-GEN] ✓ Saved ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.log(`[MUSIC-GEN] Failed to write audio file: ${err.message}`);
    return { audioFiles: [], skipped: false, error: err.message };
  }

  // Save generation metadata
  const meta = {
    generated_at: new Date().toISOString(),
    song_id: songId,
    title,
    service: 'minimax-music-2.6',
    model: MODEL,
    style_prompt: prompt,
    versions: [{ version: 1, file: filename }],
  };
  fs.writeFileSync(join(audioDir, 'generation-meta.json'), JSON.stringify(meta, null, 2));

  const audioFiles = [{ path: filePath, version: 1 }];
  console.log(`[MUSIC-GEN] ✓ Generated ${audioFiles.length} audio file(s)`);
  return { audioFiles, skipped: false };
}

// ─────────────────────────────────────────────
// MiniMax API helpers
// ─────────────────────────────────────────────

/**
 * Submit a music generation request to MiniMax.
 * Returns task_id if async, or resolves with audio hex if synchronous.
 */
async function submitToMiniMax({ prompt, lyrics, apiKey }) {
  const body = {
    model: MODEL,
    prompt,
    lyrics,
    is_instrumental: false,
    output_format: 'hex',
    audio_setting: {
      format: 'mp3',
      bitrate: 256000,   // MiniMax valid values: 32000/64000/128000/256000
      sample_rate: 44100,
    },
  };

  const res = await fetch(`${MINIMAX_BASE}/music_generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MiniMax API ${res.status}: ${text.substring(0, 300)}`);
  }

  const data = await res.json();

  // Check API-level error
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
  }

  // If already complete (status: 2), return audio directly
  if (data.data?.status === 2 && data.data?.audio) {
    return { done: true, audioHex: data.data.audio };
  }

  // Async: return task ID to poll
  const taskId = data.data?.task_id || data.task_id;
  if (!taskId) {
    throw new Error(`Unexpected MiniMax response: ${JSON.stringify(data).substring(0, 200)}`);
  }
  return taskId;
}

async function pollUntilComplete({ taskId, apiKey }) {
  // Handle case where submitToMiniMax returned {done, audioHex} synchronously
  if (taskId && typeof taskId === 'object' && taskId.done) {
    console.log('[MUSIC-GEN] ✓ Synchronous completion');
    return taskId.audioHex;
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const res = await fetch(`${MINIMAX_BASE}/music_generation?task_id=${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!res.ok) {
        console.log(`[MUSIC-GEN] Poll ${attempt + 1}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const status = data.data?.status;
      const audio = data.data?.audio;

      if (status === 2 && audio) {
        console.log(`[MUSIC-GEN] ✓ Complete after ${attempt + 1} poll(s)`);
        return audio;
      } else if (status === 3) {
        console.log(`[MUSIC-GEN] ✗ Task failed: ${data.data?.err_msg || 'unknown error'}`);
        return null;
      } else {
        if (attempt % 3 === 0) console.log(`[MUSIC-GEN] Poll ${attempt + 1}: status=${status ?? '?'} — still processing...`);
      }
    } catch (err) {
      console.log(`[MUSIC-GEN] Poll error: ${err.message}`);
    }
  }

  return null; // timed out
}

function hexToBuffer(hex) {
  // MiniMax returns hex-encoded audio — convert to binary buffer
  if (!hex || hex.length === 0) throw new Error('Empty hex audio data');
  const cleanHex = hex.replace(/\s/g, '');
  const buf = Buffer.allocUnsafe(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    buf[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return buf;
}

// ─────────────────────────────────────────────
// Prompt formatting helpers
// ─────────────────────────────────────────────

/**
 * Build a style/mood prompt for MiniMax's `prompt` field (≤2000 chars).
 * This is separate from lyrics — it describes the musical style, not the words.
 */
function buildStylePrompt(audioPrompt) {
  if (!audioPrompt) {
    return "Upbeat children's pop song, 110 BPM, C Major, bright and silly, fun for kids ages 4-10, hand claps, xylophone, singalong chorus, cheerful vocals";
  }

  const parts = [];

  if (audioPrompt.genre) parts.push(audioPrompt.genre);
  if (audioPrompt.tempo_bpm) parts.push(`${audioPrompt.tempo_bpm} BPM`);
  if (audioPrompt.key) parts.push(audioPrompt.key);
  if (audioPrompt.mood) parts.push(audioPrompt.mood);
  if (audioPrompt.instrumentation) parts.push(audioPrompt.instrumentation);
  if (audioPrompt.voice_style) parts.push(`vocals: ${audioPrompt.voice_style}`);
  if (audioPrompt.energy) parts.push(audioPrompt.energy);

  // Always ground in kids music context
  parts.push("children's music, family friendly, ages 4-10, singalong");

  return [...new Set(parts)].join(', ').substring(0, 2000);
}

/**
 * Strip everything that isn't singable before sending to MiniMax.
 *
 * The lyricist writes a metadata header (Key Hook, Physical Action, Word Count)
 * above the first section marker. MiniMax sings it all literally, so we must
 * remove it. We also strip inline stage directions and emoji.
 */
function stripStageDirections(lyrics) {
  if (!lyrics) return '';

  let text = lyrics;

  // ── 1. Drop the metadata header block ─────────────────────
  // Everything before the first [SECTION] marker (INTRO, VERSE, CHORUS, etc.)
  // is production notes — title, key hook, physical action, word count.
  const firstSectionMatch = text.match(/\[(INTRO|VERSE|CHORUS|BRIDGE|OUTRO|PRE-CHORUS|HOOK|INTERLUDE|BREAKDOWN)/i);
  if (firstSectionMatch) {
    text = text.slice(firstSectionMatch.index);
  }

  // ── 2. Remove Markdown heading and bold lines ──────────────
  // e.g. "# One Two Three FLIP!" or "**Key Hook:** ..."
  text = text.replace(/^#{1,6}\s+.*/gm, '');
  text = text.replace(/^\*\*[^*]+\*\*:.*/gm, '');
  text = text.replace(/^---+\s*$/gm, '');

  // ── 3. Strip long bracketed action cues ───────────────────
  // Keep short structural tags [VERSE], [CHORUS] etc. (≤20 chars)
  // Remove long ones like [flip your hands UP on every FLIP FLIP FLIP!]
  text = text.replace(/\[(?!VERSE|CHORUS|BRIDGE|INTRO|OUTRO|PRE-CHORUS|HOOK|INTERLUDE|BREAKDOWN|Verse|Chorus|Bridge|Intro|Outro)[^\]]{15,}\]/g, '');

  // ── 4. Strip inline parenthetical action cues ─────────────
  // e.g. "(flip your arms up!)" — keep short ones like "(spoken: Whaaat?!)"
  // Remove if they start with a movement verb
  text = text.replace(/\((?:flip|clap|stomp|jump|wave|spin|shake|raise|lift|point|wiggle|bounce)[^)]*\)/gi, '');

  // ── 5. Remove emoji ────────────────────────────────────────
  text = text.replace(/[\u{1F300}-\u{1FFFF}]/gu, '');
  text = text.replace(/^[🤖🎵🥞⚡❌✨🎶].*/gm, '');

  // ── 6. Collapse extra blank lines ─────────────────────────
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

// ─────────────────────────────────────────────
// Manual fallback instructions
// ─────────────────────────────────────────────

function buildManualInstructions({ title, lyricsText, audioPromptData }) {
  const cleanLyrics = stripStageDirections(lyricsText);
  const stylePrompt = buildStylePrompt(audioPromptData).substring(0, 2000);

  return `# Music Generation: ${title}

## Option A — MiniMax Music (Recommended)
Go to https://platform.minimax.io → Music Generation

**Style Prompt** (paste into "prompt" field, ≤2000 chars):
\`\`\`
${stylePrompt}
\`\`\`

**Lyrics** (paste into "lyrics" field — ≤3500 chars):
\`\`\`
${cleanLyrics}
\`\`\`

Model: music-2.6-free (or music-2.6 for paid)
Format: MP3, 44100 Hz, 192 kbps

## Option B — Suno (Manual)
Go to https://suno.com → Create → Custom
- Style field (≤1000 chars): ${stylePrompt.substring(0, 1000)}
- Lyrics field (no limit): paste full lyrics above

**Step 3** — Download the best version → save as \`${title.toLowerCase().replace(/\s+/g,'-')}-v1.mp3\` in this folder

Full production notes: ../audio-prompt.md
`;
}
