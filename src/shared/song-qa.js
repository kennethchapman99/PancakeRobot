/**
 * Song QA helpers for profile-driven render safety.
 *
 * These checks are deterministic and intentionally strict. The goal is to block
 * weak render packs before MiniMax burns a generation, then flag obvious audio
 * problems after render.
 */

import fs from 'fs';
import { join } from 'path';
import { loadBrandProfile } from './brand-profile.js';

const BRAND_PROFILE = loadBrandProfile();

export const MIN_FULL_SONG_WORDS = Number(BRAND_PROFILE.music.min_words || 120);
export const MIN_FULL_SONG_DURATION_SECONDS = inferMinimumDurationSeconds(BRAND_PROFILE.music.target_length) || 90;
export const MAX_INSTRUMENTAL_INTRO_SECONDS = Number(BRAND_PROFILE.music.max_instrumental_intro_seconds || 5);
export const FIRST_VOCAL_REQUIRED_BY_SECONDS = Number(BRAND_PROFILE.music.first_vocal_by_seconds || 5);
export const MAX_RENDER_PROMPT_CHARS = 2000;

const ALLOWED_MINIMAX_MUSIC_MODELS = new Set(['music-2.6', 'music-2.6-free']);
const EMOJI_MATCHER = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
const EMOJI_STRIPPER = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
const SECTION_HEADER_PATTERN = /^\s*\[([^\]]+)\]\s*$/u;
const KNOWN_SECTION_START_PATTERN = /^\s*\[(?:INTRO|VERSE|CHORUS|BRIDGE|OUTRO|PRE-CHORUS|HOOK|INTERLUDE|BREAKDOWN|FINAL CHORUS|CALL\/RESPONSE|CALL RESPONSE|SILLY BREAKDOWN)[^\]]*\]/imu;
const STAGE_CUE_WORDS = /\b(?:music|vocal|vocals|sfx|sound|effect|instrumental|spoken|whisper|shout|pause|beat|tempo|slows|speeds|glitch|warping|clap|stomp|jump|wave|spin|shake|raise|lift|point|wiggle|bounce)\b/i;

const CANONICAL_SECTIONS = new Set([
  'INTRO',
  'HOOK',
  'VERSE 1',
  'VERSE 2',
  'VERSE 3',
  'PRE-CHORUS',
  'CHORUS',
  'BRIDGE',
  'BREAKDOWN',
  'SILLY BREAKDOWN',
  'CALL/RESPONSE 1',
  'CALL/RESPONSE 2',
  'FINAL CHORUS',
  'OUTRO',
]);

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

export function stripEmojis(value = '') {
  return String(value || '').replace(EMOJI_STRIPPER, '');
}

export function hasEmoji(value = '') {
  return EMOJI_MATCHER.test(String(value || ''));
}

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

export function canonicalizeSectionHeader(line = '') {
  const match = String(line).match(SECTION_HEADER_PATTERN);
  if (!match) return null;

  const cleanInner = stripEmojis(match[1])
    .replace(/[—–]/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

  const base = cleanInner
    .split(/\s+-\s+|:/)[0]
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

  if (/^VERSE\s*\d+$/.test(base)) return base.replace(/VERSE\s*/, 'VERSE ');
  if (/^CALL\/RESPONSE\s*\d+$/.test(base)) return base.replace(/CALL\/RESPONSE\s*/, 'CALL/RESPONSE ');
  if (/^CALL RESPONSE\s*\d+$/.test(base)) return base.replace(/CALL RESPONSE\s*/, 'CALL/RESPONSE ');
  if (CANONICAL_SECTIONS.has(base)) return base;

  return null;
}

function isPlainCanonicalSectionHeader(line = '') {
  const canonical = canonicalizeSectionHeader(line);
  if (!canonical) return false;
  const match = String(line).match(SECTION_HEADER_PATTERN);
  if (!match) return false;
  const rawInner = stripEmojis(match[1]).replace(/\s+/g, ' ').trim().toUpperCase();
  return rawInner === canonical;
}

function isStageDirectionLine(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  if (/^\*[^*\n]{3,}\*$/u.test(trimmed)) return true;
  if (/^_[^_\n]{3,}_$/u.test(trimmed)) return true;
  if (/^<[^>\n]+>$/u.test(trimmed)) return true;
  if (/^\([^\n)]{3,}\)$/u.test(trimmed) && STAGE_CUE_WORDS.test(trimmed)) return true;
  return false;
}

export function findNonSingableLyricMarkup(text = '') {
  const issues = [];
  const lines = String(text || '').split('\n');

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (hasEmoji(trimmed)) {
      issues.push(`line ${index + 1}: emoji found in lyrics`);
    }

    if (isStageDirectionLine(trimmed)) {
      issues.push(`line ${index + 1}: stage direction must be rewritten as singable words only: ${trimmed}`);
    }

    const sectionMatch = trimmed.match(SECTION_HEADER_PATTERN);
    if (sectionMatch) {
      const canonical = canonicalizeSectionHeader(trimmed);
      if (!canonical) {
        issues.push(`line ${index + 1}: bracketed lyric note is not allowed: ${trimmed}`);
      } else if (!isPlainCanonicalSectionHeader(trimmed)) {
        issues.push(`line ${index + 1}: section labels must be plain [${canonical}] with no descriptors, emoji, or performance notes`);
      }
    }
  });

  return [...new Set(issues)];
}

