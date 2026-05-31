/**
 * Song QA helpers for profile-driven render safety.
 *
 * These checks protect renderability and provider payload quality without forcing
 * one brand's creative conventions onto every profile. Title placement, verse /
 * chorus requirements, hook repetition, structure strictness, and explicitness
 * are read from the active brand profile when provided.
 */

import fs from 'fs';
import { join } from 'path';
import { loadBrandProfile } from './brand-profile.js';

const BRAND_PROFILE = loadBrandProfile();

export const MIN_FULL_SONG_WORDS = parseRangeLower(BRAND_PROFILE.music.normal_word_range, 80);
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

const CANONICAL_SECTIONS = new Set(['INTRO', 'HOOK', 'VERSE 1', 'VERSE 2', 'VERSE 3', 'PRE-CHORUS', 'CHORUS', 'BRIDGE', 'BREAKDOWN', 'SILLY BREAKDOWN', 'CALL/RESPONSE 1', 'CALL/RESPONSE 2', 'FINAL CHORUS', 'OUTRO']);
const BANNED_RENDER_PROMPT_PHRASES = ['cinematic intro', 'instrumental opening', 'slow build', 'atmospheric beginning', 'ambient intro', 'gradual fade in', 'long intro', 'build anticipation', 'establish the groove'];

const WORDS_TO_FLAG = [
  [102, 117, 99, 107],
  [115, 104, 105, 116],
  [97, 115, 115, 104, 111, 108, 101],
  [98, 105, 116, 99, 104],
  [100, 105, 99, 107],
  [99, 117, 110, 116],
  [98, 97, 115, 116, 97, 114, 100],
  [100, 97, 109, 110],
].map(chars => String.fromCharCode(...chars));

function parseRangeLower(range, fallback = 80) {
  if (!range) return fallback;
  const lo = Number(String(range).split('-')[0]);
  return Number.isFinite(lo) && lo > 0 ? lo : fallback;
}

export function getLyricConventions(profile = BRAND_PROFILE) {
  const configured = profile.music?.lyric_conventions || profile.songwriting?.lyric_conventions || profile.lyrics?.lyric_conventions || {};
  return {
    title_usage: configured.title_usage || 'free',
    title_usage_required: configured.title_usage_required === true,
    title_usage_location: configured.title_usage_location || 'anywhere',
    hook_repetition: configured.hook_repetition || 'free',
    structure_strictness: configured.structure_strictness || 'free',
    require_chorus_or_hook: configured.require_chorus_or_hook === true,
    require_verse: configured.require_verse === true,
    allow_unconventional_structure: configured.allow_unconventional_structure !== false,
    explicitness: configured.explicitness || profile.audience?.explicitness || 'clean',
    vocal_timing: configured.vocal_timing || 'free',
    allow_instrumental_intro: configured.allow_instrumental_intro !== false,
  };
}

export function stripEmojis(value = '') { return String(value || '').replace(EMOJI_STRIPPER, ''); }
export function hasEmoji(value = '') { return EMOJI_MATCHER.test(String(value || '')); }
export function normalizeForMatch(value = '') { return String(value).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
export function containsExactTitle(text = '', title = '') { const normalizedText = ` ${normalizeForMatch(text)} `; const normalizedTitle = normalizeForMatch(title); return Boolean(normalizedTitle && normalizedText.includes(` ${normalizedTitle} `)); }
export function countWords(text = '') { return String(text).replace(/\[[^\]]+\]/g, ' ').split(/\s+/).filter(Boolean).length; }
export function detectProfanity(text = '') { const normalized = ` ${normalizeForMatch(text)} `; return WORDS_TO_FLAG.filter(word => new RegExp(`\\b${word}\\w*\\b`, 'i').test(normalized)); }

