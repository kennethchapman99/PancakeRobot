/**
 * Song QA helpers for Pancake Robot render safety.
 *
 * These checks are deterministic and intentionally strict. The goal is to block
 * weak render packs before MiniMax burns a generation, then flag obvious audio
 * problems after render.
 */

import fs from 'fs';
import { join } from 'path';

export const MIN_FULL_SONG_WORDS = 120;
export const MIN_FULL_SONG_DURATION_SECONDS = 90;
export const MAX_INSTRUMENTAL_INTRO_SECONDS = 5;
export const FIRST_VOCAL_REQUIRED_BY_SECONDS = 5;
export const MAX_RENDER_PROMPT_CHARS = 2000;

const ALLOWED_MINIMAX_MUSIC_MODELS = new Set(['music-2.6', 'music-2.6-free']);

const BANNED_RENDER_PROMPT_PHRASES = [
  'cinematic intro',
  'instrumental opening',
  'slow build',
  'atmospheric beginning',
  'ambient intro',
  'gradual fade in',
  'long intro',
  'build anticipation',
  'establish the groove',
];

export function normalizeForMatch(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function containsExactTitle(text = '', title = '') {
  const normalizedText = ` ${normalizeForMatch(text)} `;
  const normalizedTitle = normalizeForMatch(title);
  return Boolean(normalizedTitle && normalizedText.includes(` ${normalizedTitle} `));
}

export function countWords(text = '') {
  return String(text)
    .replace(/\[[^\]]+\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function extractSection(text = '', sectionName = 'CHORUS') {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\[${escaped}[^\\]]*\\]([\\s\\S]*?)(?=\\n\\s*\\[[A-Z][^\\]]*\\]|$)`, 'i');
  const match = String(text).match(pattern);
  return match ? match[1].trim() : '';
}

export function extractFirstSingableLines(text = '', maxChars = 500) {
  return String(text)
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^#{1,6}\s/.test(trimmed)) return false;
      if (/^\*\*[^*]+\*\*:/.test(trimmed)) return false;
      if (/^---+$/.test(trimmed)) return false;
      if (/^\[[^\]]+\]$/.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .slice(0, maxChars);
}

export function buildRenderSafetyPrompt(title) {
  return [
    `exact song title: "${title}"`,
    'vocals begin immediately within 0-3 seconds',
    `first vocal must start by ${FIRST_VOCAL_REQUIRED_BY_SECONDS} seconds`,
    'no instrumental intro',
    `maximum non-vocal opening ${MAX_INSTRUMENTAL_INTRO_SECONDS} seconds`,
    'start with a sung or spoken vocal line',
    `sing the exact title "${title}" clearly in the opening vocal line`,
    `repeat the exact title "${title}" clearly in the chorus`,
    'complete children’s song, target 1:30 to 3:00, not a micro-jingle',
  ];
}

export function addRenderSafetyToPrompt(basePrompt = '', title = '') {
  const cleanBase = String(basePrompt || '').trim();
  const safety = buildRenderSafetyPrompt(title).join(', ');

  // MiniMax prompt limit is 2000 chars. Safety constraints must never be
  // appended after a long style prompt and then truncated off. Put them first
  // and only trim the lower-priority descriptive style text.
  if (!cleanBase) return safety.substring(0, MAX_RENDER_PROMPT_CHARS);

  const separator = ', ';
  const remainingForBase = Math.max(0, MAX_RENDER_PROMPT_CHARS - safety.length - separator.length);
  const trimmedBase = cleanBase.substring(0, remainingForBase);
  return [safety, trimmedBase].filter(Boolean).join(separator).substring(0, MAX_RENDER_PROMPT_CHARS);
}

export function runPreRenderQAGate({
  songId,
  songDir,
  title,
  lyrics,
  stylePrompt,
  model,
  allowShortSongs = process.env.PANCAKE_ALLOW_SHORT_SONGS === 'true',
}) {
  const failures = [];
  const warnings = [];
  const checks = [];

  const pass = (check, detail) => checks.push({ check, passed: true, detail });
  const fail = (check, detail) => {
    failures.push(`${check}: ${detail}`);
    checks.push({ check, passed: false, detail });
  };
  const warn = (check, detail) => {
    warnings.push(`${check}: ${detail}`);
    checks.push({ check, passed: true, warning: detail });
  };

  const prompt = String(stylePrompt || '');
  const lyricText = String(lyrics || '');
  const chorus = extractSection(lyricText, 'CHORUS');
  const intro = extractSection(lyricText, 'INTRO');
  const firstSingable = extractFirstSingableLines(lyricText);
  const wordCount = countWords(lyricText);

  if (!ALLOWED_MINIMAX_MUSIC_MODELS.has(model)) {
    fail('MiniMax model', `Expected music-2.6 or music-2.6-free, got ${model || 'missing'}`);
  } else if (model.includes('free')) {
    warn('MiniMax model', 'Using music-2.6-free intentionally. Switch MINIMAX_USE_FREE_MODEL=false or unset it for paid production render.');
  } else {
    pass('MiniMax model', model);
  }

  if (!containsExactTitle(lyricText, title)) {
    fail('Title in lyrics', `Exact title "${title}" is missing from lyrics`);
  } else {
    pass('Title in lyrics', `Exact title "${title}" found`);
  }

  if (!containsExactTitle(firstSingable, title) && !containsExactTitle(intro, title)) {
    fail('Opening vocal title', `Exact title "${title}" must appear in the opening singable line / [INTRO] section`);
  } else {
    pass('Opening vocal title', 'Exact title appears early enough to force a fast vocal start');
  }

  if (!chorus) {
    fail('Chorus section', 'Missing [CHORUS] section');
  } else if (!containsExactTitle(chorus, title)) {
    fail('Title in chorus', `Exact title "${title}" is missing from [CHORUS]`);
  } else {
    pass('Title in chorus', 'Exact title appears in [CHORUS]');
  }

  if (!allowShortSongs && wordCount < MIN_FULL_SONG_WORDS) {
    fail('Lyric length', `${wordCount} words is too short for a 1:30+ render; minimum is ${MIN_FULL_SONG_WORDS}. Set PANCAKE_ALLOW_SHORT_SONGS=true only for intentional jingles.`);
  } else if (wordCount < 160) {
    warn('Lyric length', `${wordCount} words may produce a shorter song; acceptable if target is near 1:30.`);
  } else {
    pass('Lyric length', `${wordCount} words`);
  }

  const normalizedPrompt = normalizeForMatch(prompt);
  const bannedFound = BANNED_RENDER_PROMPT_PHRASES.filter(phrase => normalizedPrompt.includes(normalizeForMatch(phrase)));
  if (bannedFound.length > 0) {
    fail('Banned render prompt language', `Remove: ${bannedFound.join(', ')}`);
  } else {
    pass('Banned render prompt language', 'No long-intro / cinematic build language found');
  }

  const requiredPromptIdeas = [
    { check: 'Prompt bans instrumental intro', terms: ['no instrumental intro'] },
    { check: 'Prompt requires fast vocals', terms: ['vocals begin immediately', 'within 0 3 seconds'] },
    { check: 'Prompt caps non-vocal opening', terms: ['maximum non vocal opening', `${MAX_INSTRUMENTAL_INTRO_SECONDS} seconds`] },
    { check: 'Prompt includes exact title', terms: [normalizeForMatch(title)] },
  ];

  for (const requirement of requiredPromptIdeas) {
    const missingTerms = requirement.terms.filter(term => !normalizedPrompt.includes(normalizeForMatch(term)));
    if (missingTerms.length > 0) fail(requirement.check, `Missing prompt constraint: ${missingTerms.join(', ')}`);
    else pass(requirement.check, 'Present');
  }

  const report = {
    song_id: songId,
    checked_at: new Date().toISOString(),
    passed: failures.length === 0,
    title,
    model,
    word_count: wordCount,
    target_duration_seconds: '90-180',
    max_instrumental_intro_seconds: MAX_INSTRUMENTAL_INTRO_SECONDS,
    first_vocal_required_by_seconds: FIRST_VOCAL_REQUIRED_BY_SECONDS,
    failures,
    warnings,
    checks,
  };

  if (songDir) {
    fs.writeFileSync(join(songDir, 'pre-render-qa.json'), JSON.stringify(report, null, 2));

    if (!report.passed) {
      fs.writeFileSync(join(songDir, 'PRE_RENDER_QA_FAILED.md'), buildPreRenderFailureMarkdown(report));
    }
  }

  return report;
}

function buildPreRenderFailureMarkdown(report) {
  return `# Pre-Render QA Failed — ${report.title}\n\n` +
    `Rendering was blocked before MiniMax was called. Fix these issues, then rerun the song pipeline.\n\n` +
    `## Blocking issues\n\n` +
    report.failures.map(issue => `- ${issue}`).join('\n') +
    `\n\n## Warnings\n\n` +
    (report.warnings.length ? report.warnings.map(issue => `- ${issue}`).join('\n') : '- None') +
    `\n\n## Required standards\n\n` +
    `- Exact title must appear in the opening singable line / [INTRO].\n` +
    `- Exact title must appear in [CHORUS].\n` +
    `- Vocals must be prompted to start within 0–3 seconds.\n` +
    `- Non-vocal opening must be capped at ${MAX_INSTRUMENTAL_INTRO_SECONDS} seconds.\n` +
    `- Songs should target 1:30–3:00. Lyrics must be at least ${MIN_FULL_SONG_WORDS} words unless PANCAKE_ALLOW_SHORT_SONGS=true.\n`;
}

export function runPostRenderAudioQACheck({ songId, songDir, title, audioFilePath, minDurationSeconds = MIN_FULL_SONG_DURATION_SECONDS }) {
  const failures = [];
  const warnings = [];
  const checks = [];

  const pass = (check, detail) => checks.push({ check, passed: true, detail });
  const fail = (check, detail) => {
    failures.push(`${check}: ${detail}`);
    checks.push({ check, passed: false, detail });
  };
  const warn = (check, detail) => {
    warnings.push(`${check}: ${detail}`);
    checks.push({ check, passed: true, warning: detail });
  };

  if (!audioFilePath || !fs.existsSync(audioFilePath)) {
    fail('Audio file', 'Missing rendered audio file');
  } else {
    const stat = fs.statSync(audioFilePath);
    if (stat.size < 50 * 1024) fail('Audio file size', `${Math.round(stat.size / 1024)} KB is too small`);
    else pass('Audio file size', `${Math.round(stat.size / 1024)} KB`);

    const estimatedDuration = estimateMp3DurationSeconds(audioFilePath);
    if (estimatedDuration == null) {
      warn('Audio duration', 'Could not estimate MP3 duration without ffprobe; run manual duration check');
    } else if (estimatedDuration < minDurationSeconds) {
      fail('Audio duration', `Estimated ${Math.round(estimatedDuration)}s; minimum is ${minDurationSeconds}s`);
    } else {
      pass('Audio duration', `Estimated ${Math.round(estimatedDuration)}s`);
    }
  }

  const transcriptPath = songDir ? join(songDir, 'audio', 'transcript.txt') : null;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    if (!containsExactTitle(transcript, title)) {
      fail('Transcript title check', `Exact title "${title}" missing from transcript`);
    } else {
      pass('Transcript title check', 'Exact title found in transcript');
    }
  } else {
    warn('Transcript title check', 'No audio/transcript.txt found yet. Add a transcript to verify actual sung title.');
  }

  const vocalTimingPath = songDir ? join(songDir, 'audio', 'vocal-timing.json') : null;
  if (vocalTimingPath && fs.existsSync(vocalTimingPath)) {
    try {
      const timing = JSON.parse(fs.readFileSync(vocalTimingPath, 'utf8'));
      const firstVocalStartSeconds = Number(timing.first_vocal_start_seconds);
      if (!Number.isFinite(firstVocalStartSeconds)) {
        fail('First vocal timing', 'audio/vocal-timing.json missing numeric first_vocal_start_seconds');
      } else if (firstVocalStartSeconds > FIRST_VOCAL_REQUIRED_BY_SECONDS) {
        fail('First vocal timing', `First vocal starts at ${firstVocalStartSeconds}s; max is ${FIRST_VOCAL_REQUIRED_BY_SECONDS}s`);
      } else {
        pass('First vocal timing', `First vocal starts at ${firstVocalStartSeconds}s`);
      }
    } catch {
      fail('First vocal timing', 'audio/vocal-timing.json is invalid JSON');
    }
  } else {
    warn('First vocal timing', 'No audio/vocal-timing.json found yet. Add detector output to verify actual vocal start time.');
  }

  const report = {
    song_id: songId,
    checked_at: new Date().toISOString(),
    passed: failures.length === 0,
    title,
    audio_file: audioFilePath,
    min_duration_seconds: minDurationSeconds,
    first_vocal_required_by_seconds: FIRST_VOCAL_REQUIRED_BY_SECONDS,
    failures,
    warnings,
    checks,
  };

  if (songDir) {
    fs.writeFileSync(join(songDir, 'post-render-audio-qa.json'), JSON.stringify(report, null, 2));
  }

  return report;
}

function estimateMp3DurationSeconds(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const bitrate = findFirstMp3Bitrate(buffer);
    if (!bitrate) return null;

    let audioBytes = buffer.length;
    if (buffer.slice(0, 3).toString('ascii') === 'ID3' && buffer.length > 10) {
      const tagSize = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
      audioBytes = Math.max(0, buffer.length - tagSize - 10);
    }

    return (audioBytes * 8) / bitrate;
  } catch {
    return null;
  }
}

function findFirstMp3Bitrate(buffer) {
  const mpeg1Layer3Kbps = [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, null];

  for (let i = 0; i < Math.min(buffer.length - 4, 8192); i++) {
    if (buffer[i] !== 0xff || (buffer[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (buffer[i + 1] >> 3) & 0x03;
    const layerBits = (buffer[i + 1] >> 1) & 0x03;
    const bitrateIndex = (buffer[i + 2] >> 4) & 0x0f;

    const isMpeg1 = versionBits === 0x03;
    const isLayer3 = layerBits === 0x01;
    if (!isMpeg1 || !isLayer3) continue;

    const kbps = mpeg1Layer3Kbps[bitrateIndex];
    if (kbps) return kbps * 1000;
  }

  return null;
}
