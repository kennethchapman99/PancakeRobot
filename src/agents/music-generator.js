/**
 * Music Generator Agent — MiniMax Music 2.6
 *
 * Final rule: MiniMax and any future provider receive only singable lyric lines.
 * Section labels, markdown, stage directions, emoji, prompt artifacts, and active
 * profile contamination are blocked before any paid render call.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  addRenderSafetyToPrompt,
  runPostRenderAudioQACheck,
  runPreRenderQAGate,
} from '../shared/song-qa.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import { sanitizeLyricsForProvider } from '../shared/lyrics-sanitizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_PROFILE = loadBrandProfile();

const MINIMAX_BASE = 'https://api.minimax.io/v1';
const PAID_MODEL = 'music-2.6';
const FREE_MODEL = 'music-2.6-free';
const POLL_INTERVAL_MS = 8000;
const MAX_POLL_ATTEMPTS = 45;

export async function generateMusic({ songId, title, lyricsText, audioPromptData }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  const audioDir = join(songDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const modelConfig = resolveMiniMaxModelConfig();
  const prompt = buildStylePrompt(audioPromptData, { title });

  const preRenderQA = runPreRenderQAGate({
    songId,
    songDir,
    title,
    lyrics: lyricsText,
    stylePrompt: prompt,
    model: modelConfig.model,
  });

  if (!preRenderQA.passed) {
    const summary = preRenderQA.failures.map(issue => `- ${issue}`).join('\n');
    throw new Error(
      `Pre-render QA blocked MiniMax generation for "${title}".\n` +
      `${summary}\n` +
      `See output/songs/${songId}/pre-render-qa.json and PRE_RENDER_QA_FAILED.md`
    );
  }

  if (preRenderQA.warnings.length > 0) {
    console.log('[MUSIC-GEN] Pre-render QA warnings:');
    preRenderQA.warnings.forEach(w => console.log(`  • ${w}`));
  } else {
    console.log('[MUSIC-GEN] ✓ Pre-render QA passed');
  }

  const providerLyricsReport = buildProviderLyricsPayload({ songDir, title, lyricsText });
  const renderLyrics = providerLyricsReport.lyrics;
  const apiKey = process.env.MINIMAX_API_KEY;

  if (!apiKey) {
    console.log('\n[MUSIC-GEN] MINIMAX_API_KEY not set — skipping music generation');
    console.log('[MUSIC-GEN] Add MINIMAX_API_KEY=<your-key> to .env (get key at platform.minimax.io)');

    const instructionsPath = join(audioDir, 'MUSIC_GENERATION_INSTRUCTIONS.md');
    fs.writeFileSync(instructionsPath, buildManualInstructions({ title, lyricsText: renderLyrics, stylePrompt: prompt, modelConfig }));
    console.log(`[MUSIC-GEN] Manual instructions saved to ${instructionsPath}`);

    return { audioFiles: [], skipped: true, instructionsPath, preRenderQA, providerLyricsReport };
  }

  console.log(`\n[MUSIC-GEN] Submitting "${title}" to MiniMax Music 2.6...`);
  console.log(`[MUSIC-GEN] Model: ${modelConfig.model} (${modelConfig.tier})`);
  console.log(`[MUSIC-GEN] Style prompt: ${prompt.substring(0, 100)}...`);
  console.log(`[MUSIC-GEN] Provider lyrics length: ${renderLyrics.length} chars`);

  let audioHex;
  try {
    const result = await submitToMiniMax({ prompt, lyrics: renderLyrics, apiKey, model: modelConfig.model });

    if (result.done) {
      console.log('[MUSIC-GEN] ✓ Synchronous completion');
      audioHex = result.audioHex;
    } else {
      const taskId = result;
      console.log(`[MUSIC-GEN] Task submitted: ${taskId}`);
      console.log(`[MUSIC-GEN] Polling for completion (up to ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60000} min)...`);
      audioHex = await pollUntilComplete({ taskId, apiKey });
    }
  } catch (err) {
    console.log(`[MUSIC-GEN] MiniMax submission failed: ${err.message}`);
    const instructionsPath = join(audioDir, 'MUSIC_GENERATION_INSTRUCTIONS.md');
    fs.writeFileSync(instructionsPath, buildManualInstructions({ title, lyricsText: renderLyrics, stylePrompt: prompt, modelConfig }));
    return { audioFiles: [], skipped: false, apiError: err.message, instructionsPath, preRenderQA, providerLyricsReport };
  }

  if (!audioHex) {
    console.log('[MUSIC-GEN] No audio returned — generation timed out or failed');
    const instructionsPath = join(audioDir, 'MUSIC_GENERATION_INSTRUCTIONS.md');
    fs.writeFileSync(instructionsPath, buildManualInstructions({ title, lyricsText: renderLyrics, stylePrompt: prompt, modelConfig }));
    return { audioFiles: [], skipped: false, error: 'generation timed out or failed', instructionsPath, preRenderQA, providerLyricsReport };
  }

  const filename = `${songId}-v1-${modelConfig.tier}.mp3`;
  const filePath = join(audioDir, filename);

  try {
    const buffer = hexToBuffer(audioHex);
    fs.writeFileSync(filePath, buffer);
    console.log(`[MUSIC-GEN] ✓ Saved ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.log(`[MUSIC-GEN] Failed to write audio file: ${err.message}`);
    return { audioFiles: [], skipped: false, error: err.message, preRenderQA, providerLyricsReport };
  }

  const postRenderQA = runPostRenderAudioQACheck({
    songId,
    songDir,
    title,
    audioFilePath: filePath,
  });

  if (!postRenderQA.passed) {
    console.log('[MUSIC-GEN] ⚠ Post-render audio QA found blocking issues:');
    postRenderQA.failures.forEach(f => console.log(`  • ${f}`));
  }
  if (postRenderQA.warnings.length > 0) {
    console.log('[MUSIC-GEN] Post-render audio QA warnings:');
    postRenderQA.warnings.forEach(w => console.log(`  • ${w}`));
  }

  const meta = {
    generated_at: new Date().toISOString(),
    song_id: songId,
    title,
    service: 'minimax-music-2.6',
    model: modelConfig.model,
    render_tier: modelConfig.tier,
    free_model_toggle: modelConfig.freeToggleEnabled,
    style_prompt: prompt,
    provider_lyrics_chars: renderLyrics.length,
    provider_lyrics_removed_count: providerLyricsReport.removed.length,
    pre_render_qa_passed: preRenderQA.passed,
    post_render_qa_passed: postRenderQA.passed,
    versions: [{ version: 1, tier: modelConfig.tier, model: modelConfig.model, file: filename }],
  };
  fs.writeFileSync(join(audioDir, 'generation-meta.json'), JSON.stringify(meta, null, 2));

  const audioFiles = [{ path: filePath, version: 1, model: modelConfig.model, tier: modelConfig.tier }];
  console.log(`[MUSIC-GEN] ✓ Generated ${audioFiles.length} audio file(s)`);
  return { audioFiles, skipped: false, preRenderQA, postRenderQA, providerLyricsReport };
}

export function buildProviderLyricsPayload({ songDir, title, lyricsText }) {
  const report = sanitizeLyricsForProvider(lyricsText, {
    forbiddenElements: BRAND_PROFILE.songwriting?.forbidden_elements || [],
    blockBrandContamination: true,
  });

  const persistedReport = {
    checked_at: new Date().toISOString(),
    title,
    blocked: report.blocked,
    block_reason: report.blockReason,
    provider_lyrics_chars: report.lyrics.length,
    removed: report.removed,
    residual_issues: report.residualIssues,
    forbidden_hits: report.forbiddenHits,
  };

  if (songDir) {
    fs.writeFileSync(join(songDir, 'provider-lyrics-sanitization.json'), JSON.stringify(persistedReport, null, 2));
  }

  if (report.removed.length > 0) {
    console.log('[MUSIC-GEN] Provider lyrics sanitizer removed:');
    report.removed.forEach(item => {
      console.log(`  • line ${item.line}: ${item.reason}: ${item.content}`);
    });
  }

  if (report.blockReason) {
    throw new Error(report.blockReason);
  }

  if (report.residualIssues.length > 0) {
    throw new Error(`Provider lyric payload blocked: ${report.residualIssues.join('; ')}`);
  }

  console.log('[MUSIC-GEN] ✓ Provider lyrics sanitized for singable-only payload');
  return report;
}

function resolveMiniMaxModelConfig() {
  const freeToggleEnabled = ['1', 'true', 'yes', 'free'].includes(String(process.env.MINIMAX_USE_FREE_MODEL || '').toLowerCase());
  const explicitModel = process.env.MINIMAX_MUSIC_MODEL?.trim();
  const model = freeToggleEnabled ? FREE_MODEL : (explicitModel || PAID_MODEL);
  const tier = model.includes('free') ? 'free' : 'paid';

  return { model, tier, explicitModel: Boolean(explicitModel), freeToggleEnabled };
}

export function buildMiniMaxRequestBody({ prompt, lyrics, model }) {
  return {
    model,
    prompt,
    lyrics,
    lyrics_optimizer: false,
    is_instrumental: false,
    output_format: 'hex',
    audio_setting: {
      format: 'mp3',
      bitrate: 256000,
      sample_rate: 44100,
    },
  };
}

async function submitToMiniMax({ prompt, lyrics, apiKey, model }) {
  const body = buildMiniMaxRequestBody({ prompt, lyrics, model });

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

  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
  }

  if (data.data?.status === 2 && data.data?.audio) return { done: true, audioHex: data.data.audio };

  const taskId = data.data?.task_id || data.task_id;
  if (!taskId) throw new Error(`Unexpected MiniMax response: ${JSON.stringify(data).substring(0, 200)}`);
  return taskId;
}

async function pollUntilComplete({ taskId, apiKey }) {
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
      }
      if (status === 3) {
        console.log(`[MUSIC-GEN] ✗ Task failed: ${data.data?.err_msg || 'unknown error'}`);
        return null;
      }
      if (attempt % 3 === 0) console.log(`[MUSIC-GEN] Poll ${attempt + 1}: status=${status ?? '?'} — still processing...`);
    } catch (err) {
      console.log(`[MUSIC-GEN] Poll error: ${err.message}`);
    }
  }

  return null;
}

function hexToBuffer(hex) {
  if (!hex || hex.length === 0) throw new Error('Empty hex audio data');
  const cleanHex = hex.replace(/\s/g, '');
  const buf = Buffer.allocUnsafe(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    buf[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return buf;
}

export function buildStylePrompt(audioPrompt, { title } = {}) {
  const adultBallad = isAdultBalladDirection(audioPrompt, title);
  const parts = [];

  if (adultBallad) {
    parts.push('slow heartfelt adult dedication ballad');
    parts.push('72-82 BPM');
    parts.push('piano-led arrangement');
    parts.push('gentle strings');
    parts.push('warm intimate lead vocal');
    parts.push('no dance beat');
    parts.push('no call-and-response');
    parts.push("no children's-song energy");
    parts.push('no novelty sound effects');
  }

  if (!audioPrompt) {
    parts.push(BRAND_PROFILE.music.default_prompt);
  } else {
    if (audioPrompt.genre) parts.push(audioPrompt.genre);
    if (audioPrompt.tempo_bpm) parts.push(`${audioPrompt.tempo_bpm} BPM`);
    if (audioPrompt.key) parts.push(audioPrompt.key);
    if (audioPrompt.mood) parts.push(audioPrompt.mood);
    if (audioPrompt.instrumentation) parts.push(audioPrompt.instrumentation);
    if (audioPrompt.voice_style) parts.push(`vocals: ${audioPrompt.voice_style}`);
    if (audioPrompt.energy) parts.push(audioPrompt.energy);
    if (audioPrompt.structure_note) parts.push(audioPrompt.structure_note);
    if (audioPrompt.special_notes) parts.push(audioPrompt.special_notes);
  }

  parts.push(BRAND_PROFILE.music.default_style);
  parts.push(BRAND_PROFILE.brand_description);
  parts.push(`audience: ${BRAND_PROFILE.audience.description || BRAND_PROFILE.audience.age_range}`);
  parts.push(`guardrail: ${BRAND_PROFILE.audience.guardrail}`);

  const basePrompt = [...new Set(parts.filter(Boolean).map(part => String(part).trim()).filter(Boolean))].join(', ');
  return addRenderSafetyToPrompt(basePrompt, title);
}

function isAdultBalladDirection(audioPrompt, title) {
  const text = [
    title,
    BRAND_PROFILE.brand_name,
    BRAND_PROFILE.brand_type,
    BRAND_PROFILE.brand_description,
    BRAND_PROFILE.music.default_style,
    BRAND_PROFILE.music.default_prompt,
    audioPrompt ? JSON.stringify(audioPrompt) : '',
  ].join(' ').toLowerCase();

  return /\b(ballad|slow|mother'?s day|adult dedication|dedication|personal_family_ballad|sue)\b/i.test(text);
}

function buildManualInstructions({ title, lyricsText, stylePrompt, modelConfig }) {
  const model = modelConfig?.model || PAID_MODEL;
  const tier = modelConfig?.tier || 'paid';

  return `# Music Generation: ${title}

## MiniMax Music Generation
Go to https://platform.minimax.io → Music Generation

**Model:** ${model} (${tier})

To audition cheaply/free first, set:
\`\`\`env
MINIMAX_USE_FREE_MODEL=true
\`\`\`

To render the production version, unset that toggle or set:
\`\`\`env
MINIMAX_USE_FREE_MODEL=false
MINIMAX_MUSIC_MODEL=music-2.6
\`\`\`

**Style Prompt** (paste into "prompt" field, ≤2000 chars):
\`\`\`
${stylePrompt.substring(0, 2000)}
\`\`\`

**Lyrics** (paste into "lyrics" field — final provider-safe singable lines only, ≤3500 chars):
\`\`\`
${lyricsText}
\`\`\`

Format: MP3, 44100 Hz, 256 kbps
Lyrics optimizer: OFF
Instrumental: OFF

## Acceptance rules
- Reject if vocals do not start by 5 seconds.
- Reject if the exact title is not sung in the opening and chorus.
- Reject if the song is under 1:30 unless intentionally marked as a short/jingle.
- Reject if section labels, emoji, markdown, prompt artifacts, or stage directions are spoken/sung.

Full production notes: ../audio-prompt.md
`;
}
