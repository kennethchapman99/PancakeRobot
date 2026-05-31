/**
 * Lyricist Agent — Writes complete lyrics and audio generation prompts.
 *
 * The active brand profile is the source of truth. Creative conventions such as
 * title usage, hook repetition, song structure, and language level come from the
 * active profile rather than global pop-song rules.
 */

import { runAgent, parseAgentJson } from '../shared/managed-agent.js';
import { loadBrandProfile, hasEnrichedPerformanceFields } from '../shared/brand-profile.js';
import { sanitizeLyricsForQA, stripEmojis, getLyricConventions } from '../shared/song-qa.js';
import { generatePerformanceBrief } from './performance-brief.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const CHARACTER_NAME = BRAND_PROFILE.character.name;
const MUSIC = BRAND_PROFILE.music || {};
const SONGWRITING = BRAND_PROFILE.songwriting || {};
const OUTPUT_SCHEMA = SONGWRITING.output_schema || {};
const LYRIC_CONVENTIONS = getLyricConventions(BRAND_PROFILE);
const MUSIC_TARGET_LENGTH = MUSIC.target_length;
const MUSIC_MIN_WORDS = parseRangeLower(MUSIC.normal_word_range);
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
  system: `You are the head songwriter for ${BRAND_NAME}. Follow the active brand profile exactly, but treat profile examples, lore, numbers, reference artists, and catchphrases as guidance rather than reusable lyric inventory unless the user explicitly requests them. Do not import characters, references, sound effects, structures, genre rules, or motifs from unrelated brands. Output valid production-ready JSON only. Never wrap JSON in markdown fences.`,
};

export async function writeLyrics({
  songId,
  topic,
  researchReport,
  revisionNotes,
  existingLyrics,
  albumContext = null,
  priorTracks = [],
  briefGenerator = generatePerformanceBrief,
}) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  // Generate hidden performance brief when the profile has enriched fields.
  let performanceBrief = null;
  let briefCostUsd = 0;
  if (hasEnrichedPerformanceFields(BRAND_PROFILE)) {
    try {
      const briefResult = await briefGenerator({
        brandProfile: BRAND_PROFILE,
        albumContext,
        priorTracks,
        topic,
      });
      performanceBrief = briefResult.brief;
      briefCostUsd = briefResult.costUsd || 0;
      fs.writeFileSync(join(songDir, 'performance-brief.json'), JSON.stringify(performanceBrief, null, 2));
    } catch (err) {
      console.warn(`[LYRICIST] Performance brief generation failed (non-fatal): ${err.message}`);
    }
  }

  let result = { costUsd: 0 };
  let songData = null;
  let qaRevisionNotes = revisionNotes;
  let lastFailure = null;

  for (let attempt = 1; attempt <= LYRICIST_MAX_ATTEMPTS; attempt++) {
    const lyricsTask = buildLyricsTask({ topic, researchReport, revisionNotes: qaRevisionNotes, existingLyrics, performanceBrief });
    result = await runAgent('lyricist', LYRICIST_DEF, lyricsTask, { maxTokens: LYRICIST_MAX_TOKENS, maxRetries: 1, retryDelayMs: LYRICIST_RETRY_DELAY_MS });
    let parsedSongData;
    try { parsedSongData = parseAgentJson(result.text); }
    catch (err) {
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
    if (contamination.length > 0) {
      lastFailure = `attempt ${attempt}: forbidden active-profile element(s): ${contamination.map(item => item.element).join(', ')}`;
      qaRevisionNotes = [revisionNotes || '', 'CRITICAL PROFILE QA FAILURE:', `The previous draft included forbidden active-profile element(s): ${contamination.map(item => item.element).join(', ')}.`, 'Rewrite from scratch and remove every forbidden element from singable song content.', 'Keep audio_prompt metadata positive-only and do not mention forbidden elements there, even as exclusions.'].filter(Boolean).join('\n');
      continue;
    }
    const seedOveruse = findProfileSeedOveruse(candidate, BRAND_PROFILE, topic);
    if (seedOveruse.length === 0) { songData = candidate; break; }
    lastFailure = `attempt ${attempt}: profile example/lore overuse: ${formatSeedOveruseList(seedOveruse)}`;
    qaRevisionNotes = buildProfileSeedRetryNotes({ revisionNotes, seedOveruse });
  }

  if (!songData) throw new Error(`Lyricist failed after ${LYRICIST_MAX_ATTEMPTS} attempt(s). Last failure: ${lastFailure || 'unknown'}. Check lyricist-attempt-*-failed.txt in the song output folder.`);
  const contamination = findForbiddenElementContamination(songData);
  if (contamination.length > 0) throw new Error(`Lyricist profile QA failed for "${songData.title || topic}". Forbidden element(s): ${contamination.map(item => item.element).join(', ')}`);
  const seedOveruse = findProfileSeedOveruse(songData, BRAND_PROFILE, topic);
  if (seedOveruse.length > 0) throw new Error(`Lyricist profile seed QA failed for "${songData.title || topic}". Profile seed term(s): ${formatSeedOveruseList(seedOveruse)}`);

  const lyricsContent = formatLyricsMarkdown(songData);
  const lyricsPath = join(songDir, 'lyrics.md');
  fs.writeFileSync(lyricsPath, lyricsContent);
  const audioPromptContent = formatAudioPrompt(songData, performanceBrief);
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
    costUsd: (result.costUsd || 0) + briefCostUsd,
    performanceBrief,
  };
}