export function sanitizeLyricsForQA(lyrics = '') {
  let text = String(lyrics || '').replace(/\r\n/g, '\n');

  const firstSectionMatch = text.match(KNOWN_SECTION_START_PATTERN);
  if (firstSectionMatch) {
    text = text.slice(firstSectionMatch.index);
  }

  text = stripEmojis(text);

  const lines = text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (/^#{1,6}\s/.test(trimmed)) return '';
    if (/^\*\*[^*]+\*\*:/.test(trimmed)) return '';
    if (/^---+\s*$/.test(trimmed)) return '';
    if (isStageDirectionLine(trimmed)) return '';

    const canonical = canonicalizeSectionHeader(trimmed);
    if (canonical) return `[${canonical}]`;
    if (SECTION_HEADER_PATTERN.test(trimmed)) return '';

    return line
      .replace(/\[[^\]]+\]/g, '')
      .replace(/\((?:music|vocal|vocals|sfx|sound|effect|instrumental|spoken|whisper|shout|pause|beat|tempo|glitch|warping)[^)]*\)/gi, '')
      .trimEnd();
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function prepareLyricsForRender(lyrics = '') {
  return sanitizeLyricsForQA(lyrics)
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !canonicalizeSectionHeader(trimmed);
    })
    .join('\n')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractSection(text = '', sectionName = 'CHORUS') {
  const escaped = escapeRegExp(sectionName);
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
      if (SECTION_HEADER_PATTERN.test(trimmed)) return false;
      if (isStageDirectionLine(trimmed)) return false;
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
    'lyrics contain no visible section labels, stage directions, or emoji',
    `complete ${BRAND_PROFILE.brand_description}, target ${BRAND_PROFILE.music.target_length}, not a micro-jingle unless explicitly requested`,
    ...arrayify(BRAND_PROFILE.songwriting?.render_safety),
  ];
}

export function addRenderSafetyToPrompt(basePrompt = '', title = '') {
  const cleanBase = stripEmojis(String(basePrompt || '').trim());
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
  allowShortSongs = process.env.PIPELINE_ALLOW_SHORT_SONGS === 'true',
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

  const prompt = stripEmojis(String(stylePrompt || ''));
  const rawLyricText = String(lyrics || '');
  const lyricText = sanitizeLyricsForQA(rawLyricText);
  const renderLyrics = prepareLyricsForRender(rawLyricText);
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

  const markupIssues = findNonSingableLyricMarkup(rawLyricText);
  if (markupIssues.length > 0) {
    fail('Non-singable lyric markup', markupIssues.slice(0, 6).join('; '));
  } else {
    pass('Non-singable lyric markup', 'No emoji, bracketed stage directions, or italic performance notes in lyrics');
  }

  if (!renderLyrics) {
    fail('Renderable lyrics', 'No singable lyric text remains after removing section labels and stage directions');
  } else if (findNonSingableLyricMarkup(renderLyrics).length > 0) {
    fail('Renderable lyrics', 'Sanitized render lyrics still contain non-singable markup');
  } else {
    pass('Renderable lyrics', 'Render payload strips section labels and keeps only singable lines');
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
    fail('Lyric length', `${wordCount} words is too short for the active profile target (${BRAND_PROFILE.music.target_length}); minimum is ${MIN_FULL_SONG_WORDS}. Set PIPELINE_ALLOW_SHORT_SONGS=true only for intentional short songs.`);
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
    { check: 'Prompt bans lyric metadata leakage', terms: ['lyrics contain no visible section labels', 'stage directions', 'emoji'] },
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
    render_word_count: countWords(renderLyrics),
    target_duration_seconds: BRAND_PROFILE.music.target_length,
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
    `- Lyrics must not contain emoji, bracketed performance notes, or italic stage directions.\n` +
    `- Rendered lyrics sent to MiniMax must contain only singable words, not section labels.\n` +
    `- Vocals must be prompted to start within 0–3 seconds.\n` +
    `- Non-vocal opening must be capped at ${MAX_INSTRUMENTAL_INTRO_SECONDS} seconds.\n` +
    `- Songs should target ${report.target_duration_seconds}. Lyrics must be at least ${MIN_FULL_SONG_WORDS} words unless PIPELINE_ALLOW_SHORT_SONGS=true.\n`;
}

function arrayify(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [String(value)] : [];
}

function inferMinimumDurationSeconds(targetLength = '') {
  const match = String(targetLength).match(/(\d+):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
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
