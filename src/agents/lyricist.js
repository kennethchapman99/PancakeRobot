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
const LYRICIST_MAX_TOKENS = readPositiveInt(process.env.LYRICIST_MAX_TOKENS || process.env.ANTHROPIC_DIRECT_MAX_TOKENS, 20000);
const LYRICIST_MAX_ATTEMPTS = readPositiveInt(process.env.LYRICIST_MAX_ATTEMPTS, 3);
const LYRICIST_RETRY_DELAY_MS = readPositiveInt(process.env.LYRICIST_RETRY_DELAY_MS, 5000);

export const LYRICIST_DEF = {
  name: `${BRAND_NAME} Lyricist`,
  noTools: true,
  maxTokens: LYRICIST_MAX_TOKENS,
  maxRetries: 1,
  retryDelayMs: LYRICIST_RETRY_DELAY_MS,
  system: `You are the head songwriter for ${BRAND_NAME}. Follow the active brand profile exactly. Do not import characters, references, sound effects, structures, genre rules, or motifs from unrelated brands. Output valid production-ready JSON only. Never wrap JSON in markdown fences.`,
};

export async function writeLyrics({ songId, topic, researchReport, revisionNotes, existingLyrics }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  let result = { costUsd: 0 };
  let songData = null;
  let qaRevisionNotes = revisionNotes;
  let lastFailure = null;

  for (let attempt = 1; attempt <= LYRICIST_MAX_ATTEMPTS; attempt++) {
    const lyricsTask = buildLyricsTask({ topic, researchReport, revisionNotes: qaRevisionNotes, existingLyrics });
    result = await runAgent('lyricist', LYRICIST_DEF, lyricsTask, {
      maxTokens: LYRICIST_MAX_TOKENS,
      maxRetries: 1,
      retryDelayMs: LYRICIST_RETRY_DELAY_MS,
    });

    let parsedSongData;
    try {
      parsedSongData = parseAgentJson(result.text);
    } catch (err) {
      lastFailure = `attempt ${attempt}: invalid or incomplete JSON (${err.message})`;
      persistFailedLyricistOutput({ songDir, attempt, rawText: result.text, reason: lastFailure });
      qaRevisionNotes = buildRetryRevisionNotes({ revisionNotes, lastFailure, rawText: result.text });
      continue;
    }

    const validationFailures = validateSongDataShape(parsedSongData);
    if (validationFailures.length > 0) {
      lastFailure = `attempt ${attempt}: malformed lyricist JSON (${validationFailures.join('; ')})`;
      persistFailedLyricistOutput({ songDir, attempt, rawText: result.text, reason: lastFailure });
      qaRevisionNotes = buildRetryRevisionNotes({ revisionNotes, lastFailure, rawText: result.text });
      continue;
    }

    const candidate = sanitizeSongData(parsedSongData, topic);
    const contamination = findForbiddenElementContamination(candidate);
    if (contamination.length === 0) {
      songData = candidate;
      break;
    }

    lastFailure = `attempt ${attempt}: forbidden active-profile element(s): ${contamination.map(item => item.element).join(', ')}`;
    qaRevisionNotes = [
      revisionNotes || '',
      'CRITICAL PROFILE QA FAILURE:',
      `The previous draft included forbidden active-profile element(s) in the title, lyrics, hook, or chorus: ${contamination.map(item => item.element).join(', ')}.`,
      'Rewrite from scratch and remove every forbidden element from singable song content. Use only allowed and required elements from the active brand profile.',
      'Keep audio_prompt metadata positive-only and do not mention forbidden elements there, even as exclusions.',
      'Keep the JSON complete and valid. Do not shorten long hip-hop verses; instead keep metadata concise.'
    ].filter(Boolean).join('\n');
  }

  if (!songData) {
    throw new Error(`Lyricist failed after ${LYRICIST_MAX_ATTEMPTS} attempt(s). Last failure: ${lastFailure || 'unknown'}. Check lyricist-attempt-*-failed.txt in the song output folder.`);
  }

  const contamination = findForbiddenElementContamination(songData);
  if (contamination.length > 0) {
    throw new Error(`Lyricist profile QA failed for "${songData.title || topic}". Forbidden element(s): ${contamination.map(item => item.element).join(', ')}`);
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
    costUsd: result.costUsd || 0,
  };
}