export function buildLyricsTask({ topic, researchReport, revisionNotes, existingLyrics, performanceBrief = null }) {
  const existingLyricsContext = existingLyrics ? `\n\nEXISTING LYRICS TO REVISE:\n\`\`\`\n${existingLyrics}\n\`\`\`\nRevise based on the feedback below. Keep what works and fix what is requested.` : '';
  const revisionContext = revisionNotes ? `\n\n${existingLyrics ? 'EDITOR FEEDBACK' : 'REVISION NOTES'}:\n${revisionNotes}\nAddress all specific concerns.` : '';
  const briefContext = performanceBrief ? formatPerformanceBriefSection(performanceBrief) : '';
  const vpeContext = formatVocalPerformanceEngineSection();
  const antiGenericContext = formatAntiGenericSection();
  return `${existingLyrics ? 'Revise' : 'Write'} a complete, production-ready song for the active ${BRAND_NAME} brand on this topic: "${topic}"
${existingLyricsContext}${revisionContext}${briefContext}${vpeContext}${antiGenericContext}

PROFILE SEED SAFETY:
- The active brand profile is creative guidance, not a lyric ingredient list.
- Do not reuse exact strings from title examples, catchphrases, reference artists, visual references, social tags, distribution tags, or background lore unless the user explicitly requests them.
- Title examples are style references only; do not reuse them as song titles, hooks, chorus lines, or lyric phrases unless the user provides that exact title.
- Catchphrases are optional spice, not mandatory lyrics. Use at most one only when it naturally fits, and usually none.
- Reference artists are internal vibe references only. Never place artist names in lyrics, song title, audio_prompt voice style, or metadata unless explicitly requested.
- Specific numbers, symbols, or lore terms in the profile are background texture only. Never force them into every song.

ACTIVE BRAND PROFILE — SOURCE OF TRUTH:
${JSON.stringify(BRAND_PROFILE, null, 2)}

ACTIVE LYRIC CONVENTIONS:
${JSON.stringify(LYRIC_CONVENTIONS, null, 2)}

SONGWRITING DIRECTION:
${formatSongwritingGuidance()}

RESEARCH / CONTEXT INSIGHTS:
${JSON.stringify(summarizeResearch(researchReport), null, 2)}

MUSIC DIRECTION:
${MUSIC_DEFAULT_PROMPT}

TITLE RULES:
${formatTitleRules()}

LYRIC RULES:
- Use only the active brand profile as brand truth.
- Make the song specific to ${BRAND_NAME}, ${CHARACTER_NAME}, and the topic details.
- Do not import characters, references, sound effects, structures, genre rules, or motifs from unrelated brands.
- Follow every forbidden element in SONGWRITING DIRECTION.
- Include required elements naturally when they fit the topic.
- Keep the tone aligned to this guardrail: ${BRAND_PROFILE.audience.guardrail}.
- Abstract profile memories, images, names, relationships, and emotional details into fresh song-specific language; do not copy exact lore, numbers, examples, or catchphrases unless requested.
- Follow the required closing if the active profile defines one: ${BRAND_PROFILE.lyrics.required_closing || 'profile-compatible ending'}.
- Language level: ${formatLanguageLevelGuidance()}.

REQUIREMENTS:
- Production render target: ${MUSIC.target_length}.
- WORD COUNT: Target ${MUSIC.normal_word_range} singable words, excluding section labels like [CHORUS]. Minimum is ${MUSIC_MIN_WORDS} words unless the user explicitly asks for a short/jingle.
- Full-length hip-hop support is required. Do not shorten rap verses to protect JSON size; prioritize complete lyrics and keep metadata concise.
- Song structure is brand/profile-driven. Do not default to verse/chorus/pop structure unless the active profile or user asks for it.
- Section labels are optional. Use them only when they make the song clearer for the renderer or match the active profile.
- If using section labels, keep them plain and canonical, with no performer names, descriptors, em dashes, stage notes, production notes, or mood notes.
- The lyrics field may be sung by the renderer after deterministic sanitization; include singable words only apart from optional plain section labels. No markdown, no cues, no commentary.
- Keep audio_prompt fields positive-only. Do not mention forbidden elements in metadata, even as negatives or exclusions.

STRUCTURE OPTIONS:
${formatStructurePreferences()}

Output valid JSON only. No markdown fences. No trailing commas. Do not stop until the final closing } has been written:
${formatOutputSchema()}`;
}