export function canonicalizeSectionHeader(line = '') {
  const match = String(line).match(SECTION_HEADER_PATTERN);
  if (!match) return null;
  const cleanInner = stripEmojis(match[1]).replace(/[—–]/g, ' - ').replace(/\s+/g, ' ').trim();
  const base = cleanInner.split(/\s+-\s+|:/)[0].trim().toUpperCase().replace(/\s+/g, ' ');
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
    if (hasEmoji(trimmed)) issues.push(`line ${index + 1}: emoji found in lyrics`);
    if (isStageDirectionLine(trimmed)) issues.push(`line ${index + 1}: stage direction must be rewritten as singable words only: ${trimmed}`);
    const sectionMatch = trimmed.match(SECTION_HEADER_PATTERN);
    if (sectionMatch) {
      const canonical = canonicalizeSectionHeader(trimmed);
      if (!canonical) issues.push(`line ${index + 1}: bracketed lyric note is not allowed: ${trimmed}`);
      else if (!isPlainCanonicalSectionHeader(trimmed)) issues.push(`line ${index + 1}: section labels must be plain [${canonical}] with no descriptors, emoji, or performance notes`);
    }
  });
  return [...new Set(issues)];
}

export function sanitizeLyricsForQA(lyrics = '') {
  let text = String(lyrics || '').replace(/\r\n/g, '\n');
  const firstSectionMatch = text.match(KNOWN_SECTION_START_PATTERN);
  if (firstSectionMatch) text = text.slice(firstSectionMatch.index);
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
    return line.replace(/\[[^\]]+\]/g, '').replace(/\((?:music|vocal|vocals|sfx|sound|effect|instrumental|spoken|whisper|shout|pause|beat|tempo|glitch|warping)[^)]*\)/gi, '').trimEnd();
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function prepareLyricsForRender(lyrics = '') { return sanitizeLyricsForQA(lyrics).split('\n').filter(line => { const trimmed = line.trim(); if (!trimmed) return true; return !canonicalizeSectionHeader(trimmed); }).join('\n').replace(/\[[^\]]+\]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
function escapeRegExp(value = '') { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function extractSection(text = '', sectionName = 'CHORUS') { const escaped = escapeRegExp(sectionName); const pattern = new RegExp(`\\[${escaped}[^\\]]*\\]([\\s\\S]*?)(?=\\n\\s*\\[[A-Z][^\\]]*\\]|$)`, 'i'); const match = String(text).match(pattern); return match ? match[1].trim() : ''; }
export function extractFirstSingableLines(text = '', maxChars = 500) { return String(text).split('\n').filter(line => { const trimmed = line.trim(); if (!trimmed) return false; if (/^#{1,6}\s/.test(trimmed)) return false; if (/^\*\*[^*]+\*\*:/.test(trimmed)) return false; if (/^---+$/.test(trimmed)) return false; if (SECTION_HEADER_PATTERN.test(trimmed)) return false; if (isStageDirectionLine(trimmed)) return false; return true; }).join('\n').slice(0, maxChars); }

export function buildRenderSafetyPrompt(title, conventions = getLyricConventions()) {
  const safety = [
    `song title for metadata: "${title}"`,
    'lyrics contain no visible section labels, stage directions, or emoji in the provider payload',
    `complete ${BRAND_PROFILE.brand_description}, target ${BRAND_PROFILE.music.target_length}, not a micro-jingle unless explicitly requested`,
  ];

  if (conventions.vocal_timing === 'fast' || conventions.allow_instrumental_intro === false) {
    safety.push(`first vocal should start by ${FIRST_VOCAL_REQUIRED_BY_SECONDS} seconds`);
    safety.push(`maximum non-vocal opening target ${MAX_INSTRUMENTAL_INTRO_SECONDS} seconds`);
  } else {
    safety.push('vocal entrance, intro length, and instrumental opening are profile-driven and may vary by genre');
  }

  if (conventions.title_usage_required) {
    safety.push(`title usage required: ${conventions.title_usage} / ${conventions.title_usage_location}`);
    if (conventions.title_usage === 'opening_line' || conventions.title_usage_location === 'opening_line') safety.push(`sing the exact title "${title}" clearly in the opening vocal line`);
    if (conventions.title_usage === 'chorus_hook' || conventions.title_usage_location === 'chorus') safety.push(`repeat the exact title "${title}" clearly in the chorus or hook`);
    if (conventions.title_usage === 'include_somewhere' || conventions.title_usage_location === 'anywhere') safety.push(`include the exact title "${title}" somewhere in the singable lyrics`);
  } else {
    safety.push('title usage is artistically optional; do not force the exact title into the opening or chorus unless it naturally fits');
  }
  return [...safety, ...arrayify(BRAND_PROFILE.songwriting?.render_safety)];
}

export function addRenderSafetyToPrompt(basePrompt = '', title = '') {
  const cleanBase = stripEmojis(String(basePrompt || '').trim());
  const safety = buildRenderSafetyPrompt(title).join(', ');
  if (!cleanBase) return safety.substring(0, MAX_RENDER_PROMPT_CHARS);
  const separator = ', ';
  const remainingForBase = Math.max(0, MAX_RENDER_PROMPT_CHARS - safety.length - separator.length);
  const trimmedBase = cleanBase.substring(0, remainingForBase);
  return [safety, trimmedBase].filter(Boolean).join(separator).substring(0, MAX_RENDER_PROMPT_CHARS);
}

function checkTitlePlacement({ conventions, title, lyricText, firstSingable, intro, chorus, pass, fail, warn }) {
  if (!conventions.title_usage_required) {
    if (!containsExactTitle(lyricText, title)) warn('Title usage', `Exact title "${title}" is not in lyrics; allowed by active profile`);
    else pass('Title usage', `Exact title "${title}" found; optional under active profile`);
    return;
  }
  const usage = conventions.title_usage;
  const location = conventions.title_usage_location;
  const requiresOpening = usage === 'opening_line' || location === 'opening_line';
  const requiresChorus = usage === 'chorus_hook' || location === 'chorus';
  const requiresAnywhere = usage === 'include_somewhere' || location === 'anywhere';
  if (requiresOpening) { if (!containsExactTitle(firstSingable, title) && !containsExactTitle(intro, title)) fail('Opening vocal title', `Exact title "${title}" must appear in the opening singable line / [INTRO] section`); else pass('Opening vocal title', 'Exact title appears where active profile requires it'); }
  if (requiresChorus) { if (!containsExactTitle(chorus, title)) fail('Title in chorus', `Exact title "${title}" is missing from [CHORUS]/[HOOK]`); else pass('Title in chorus', 'Exact title appears where active profile requires it'); }
  if (requiresAnywhere && !requiresOpening && !requiresChorus) { if (!containsExactTitle(lyricText, title)) fail('Title in lyrics', `Exact title "${title}" is missing from lyrics`); else pass('Title in lyrics', `Exact title "${title}" found`); }
}

export function runPreRenderQAGate({ songId, songDir, title, lyrics, stylePrompt, model, allowShortSongs = process.env.PIPELINE_ALLOW_SHORT_SONGS === 'true' }) {
  const failures = [], warnings = [], checks = [];
  const conventions = getLyricConventions();
  const pass = (check, detail) => checks.push({ check, passed: true, detail });
  const fail = (check, detail) => { failures.push(`${check}: ${detail}`); checks.push({ check, passed: false, detail }); };
  const warn = (check, detail) => { warnings.push(`${check}: ${detail}`); checks.push({ check, passed: true, warning: detail }); };
  const prompt = stripEmojis(String(stylePrompt || ''));
  const rawLyricText = String(lyrics || '');
  const lyricText = sanitizeLyricsForQA(rawLyricText);
  const renderLyrics = prepareLyricsForRender(rawLyricText);
  const chorus = extractSection(lyricText, 'CHORUS') || extractSection(lyricText, 'HOOK');
  const intro = extractSection(lyricText, 'INTRO');
  const firstSingable = extractFirstSingableLines(lyricText);
  const wordCount = countWords(lyricText);
  const hasVerse = /\[(VERSE|VERSE\s+\d+)\]/i.test(lyricText);
  const hasHookOrChorus = /\[(CHORUS|HOOK|FINAL CHORUS|FINAL HOOK)\]/i.test(lyricText);
  if (!ALLOWED_MINIMAX_MUSIC_MODELS.has(model)) fail('MiniMax model', `Expected music-2.6 or music-2.6-free, got ${model || 'missing'}`); else if (model.includes('free')) warn('MiniMax model', 'Using music-2.6-free intentionally. Switch MINIMAX_USE_FREE_MODEL=false or unset it for paid production render.'); else pass('MiniMax model', model);
  const markupIssues = findNonSingableLyricMarkup(rawLyricText);
  if (markupIssues.length > 0) fail('Non-singable lyric markup', markupIssues.slice(0, 6).join('; ')); else pass('Non-singable lyric markup', 'No emoji, bracketed stage directions, or italic performance notes in lyrics');
  if (!renderLyrics) fail('Renderable lyrics', 'No singable lyric text remains after removing section labels and stage directions'); else if (findNonSingableLyricMarkup(renderLyrics).length > 0) fail('Renderable lyrics', 'Sanitized render lyrics still contain non-singable markup'); else pass('Renderable lyrics', 'Render payload strips section labels and keeps only singable lines');
  checkTitlePlacement({ conventions, title, lyricText, firstSingable, intro, chorus, pass, fail, warn });
  if (conventions.require_chorus_or_hook && !hasHookOrChorus) fail('Chorus/hook section', 'Active brand profile requires [CHORUS] or [HOOK]'); else if (!hasHookOrChorus) warn('Chorus/hook section', 'No [CHORUS] or [HOOK]; allowed by active profile'); else pass('Chorus/hook section', 'Present or profile-compatible');
  if (conventions.require_verse && !hasVerse) fail('Verse section', 'Active brand profile requires [VERSE]'); else if (!hasVerse) warn('Verse section', 'No [VERSE]; allowed by active profile'); else pass('Verse section', 'Present or profile-compatible');
  if (!allowShortSongs && wordCount < MIN_FULL_SONG_WORDS) fail('Lyric length', `${wordCount} words is too short for the active profile target (${BRAND_PROFILE.music.target_length}); minimum is ${MIN_FULL_SONG_WORDS}. Set PIPELINE_ALLOW_SHORT_SONGS=true only for intentional short songs.`); else if (wordCount < 160) warn('Lyric length', `${wordCount} words may produce a shorter song; acceptable when profile permits it.`); else pass('Lyric length', `${wordCount} words`);
  const explicitHits = detectProfanity(lyricText);
  if (conventions.explicitness === 'clean' && explicitHits.length > 0) fail('Explicitness', 'Profanity found but active brand profile explicitness is clean'); else if (conventions.explicitness === 'mild' && explicitHits.some(hit => hit.length > 4)) fail('Explicitness', 'Heavy profanity found but active brand profile explicitness is mild'); else if (explicitHits.length > 0) pass('Explicitness', `Profanity allowed by active profile (${conventions.explicitness}); release metadata should mark explicit=true`); else pass('Explicitness', 'No profanity detected');
  const normalizedPrompt = normalizeForMatch(prompt);
  const bannedFound = BANNED_RENDER_PROMPT_PHRASES.filter(phrase => normalizedPrompt.includes(normalizeForMatch(phrase)));
  if (bannedFound.length > 0) warn('Long-intro render language', `Found: ${bannedFound.join(', ')}; allowed unless profile/prompt intends fast vocals`); else pass('Long-intro render language', 'No obvious long-intro language found');
  const requiredPromptIdeas = [{ check: 'Prompt mentions vocal timing', terms: ['vocal'] }, { check: 'Prompt caps non-vocal opening', terms: [`${MAX_INSTRUMENTAL_INTRO_SECONDS} seconds`] }, { check: 'Prompt bans lyric metadata leakage', terms: ['section labels', 'stage directions', 'emoji'] }];
  if (conventions.title_usage_required) requiredPromptIdeas.push({ check: 'Prompt includes title convention', terms: [normalizeForMatch(title)] });
  for (const requirement of requiredPromptIdeas) { const missingTerms = requirement.terms.filter(term => !normalizedPrompt.includes(normalizeForMatch(term))); if (missingTerms.length > 0) warn(requirement.check, `Missing prompt guidance: ${missingTerms.join(', ')}`); else pass(requirement.check, 'Present'); }
  const report = { song_id: songId, checked_at: new Date().toISOString(), passed: failures.length === 0, title, model, word_count: wordCount, render_word_count: countWords(renderLyrics), target_duration_seconds: BRAND_PROFILE.music.target_length, max_instrumental_intro_seconds: MAX_INSTRUMENTAL_INTRO_SECONDS, first_vocal_required_by_seconds: FIRST_VOCAL_REQUIRED_BY_SECONDS, lyric_conventions: conventions, explicit: explicitHits.length > 0, failures, warnings, checks };
  if (songDir) { fs.writeFileSync(join(songDir, 'pre-render-qa.json'), JSON.stringify(report, null, 2)); if (!report.passed) fs.writeFileSync(join(songDir, 'PRE_RENDER_QA_FAILED.md'), buildPreRenderFailureMarkdown(report)); }
  return report;
}

function buildPreRenderFailureMarkdown(report) { return `# Pre-Render QA Failed — ${report.title}\n\nRendering was blocked before MiniMax was called. Fix these issues, then rerun the song pipeline.\n\n## Blocking issues\n\n${report.failures.map(issue => `- ${issue}`).join('\n')}\n\n## Warnings\n\n${report.warnings.length ? report.warnings.map(issue => `- ${issue}`).join('\n') : '- None'}\n\n## Active profile conventions\n\n\`\`\`json\n${JSON.stringify(report.lyric_conventions || {}, null, 2)}\n\`\`\`\n\n## Required standards\n\n- Lyrics must not contain emoji, bracketed performance notes, or italic stage directions.\n- Rendered lyrics sent to MiniMax must contain only singable words, not section labels.\n- Title placement and verse/chorus requirements apply only when the active brand profile requires them.\n- Songs should target ${report.target_duration_seconds}. Lyrics must be at least ${MIN_FULL_SONG_WORDS} words unless PIPELINE_ALLOW_SHORT_SONGS=true.\n`; }
function arrayify(value) { if (Array.isArray(value)) return value.filter(Boolean); return value ? [String(value)] : []; }
function inferMinimumDurationSeconds(targetLength = '') { const match = String(targetLength).match(/(\d+):(\d{2})/); if (!match) return null; return Number(match[1]) * 60 + Number(match[2]); }

export function runPerformanceBriefQACheck({ prompt = '', performanceBrief = null, profile = BRAND_PROFILE }) {
  const sw = profile?.songwriting || {};
  const failures = [];
  const warnings = [];
  const checks = [];
  const pass = (check, detail) => checks.push({ check, passed: true, detail });
  const fail = (check, detail) => { failures.push(`${check}: ${detail}`); checks.push({ check, passed: false, detail }); };
  const warn = (check, detail) => { warnings.push(`${check}: ${detail}`); checks.push({ check, passed: true, warning: detail }); };

  const normalizedPrompt = normalizeForMatch(prompt);

  // If profile has enriched performance fields, a brief must be present.
  if (sw.vocal_performance_engine || sw.performance_conceit_bank?.length) {
    if (!performanceBrief) {
      fail('Performance brief present', 'Profile has enriched performance fields but no performance brief was generated');
    } else {
      pass('Performance brief present', 'Brief was generated for enriched profile');

      // The audio prompt must reference something from the brief.
      const vocalConceitWords = (performanceBrief.vocal_conceit || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const briefInPrompt = vocalConceitWords.some(w => normalizedPrompt.includes(w));
      if (!briefInPrompt) {
        warn('Performance brief consumed by prompt', 'Audio prompt does not appear to reference the vocal conceit from the performance brief');
      } else {
        pass('Performance brief consumed by prompt', 'Vocal conceit terms found in audio prompt');
      }
    }
  } else {
    pass('Performance brief', 'Legacy profile without enriched fields — brief not required');
  }

  // Check for generic-only prompt language.
  const genericOnlyIndicators = ['energetic', 'feel-good', 'upbeat', 'catchy', 'powerful', 'anthemic'];
  const genericHits = genericOnlyIndicators.filter(term => normalizedPrompt.includes(term));
  const specificIndicators = ['vocal conceit', 'adlib', 'double-time', 'breath', 'attack', 'pocket', 'hook behavior', 'sonic oddity'];
  const specificHits = specificIndicators.filter(term => normalizedPrompt.includes(term));
  if (genericHits.length > 3 && specificHits.length === 0) {
    warn('Anti-generic prompt check', `Prompt uses ${genericHits.length} generic genre adjectives (${genericHits.join(', ')}) with no performance-specific language`);
  } else {
    pass('Anti-generic prompt check', specificHits.length > 0 ? `Performance-specific language present: ${specificHits.join(', ')}` : 'Prompt passed generic check');
  }

  // Check that real artist names are not leaking into the prompt.
  const ARTIST_LEAK_PATTERNS = [/\bdoechii\b/i, /\bradiohead\b/i, /\bkendrick\b/i, /\bkendrick lamar\b/i, /\beminem\b/i, /\bdrake\b/i, /\bkanye\b/i];
  for (const pattern of ARTIST_LEAK_PATTERNS) {
    if (pattern.test(normalizedPrompt)) {
      fail('Artist name leak', `Real artist name detected in prompt: ${pattern.source}`);
    }
  }
  if (!failures.some(f => f.startsWith('Artist name leak'))) {
    pass('Artist name leak check', 'No known real artist names found in prompt');
  }

  // Check vocal performance engine fields are consumed when present.
  if (sw.vocal_performance_engine) {
    const vpe = sw.vocal_performance_engine;
    const vpeTerms = [
      ...(vpe.vocal_textures || []),
      ...(vpe.timing_behaviors || []),
      ...(vpe.adlib_behaviors || []),
    ].flatMap(t => t.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    const vpeInPrompt = vpeTerms.some(w => normalizedPrompt.includes(w));
    if (!vpeInPrompt) {
      warn('Vocal performance engine consumed', 'Profile has vocal_performance_engine but no VPE terms appear in the audio prompt');
    } else {
      pass('Vocal performance engine consumed', 'VPE terms found in audio prompt');
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    checks,
  };
}

export function runPostRenderAudioQACheck({ songId, songDir, title, audioFilePath, minDurationSeconds = MIN_FULL_SONG_DURATION_SECONDS }) {
  const failures = [], warnings = [], checks = [];
  const pass = (check, detail) => checks.push({ check, passed: true, detail });
  const fail = (check, detail) => { failures.push(`${check}: ${detail}`); checks.push({ check, passed: false, detail }); };
  const warn = (check, detail) => { warnings.push(`${check}: ${detail}`); checks.push({ check, passed: true, warning: detail }); };
  if (!audioFilePath || !fs.existsSync(audioFilePath)) fail('Audio file', 'Missing rendered audio file'); else { const stat = fs.statSync(audioFilePath); if (stat.size < 50 * 1024) fail('Audio file size', `${Math.round(stat.size / 1024)} KB is too small`); else pass('Audio file size', `${Math.round(stat.size / 1024)} KB`); warn('Audio duration', 'Could not estimate MP3 duration without ffprobe; run manual duration check'); }
  const transcriptPath = songDir ? join(songDir, 'audio', 'transcript.txt') : null;
  if (transcriptPath && fs.existsSync(transcriptPath)) { const transcript = fs.readFileSync(transcriptPath, 'utf8'); if (!containsExactTitle(transcript, title)) warn('Transcript title check', `Exact title "${title}" missing from transcript; allowed unless profile requires title usage`); else pass('Transcript title check', 'Exact title found in transcript'); } else warn('Transcript title check', 'No audio/transcript.txt found yet. Add a transcript to verify actual sung title.');
  const vocalTimingPath = songDir ? join(songDir, 'audio', 'vocal-timing.json') : null;
  if (vocalTimingPath && fs.existsSync(vocalTimingPath)) { try { const timing = JSON.parse(fs.readFileSync(vocalTimingPath, 'utf8')); const firstVocalStartSeconds = Number(timing.first_vocal_start_seconds); if (!Number.isFinite(firstVocalStartSeconds)) fail('First vocal timing', 'audio/vocal-timing.json missing numeric first_vocal_start_seconds'); else if (firstVocalStartSeconds > FIRST_VOCAL_REQUIRED_BY_SECONDS) warn('First vocal timing', `First vocal starts at ${firstVocalStartSeconds}s; profile target is ${FIRST_VOCAL_REQUIRED_BY_SECONDS}s`); else pass('First vocal timing', `First vocal starts at ${firstVocalStartSeconds}s`); } catch { fail('First vocal timing', 'audio/vocal-timing.json is invalid JSON'); } } else warn('First vocal timing', 'No audio/vocal-timing.json found yet. Add detector output to verify actual vocal start time.');
  const report = { song_id: songId, checked_at: new Date().toISOString(), passed: failures.length === 0, title, audio_file: audioFilePath, min_duration_seconds: minDurationSeconds, first_vocal_required_by_seconds: FIRST_VOCAL_REQUIRED_BY_SECONDS, failures, warnings, checks };
  if (songDir) fs.writeFileSync(join(songDir, 'post-render-audio-qa.json'), JSON.stringify(report, null, 2));
  return report;
}