export function buildLyricsTask({ topic, researchReport, revisionNotes, existingLyrics }) {
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
- Full-length hip-hop support is required. Do not shorten rap verses to protect JSON size; prioritize complete lyrics and keep metadata concise.
- Start with a plain [INTRO] label followed immediately by the first singable line.
- First singable line must contain the exact title.
- Use only plain canonical section labels such as [INTRO], [VERSE 1], [CHORUS], [VERSE 2], [BRIDGE], [FINAL CHORUS], and [OUTRO].
- Do not include performer names, descriptors, em dashes, stage notes, production notes, or mood notes inside section labels.
- Chorus: 4-8 lines, memorable, and built around the exact title.
- Main hook/chorus repeats at least two times.
- The lyrics field may be sung by the renderer after deterministic sanitization; include only plain section labels and singable words. No markdown, no cues, no commentary.
- Keep audio_prompt fields positive-only. Do not mention forbidden elements in metadata, even as negatives or exclusions.

STRUCTURE OPTIONS:
${formatStructurePreferences()}

Output valid JSON only. No markdown fences. No trailing commas. Do not stop until the final closing } has been written:
${formatOutputSchema()}`;
}

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildRetryRevisionNotes({ revisionNotes, lastFailure, rawText = '' }) {
  const tail = String(rawText || '').slice(-700);
  return [
    revisionNotes || '',
    'CRITICAL LYRICIST RETRY:',
    lastFailure,
    'Return one complete valid JSON object only. No markdown fences. No trailing commas. The JSON must end with the final closing brace.',
    'Long hip-hop lyrics are allowed and expected; do not shorten verses. Keep metadata fields concise if space is needed.',
    'Keep audio_prompt metadata positive-only and do not mention forbidden elements as exclusions.',
    tail ? `Previous output tail for debugging:\n${tail}` : ''
  ].filter(Boolean).join('\n');
}

function persistFailedLyricistOutput({ songDir, attempt, rawText, reason }) {
  try {
    fs.writeFileSync(
      join(songDir, `lyricist-attempt-${attempt}-failed.txt`),
      `Reason: ${reason}\n\n${rawText || ''}`
    );
  } catch {
    // Do not let debug persistence hide the real lyricist failure.
  }
}

function validateSongDataShape(songData = {}) {
  const failures = [];

  if (!songData || typeof songData !== 'object' || Array.isArray(songData)) {
    return ['response is not a JSON object'];
  }

  if (!songData.title || typeof songData.title !== 'string') {
    failures.push('missing string field: title');
  }

  if (!songData.lyrics || typeof songData.lyrics !== 'string') {
    failures.push('missing string field: lyrics');
  } else {
    const wordCount = countApproxWords(songData.lyrics);
    const minWords = Number(MUSIC.min_words || 0);
    if (minWords > 0 && wordCount < minWords) {
      failures.push(`lyrics too short: ${wordCount} words; minimum is ${minWords}`);
    }
  }

  if (songData.audio_prompt && (typeof songData.audio_prompt !== 'object' || Array.isArray(songData.audio_prompt))) {
    failures.push('audio_prompt must be an object when present');
  }

  return failures;
}

function countApproxWords(text = '') {
  return String(text)
    .replace(/\[[^\]]+\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
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
    structure_preferences: SONGWRITING.structure_preferences || [],
    render_safety: SONGWRITING.render_safety || [],
    qa_rules: SONGWRITING.qa_rules || [],
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
    '  "lyrics": "full lyrics text with plain canonical section labels only; no performer descriptors or stage directions"',
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
    if (typeof value === 'string') {
      cleaned[key] = stripForbiddenNegatedClauses(stripEmojis(value)).trim();
    }
  }
  return cleaned;
}

export function findForbiddenElementContamination(songData, forbiddenElements = SONGWRITING.forbidden_elements || []) {
  const searchable = collectSingableSongText(songData);
  const normalized = normalizeForForbiddenMatch(searchable);

  return forbiddenElements
    .flatMap(element => buildForbiddenPatterns(element).map(pattern => ({ element, pattern })))
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ element, pattern }) => ({ element, pattern: pattern.source }));
}

function collectSingableSongText(songData = {}) {
  const parts = [
    songData.title,
    songData.lyrics,
    songData.key_hook,
    ...(Array.isArray(songData.chorus_lines) ? songData.chorus_lines : []),
    songData.physical_action_cue,
    songData.funny_long_word,
  ];

  return parts.filter(Boolean).join('\n');
}

function stripForbiddenNegatedClauses(value = '', forbiddenElements = SONGWRITING.forbidden_elements || []) {
  const text = String(value || '');
  if (!text.trim() || !Array.isArray(forbiddenElements) || forbiddenElements.length === 0) return text;

  const clauses = text.split(/([.;]\s*)/);
  const kept = [];

  for (let index = 0; index < clauses.length; index += 2) {
    const clause = clauses[index] || '';
    const punctuation = clauses[index + 1] || '';
    if (!clause.trim()) {
      kept.push(clause, punctuation);
      continue;
    }

    const normalizedClause = normalizeForForbiddenMatch(clause);
    const containsNegation = /\b(no|not|without|avoid|exclude|free of|never|do not|dont)\b/i.test(normalizedClause);
    const mentionsForbidden = forbiddenElements.some(element =>
      buildForbiddenPatterns(element).some(pattern => pattern.test(normalizedClause))
    );

    if (containsNegation && mentionsForbidden) continue;
    kept.push(clause, punctuation);
  }

  return kept.join('').replace(/\s{2,}/g, ' ').trim();
}

function normalizeForForbiddenMatch(value = '') {
  return ` ${String(value)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

function buildForbiddenPatterns(element = '') {
  const normalized = normalizeForForbiddenMatch(element).trim();
  if (!normalized) return [];

  const terms = new Set([normalized]);
  const singular = normalized
    .split(' ')
    .map(word => word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.replace(/s$/, ''))
    .join(' ');
  terms.add(singular);

  if (normalized.includes('sounds')) terms.add(normalized.replace(/\bsounds\b/g, 'sound'));
  if (normalized.includes('language')) terms.add(normalized.replace(/\blanguage\b/g, ''));
  if (normalized.includes('metaphors')) terms.add(normalized.replace(/\bmetaphors\b/g, ''));

  return [...terms]
    .map(term => term.trim())
    .filter(Boolean)
    .filter(term => term.length > 2)
    .map(term => new RegExp(`\\b${escapeRegExp(term).replace(/\s+/g, '\\s+')}\\b`, 'i'));
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