function formatPerformanceBriefSection(brief) {
  if (!brief) return '';
  return `

HIDDEN PERFORMANCE BRIEF — FOLLOW THIS PRECISELY (this defines the song's identity):
- Vocal conceit: ${brief.vocal_conceit}
- Flow movement: ${brief.flow_movement}
- Hook behavior: ${brief.hook_behavior}
- Adlib personality: ${brief.adlib_personality}
- Sonic oddity: ${brief.sonic_oddity}
- Emotional contradiction: ${brief.emotional_contradiction}
- Must avoid vs previous tracks: ${brief.avoid_vs_previous_tracks}

These are not suggestions. The vocal conceit, hook behavior, and sonic oddity must be recognizable within 10 seconds of the song. Do not default to a standard genre arrangement.`;
}

function formatVocalPerformanceEngineSection() {
  const vpe = SONGWRITING.vocal_performance_engine;
  if (!vpe) return '';
  const lines = ['', 'VOCAL PERFORMANCE ENGINE (apply this identity to delivery descriptions and audio prompt):'];
  if (vpe.priority) lines.push(`Priority: ${vpe.priority}`);
  if (vpe.vocal_textures?.length) lines.push(`Vocal textures: ${vpe.vocal_textures.join(', ')}`);
  if (vpe.timing_behaviors?.length) lines.push(`Timing behaviors: ${vpe.timing_behaviors.join(', ')}`);
  if (vpe.adlib_behaviors?.length) lines.push(`Adlib behaviors: ${vpe.adlib_behaviors.join(', ')}`);
  if (vpe.avoid?.length) lines.push(`Vocal delivery to AVOID: ${vpe.avoid.join(', ')}`);
  return lines.join('\n');
}

function formatAntiGenericSection() {
  const antiGeneric = SONGWRITING.anti_generic_rules;
  if (!antiGeneric?.length) return '';
  return `\n\nANTI-GENERIC RULES (these override genre defaults):\n${antiGeneric.map(r => `- ${r}`).join('\n')}`;
}

function formatTitleRules() {
  const lines = ['- If the topic includes an explicit title, preserve that title exactly in the title field.', '- If no explicit title is provided, choose one creative title and treat it as locked for metadata consistency.', '- Do not create confusing title variants in metadata.', '- Title examples in the active profile are style references only and must not be reused unless the user explicitly requested that exact title.'];
  if (LYRIC_CONVENTIONS.title_usage_required) {
    lines.push(`- Active profile requires title usage: ${LYRIC_CONVENTIONS.title_usage} / ${LYRIC_CONVENTIONS.title_usage_location}.`);
    if (LYRIC_CONVENTIONS.title_usage === 'opening_line' || LYRIC_CONVENTIONS.title_usage_location === 'opening_line') lines.push('- The first singable line must contain the exact title because the active profile requires it.');
    if (LYRIC_CONVENTIONS.title_usage === 'chorus_hook' || LYRIC_CONVENTIONS.title_usage_location === 'chorus') lines.push('- The chorus or hook must contain the exact title because the active profile requires it.');
    if (LYRIC_CONVENTIONS.title_usage === 'include_somewhere' || LYRIC_CONVENTIONS.title_usage_location === 'anywhere') lines.push('- Include the exact title somewhere in the singable lyrics because the active profile requires it.');
  } else {
    lines.push('- Title usage in the singable lyrics is artistically optional.');
    lines.push('- Do not force the exact title into the opening line or chorus unless it naturally fits the song.');
  }
  return lines.join('\n');
}
function formatLanguageLevelGuidance() { if (LYRIC_CONVENTIONS.explicitness === 'explicit_allowed') return 'adult language is allowed when brand-appropriate; keep all content within platform-safe boundaries'; if (LYRIC_CONVENTIONS.explicitness === 'mild') return 'mild language only; keep content within the active audience guardrail'; return 'clean language only; keep content appropriate for the active audience'; }
function readPositiveInt(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function parseRangeLower(range, fallback = 80) { if (!range) return fallback; const lo = Number(String(range).split('-')[0]); return Number.isFinite(lo) && lo > 0 ? lo : fallback; }
function buildRetryRevisionNotes({ revisionNotes, lastFailure, rawText = '' }) { const tail = String(rawText || '').slice(-700); return [revisionNotes || '', 'CRITICAL LYRICIST RETRY:', lastFailure, 'Return one complete valid JSON object only. No markdown fences. No trailing commas. The JSON must end with the final closing brace.', 'Long hip-hop lyrics are allowed and expected; do not shorten verses. Keep metadata fields concise if space is needed.', 'Keep audio_prompt metadata positive-only and do not mention forbidden elements as exclusions.', tail ? `Previous output tail for debugging:\n${tail}` : ''].filter(Boolean).join('\n'); }
function buildProfileSeedRetryNotes({ revisionNotes, seedOveruse }) { return [revisionNotes || '', 'PROFILE SEED OVERUSE QA:', `The previous draft reused profile example/lore/reference term(s) too literally: ${formatSeedOveruseList(seedOveruse)}.`, 'Rewrite from scratch using the active brand direction abstractly rather than copying exact profile examples.', 'Do not reuse title examples, catchphrases, reference artist names, visual-reference phrases, social/distribution tags, specific numbers, or background lore unless the user explicitly requested them.', 'Invent fresh song-specific title, hook, chorus language, and audio_prompt wording while staying inside the brand profile.'].filter(Boolean).join('\n'); }
function persistFailedLyricistOutput({ songDir, attempt, rawText, reason }) { try { fs.writeFileSync(join(songDir, `lyricist-attempt-${attempt}-failed.txt`), `Reason: ${reason}\n\n${rawText || ''}`); } catch {} }
function validateSongDataShape(songData = {}) { const failures = []; if (!songData || typeof songData !== 'object' || Array.isArray(songData)) return ['response is not a JSON object']; if (!songData.title || typeof songData.title !== 'string') failures.push('missing string field: title'); if (!songData.lyrics || typeof songData.lyrics !== 'string') failures.push('missing string field: lyrics'); else { const wordCount = countApproxWords(songData.lyrics); if (MUSIC_MIN_WORDS > 0 && wordCount < MUSIC_MIN_WORDS) failures.push(`lyrics too short: ${wordCount} words; minimum is ${MUSIC_MIN_WORDS} (lower bound of normal_word_range ${MUSIC.normal_word_range})`); } if (songData.audio_prompt && (typeof songData.audio_prompt !== 'object' || Array.isArray(songData.audio_prompt))) failures.push('audio_prompt must be an object when present'); return failures; }
function countApproxWords(text = '') { return String(text).replace(/\[[^\]]+\]/g, ' ').split(/\s+/).filter(Boolean).length; }
function formatSongwritingGuidance() { if (!Object.keys(SONGWRITING).length) return 'No dedicated songwriting section provided. Infer songwriting direction from music, lyrics, audience, and character fields.'; return JSON.stringify({ song_type: SONGWRITING.song_type, primary_emotional_goal: SONGWRITING.primary_emotional_goal, voice_perspective: SONGWRITING.voice_perspective, allowed_elements: SONGWRITING.allowed_elements || [], forbidden_elements: SONGWRITING.forbidden_elements || [], required_elements: SONGWRITING.required_elements || [], structure_preferences: SONGWRITING.structure_preferences || [], lyric_conventions: LYRIC_CONVENTIONS, render_safety: SONGWRITING.render_safety || [], qa_rules: SONGWRITING.qa_rules || [], seed_safety: SONGWRITING.seed_safety || {}, output_schema: OUTPUT_SCHEMA }, null, 2); }
function formatStructurePreferences() {
  const structures = SONGWRITING.structure_preferences;
  const defaults = LYRIC_CONVENTIONS.allow_unconventional_structure
    ? [
      'Use any profile-compatible structure that serves the song.',
      'Do not default to intro/verse/chorus/bridge/final chorus unless it fits the active brand, genre, or user request.',
      'Chorus, hook, refrain, verse-only, rap sections, spoken-word sections, call/response, instrumental openings, or unusual forms are allowed when they fit.',
      'If the profile requires verse or chorus/hook, satisfy that requirement naturally.'
    ]
    : ['[INTRO] -> [VERSE 1] -> [CHORUS] -> [VERSE 2] -> [CHORUS] -> [BRIDGE] -> [FINAL CHORUS] -> [OUTRO]'];

  return (Array.isArray(structures) && structures.length ? structures : defaults)
    .map((structure, index) => `${index + 1}. ${structure}`)
    .join('\\n');
}
function formatOutputSchema() { const fields = ['  "title": "The Song Title"', '  "lyrics": "full lyrics text with plain canonical section labels only; no performer descriptors or stage directions"', '  "notable_lines": ["line1", "line2", "line3", "line4"]', '  "word_count": 320', '  "structure_used": "which structure was used and why it fits the active profile"', '  "key_hook": "the memorable hook, refrain, thesis, chant, or core line"']; if (OUTPUT_SCHEMA.include_physical_action_cue) fields.push('  "physical_action_cue": "description of the main physical action"'); if (OUTPUT_SCHEMA.include_funny_long_word) fields.push('  "funny_long_word": "the comedic long word used if any"'); if (OUTPUT_SCHEMA.include_audio_prompt !== false) fields.push(`  "audio_prompt": {\n    "style": "${MUSIC.default_style}",\n    "tempo_bpm": ${MUSIC.default_bpm},\n    "genre": "${MUSIC.default_style}",\n    "instrumentation": "match the active profile music direction",\n    "energy": "match the emotional arc of the song",\n    "mood": "match the song",\n    "voice_style": "match the active brand profile, audience, and topic without naming reference artists unless explicitly requested",\n    "structure_note": "describe the actual structure used",\n    "target_length": "${MUSIC.target_length}",\n    "first_vocal_by_seconds": ${MUSIC.first_vocal_by_seconds},\n    "max_instrumental_intro_seconds": ${MUSIC.max_instrumental_intro_seconds},\n    "title_usage": "${LYRIC_CONVENTIONS.title_usage_required ? `${LYRIC_CONVENTIONS.title_usage} / ${LYRIC_CONVENTIONS.title_usage_location}` : 'artistically optional'}",\n    "special_notes": "Follow the active brand profile only; do not copy profile examples or lore terms unless requested."\n  }`); return `{\n${fields.join(',\n')}\n}`; }
function summarizeResearch(researchReport) { if (!researchReport) return { note: 'No research data available. Use the active brand profile and songwriting expertise.' }; return { lyric_patterns: researchReport.lyric_patterns?.slice(0, 3), ideal_bpm_range: researchReport.ideal_bpm_range, ideal_length_seconds: researchReport.ideal_length_seconds, viral_signals: researchReport.viral_signals?.slice(0, 5) }; }
function sanitizeSongData(songData, topic) { const sanitized = { ...songData, title: stripEmojis(songData.title || topic.substring(0, 50)).trim(), lyrics: sanitizeLyricsForQA(songData.lyrics || ''), key_hook: songData.key_hook ? stripEmojis(songData.key_hook).trim() : songData.key_hook, chorus_lines: Array.isArray(songData.chorus_lines) ? songData.chorus_lines.map(line => stripEmojis(line).trim()) : songData.chorus_lines,
    notable_lines: Array.isArray(songData.notable_lines) ? songData.notable_lines.map(line => stripEmojis(line).trim()) : songData.notable_lines, audio_prompt: sanitizeAudioPrompt(songData.audio_prompt || {}) }; if (!OUTPUT_SCHEMA.include_physical_action_cue) delete sanitized.physical_action_cue; if (!OUTPUT_SCHEMA.include_funny_long_word) delete sanitized.funny_long_word; return sanitized; }
function sanitizeAudioPrompt(audioPrompt) { const cleaned = { ...audioPrompt }; for (const [key, value] of Object.entries(cleaned)) if (typeof value === 'string') cleaned[key] = stripForbiddenNegatedClauses(stripEmojis(value)).trim(); return cleaned; }
export function findForbiddenElementContamination(songData, forbiddenElements = SONGWRITING.forbidden_elements || []) { const searchable = collectSingableSongText(songData); const normalized = normalizeForForbiddenMatch(searchable); return forbiddenElements.flatMap(element => buildForbiddenPatterns(element).map(pattern => ({ element, pattern }))).filter(({ pattern }) => pattern.test(normalized)).map(({ element, pattern }) => ({ element, pattern: pattern.source })); }
export function collectProfileSeedTerms(profile = {}) { const terms = [], seen = new Set(); const seedSafety = profile.songwriting?.seed_safety || {}; const protectedTerms = collectProtectedProfileTerms(profile); const addTerm = (rawTerm, type, source, { allowShort = false } = {}) => { const term = cleanSeedTerm(rawTerm); const normalized = normalizeForForbiddenMatch(term).trim(); if (!term || !normalized) return; if (!allowShort && normalized.length < 4) return; if (isGenericSeedTerm(normalized)) return; if (protectedTerms.has(normalized)) return; const key = `${type}:${normalized}`; if (seen.has(key)) return; seen.add(key); terms.push({ term, normalized, type, source }); }; const addStringArray = (value, type, source) => { for (const item of normalizeStringArray(value)) addTerm(item, type, source); }; if (seedSafety.allow_title_example_reuse !== true) addStringArray(profile.lyrics?.title_examples, 'title_example', 'lyrics.title_examples'); if (seedSafety.allow_catchphrase_reuse !== true) addStringArray(profile.character?.catchphrases, 'catchphrase', 'character.catchphrases'); if (seedSafety.allow_reference_artist_names_in_prompt !== true) addStringArray(profile.songwriting?.reference_artists_for_internal_vibe_only, 'reference_artist', 'songwriting.reference_artists_for_internal_vibe_only'); addStringArray(profile.songwriting?.background_lore_terms, 'background_lore', 'songwriting.background_lore_terms'); addStringArray(profile.songwriting?.lore_terms, 'background_lore', 'songwriting.lore_terms'); addStringArray(profile.songwriting?.optional_lore_terms, 'background_lore', 'songwriting.optional_lore_terms'); return terms; }
export function findProfileSeedOveruse(songData = {}, profile = BRAND_PROFILE, topic = '') { const seedTerms = collectProfileSeedTerms(profile); if (seedTerms.length === 0) return []; const searchable = collectSingableSongText(songData); const normalizedSearchable = normalizeForForbiddenMatch(searchable); const seedSafety = profile.songwriting?.seed_safety || {}; return seedTerms.map(seed => ({ ...seed, count: countNormalizedSeedMatches(normalizedSearchable, seed.normalized) })).filter(seed => seed.count > 0).filter(seed => !topicExplicitlyAllowsSeedTerm(topic, seed)).filter(seed => shouldFlagSeedMatch(seed, seedSafety)); }
function collectSingableSongText(songData = {}) { const audioPromptStrings = songData.audio_prompt && typeof songData.audio_prompt === 'object' && !Array.isArray(songData.audio_prompt) ? Object.values(songData.audio_prompt).filter(value => typeof value === 'string') : []; return [songData.title, songData.lyrics, songData.key_hook, ...(Array.isArray(songData.chorus_lines) ? songData.chorus_lines : []), songData.physical_action_cue, songData.funny_long_word, ...audioPromptStrings].filter(Boolean).join('\n'); }
function collectProtectedProfileTerms(profile = {}) { return new Set([profile.brand_name, profile.character?.name, profile.distribution?.default_artist].map(term => normalizeForForbiddenMatch(term).trim()).filter(Boolean)); }
function normalizeStringArray(value) { return Array.isArray(value) ? value.map(item => cleanSeedTerm(item)).filter(Boolean) : []; }
function cleanSeedTerm(value = '') { return String(value || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim(); }
function shouldFlagSeedMatch(seed, seedSafety = {}) { if (seed.type === 'catchphrase') { const mode = seedSafety.allow_catchphrase_reuse ?? 'rare'; if (mode === true) return false; if (mode === 'rare' && seed.count <= 1) return false; } return true; }
function topicExplicitlyAllowsSeedTerm(topic = '', seed) { const normalizedTopic = normalizeForForbiddenMatch(topic).trim(); if (!normalizedTopic) return false; return buildSeedPatterns(seed.normalized).some(pattern => pattern.test(` ${normalizedTopic} `)); }
function countNormalizedSeedMatches(normalizedSearchable, normalizedSeed) { return buildSeedPatterns(normalizedSeed).reduce((count, pattern) => count + countPatternMatches(normalizedSearchable, pattern), 0); }
function buildSeedPatterns(normalizedSeed = '') { const seed = String(normalizedSeed || '').trim(); if (!seed) return []; return [new RegExp(`\\b${escapeRegExp(seed).replace(/\s+/g, '\\s+')}\\b`, 'gi')]; }
function countPatternMatches(value = '', pattern) { const matches = String(value || '').match(pattern); return matches ? matches.length : 0; }
function isGenericSeedTerm(normalized = '') { return new Set(['music', 'song', 'songs', 'pop', 'rock', 'rap', 'hip hop', 'hiphop', 'chorus', 'verse', 'bridge', 'intro', 'outro', 'artist', 'album', 'single', 'spotify', 'youtube', 'apple music', 'figment factory', 'studio']).has(normalized); }
function formatSeedOveruseList(seedOveruse = []) { return seedOveruse.map(item => `${item.term} (${item.type}, ${item.count}x)`).join(', '); }
function stripForbiddenNegatedClauses(value = '', forbiddenElements = SONGWRITING.forbidden_elements || []) { const text = String(value || ''); if (!text.trim() || !Array.isArray(forbiddenElements) || forbiddenElements.length === 0) return text; const clauses = text.split(/([.;]\s*)/), kept = []; for (let index = 0; index < clauses.length; index += 2) { const clause = clauses[index] || ''; const punctuation = clauses[index + 1] || ''; if (!clause.trim()) { kept.push(clause, punctuation); continue; } const normalizedClause = normalizeForForbiddenMatch(clause); const containsNegation = /\b(no|not|without|avoid|exclude|free of|never|do not|dont)\b/i.test(normalizedClause); const mentionsForbidden = forbiddenElements.some(element => buildForbiddenPatterns(element).some(pattern => pattern.test(normalizedClause))); if (containsNegation && mentionsForbidden) continue; kept.push(clause, punctuation); } return kept.join('').replace(/\s{2,}/g, ' ').trim(); }
function normalizeForForbiddenMatch(value = '') { return ` ${String(value).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `; }
function buildForbiddenPatterns(element = '') { const normalized = normalizeForForbiddenMatch(element).trim(); if (!normalized) return []; const terms = new Set([normalized]); const singular = normalized.split(' ').map(word => word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.replace(/s$/, '')).join(' '); terms.add(singular); if (normalized.includes('sounds')) terms.add(normalized.replace(/\bsounds\b/g, 'sound')); if (normalized.includes('language')) terms.add(normalized.replace(/\blanguage\b/g, '')); if (normalized.includes('metaphors')) terms.add(normalized.replace(/\bmetaphors\b/g, '')); return [...terms].map(term => term.trim()).filter(Boolean).filter(term => term.length > 2).map(term => new RegExp(`\\b${escapeRegExp(term).replace(/\s+/g, '\\s+')}\\b`, 'i')); }
function escapeRegExp(value = '') { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function formatLyricsMarkdown(songData) {
  const title = songData.title || 'Untitled Song';
  const lyrics = sanitizeLyricsForQA(songData.lyrics || '');
  let md = `# ${title}

`;
  const coreLine = songData.key_hook || songData.notable_lines?.[0];
  if (coreLine) md += `**Core Line:** ${coreLine}
`;
  if (OUTPUT_SCHEMA.include_physical_action_cue) md += `**Physical Action:** ${songData.physical_action_cue || 'TBD'}
`;
  md += `**Word Count:** ~${songData.word_count || '?'}

---

${lyrics}
`;
  return md;
}
function formatAudioPrompt(songData, performanceBrief = null) {
  const ap = songData.audio_prompt || {};
  const lyrics = sanitizeLyricsForQA(songData.lyrics || '');
  const titleGuidance = LYRIC_CONVENTIONS.title_usage_required
    ? `Profile requires title usage: ${LYRIC_CONVENTIONS.title_usage} / ${LYRIC_CONVENTIONS.title_usage_location}`
    : 'Title usage is optional; do not force the exact title into opening or chorus unless natural';
  let prompt = `# Audio Generation Prompt\n\n`;
  prompt += `## Song: ${songData.title || 'Untitled'}\n\n`;
  prompt += `## Music Specs\n\n`;
  prompt += `**Style:** ${ap.tempo_bpm || MUSIC_DEFAULT_BPM} BPM, ${ap.genre || MUSIC_DEFAULT_STYLE}\n`;
  prompt += `**Instrumentation:** ${ap.instrumentation || MUSIC_DEFAULT_PROMPT}\n`;
  prompt += `**Energy:** ${ap.energy || 'profile-aligned'}\n`;
  prompt += `**Mood:** ${ap.mood || MUSIC_DEFAULT_STYLE}\n`;
  prompt += `**Voice Style:** ${ap.voice_style || 'profile-aligned'}\n`;
  prompt += `**Structure:** ${ap.structure_note || 'profile-compatible structure chosen by the songwriter'}\n`;
  prompt += `**Target Length:** ${ap.target_length || MUSIC_TARGET_LENGTH}\n`;
  if (LYRIC_CONVENTIONS.vocal_timing === 'fast' || LYRIC_CONVENTIONS.allow_instrumental_intro === false) {
    prompt += `**First Vocal By:** ${ap.first_vocal_by_seconds ?? FIRST_VOCAL_BY_SECONDS} seconds\n`;
    prompt += `**Max Instrumental Intro:** ${ap.max_instrumental_intro_seconds ?? MAX_INSTRUMENTAL_INTRO_SECONDS} seconds\n`;
  } else {
    prompt += `**Vocal Timing:** profile-driven; instrumental openings are allowed when genre-appropriate\n`;
  }
  prompt += `**Title Usage:** ${ap.title_usage || titleGuidance}\n`;
  prompt += `**Render Safety:** Provider lyrics should contain only singable words after sanitization; no visible section labels, stage directions, or emoji.\n`;

  // Inject vocal performance engine identity into the audio prompt.
  const vpe = SONGWRITING.vocal_performance_engine;
  if (vpe) {
    prompt += `\n## Vocal Performance Identity\n\n`;
    if (vpe.priority) prompt += `**Priority:** ${vpe.priority}\n`;
    if (vpe.vocal_textures?.length) prompt += `**Vocal Textures:** ${vpe.vocal_textures.join(', ')}\n`;
    if (vpe.timing_behaviors?.length) prompt += `**Timing Behaviors:** ${vpe.timing_behaviors.join(', ')}\n`;
    if (vpe.adlib_behaviors?.length) prompt += `**Adlib Behaviors:** ${vpe.adlib_behaviors.join(', ')}\n`;
  }

  // Inject performance brief — the per-song conceit must be in the audio prompt.
  if (performanceBrief) {
    prompt += `\n## Performance Brief (Required)\n\n`;
    prompt += `**Vocal Conceit:** ${performanceBrief.vocal_conceit}\n`;
    prompt += `**Flow Movement:** ${performanceBrief.flow_movement}\n`;
    prompt += `**Hook Behavior:** ${performanceBrief.hook_behavior}\n`;
    prompt += `**Adlib Personality:** ${performanceBrief.adlib_personality}\n`;
    prompt += `**Sonic Oddity:** ${performanceBrief.sonic_oddity}\n`;
    prompt += `**Emotional Contradiction:** ${performanceBrief.emotional_contradiction}\n`;
  }

  // Anti-generic negative guidance.
  const antiGeneric = SONGWRITING.anti_generic_rules;
  if (antiGeneric?.length) {
    prompt += `\n## Anti-Generic Rules (apply to audio render)\n\n`;
    for (const rule of antiGeneric) prompt += `- ${rule}\n`;
  }
  // Add vocal avoid list as negative-prompt style guidance.
  if (vpe?.avoid?.length) {
    prompt += `\n**Do NOT produce:** ${vpe.avoid.join('; ')}\n`;
  }

  if (ap.special_notes) prompt += `\n**Special Notes:** ${ap.special_notes}\n`;
  prompt += `\n---\n\n## Full Lyrics\n\n${lyrics}\n`;
  return prompt;
}
