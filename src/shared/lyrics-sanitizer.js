/**
 * Final lyrics sanitizer for paid music provider payloads.
 *
 * This is the last deterministic boundary before MiniMax or any other music
 * generation provider receives lyric text. Provider payloads must contain only
 * singable lyric lines: no labels, no stage notes, no markdown, no emoji, and
 * no active-profile forbidden contamination when strict brand blocking is on.
 */

const EMOJI_MATCHER = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
const EMOJI_STRIPPER = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
const SECTION_LABEL_LINE = /^\s*\[(?:INTRO|VERSE|VERSE\s+\d+|PRE[-\s]?CHORUS|CHORUS|HOOK|BRIDGE|FINAL\s+CHORUS|OUTRO|INTERLUDE|BREAKDOWN|CALL\/?RESPONSE|CALL\s+RESPONSE)[^\]]*\]\s*$/iu;
const ANY_BRACKETED_FRAGMENT = /\[[^\]]+\]/gu;
const ANY_BRACKETED_PAYLOAD = /\[[^\]]+\]/u;
const PARENTHETICAL_FRAGMENT = /\(([^)]*)\)/gu;
const WHOLE_LINE_EMPHASIS = /^\s*(?:\*{1,3}|_{1,3}|`{1,3})([^*_`\n]{3,})(?:\*{1,3}|_{1,3}|`{1,3})\s*$/u;
const MARKDOWN_ARTIFACT_LINE = /^\s*(?:#{1,6}\s+|[-*_]{3,}\s*$|```|>\s+)/u;
const PROMPT_ARTIFACT_LINE = /^\s*(?:\[\s*LYRICIST\s*\]|write a complete|output valid json|```|\{|\}|"?lyrics"?\s*:|"?audio_prompt"?\s*:)/iu;
const SPEAKER_OR_CUE_LABEL = /^\s*(?:kids?|children|crowd|choir|group|spoken|sfx|sound\s*effect|stage|producer|director)\s*:/iu;
const PRODUCTION_CUE_WORDS = /\b(?:vocals?\s+start|start\s+vocals?|music\s+slows?|music\s+speeds?|music\s+stops?|sfx|sound\s*effects?|stage\s+direction|production\s+note|instrumental\s+break|non-vocal|tempo\s*:|bpm\s*:|malfunction\s+sequence|call[-\s]?and[-\s]?response\s+section|audience\s+participation\s+cue)\b/iu;
const INLINE_MARKDOWN_TOKEN = /(?:\*\*|__|`|~~)/gu;
const INLINE_MARKDOWN_PAYLOAD = /(?:\*\*|__|`|~~)/u;
const METADATA_HEADER_LINE = /^\s*(?:key\s+hook|physical\s+action|word\s+count|funny\s+long\s+word)\s*:/iu;

export function sanitizeLyricsForProvider(lyrics = '', options = {}) {
  const forbiddenElements = Array.isArray(options.forbiddenElements) ? options.forbiddenElements : [];
  const blockBrandContamination = Boolean(options.blockBrandContamination);
  const raw = String(lyrics || '').replace(/\r\n/g, '\n');
  const removed = [];

  const preExistingForbidden = findForbiddenElementHits(raw, forbiddenElements);
  if (blockBrandContamination && preExistingForbidden.length > 0) {
    return {
      lyrics: '',
      removed,
      residualIssues: preExistingForbidden.map(hit => `forbidden active-profile element: ${hit.element}`),
      forbiddenHits: preExistingForbidden,
      blocked: true,
      blockReason: 'Brand contamination blocked lyrics',
    };
  }

  const lines = raw.split('\n');
  const cleanLines = [];

  lines.forEach((line, index) => {
    const original = line;
    let current = stripEmojiWithLog(line, removed, index);
    const trimmed = current.trim();

    if (!trimmed) {
      cleanLines.push('');
      return;
    }

    if (PROMPT_ARTIFACT_LINE.test(trimmed)) {
      removed.push(removedItem(index, original, 'prompt artifact line'));
      return;
    }

    if (SECTION_LABEL_LINE.test(trimmed)) {
      removed.push(removedItem(index, original, 'section label or bracketed direction line'));
      return;
    }

    if (MARKDOWN_ARTIFACT_LINE.test(trimmed)) {
      removed.push(removedItem(index, original, 'markdown artifact line'));
      return;
    }

    const emphasis = current.match(WHOLE_LINE_EMPHASIS);
    if (emphasis && PRODUCTION_CUE_WORDS.test(emphasis[1])) {
      removed.push(removedItem(index, original, 'markdown production direction line'));
      return;
    }
    if (emphasis) {
      current = emphasis[1].trim();
      removed.push(removedItem(index, original, 'markdown emphasis markers'));
    }

    if (SPEAKER_OR_CUE_LABEL.test(current)) {
      removed.push(removedItem(index, original, 'speaker or production cue label'));
      return;
    }

    current = current.replace(ANY_BRACKETED_FRAGMENT, fragment => {
      removed.push(removedItem(index, fragment, 'bracketed non-lyric fragment'));
      return '';
    });

    current = current.replace(PARENTHETICAL_FRAGMENT, (fragment, inner) => {
      const reason = PRODUCTION_CUE_WORDS.test(inner) ? 'parenthetical production direction' : 'parenthetical non-lyric content';
      removed.push(removedItem(index, fragment, reason));
      return '';
    });

    if (INLINE_MARKDOWN_PAYLOAD.test(current)) {
      removed.push(removedItem(index, original, 'inline markdown markers'));
      current = current.replace(INLINE_MARKDOWN_TOKEN, '');
    }

    if (METADATA_HEADER_LINE.test(current)) {
      removed.push(removedItem(index, original, 'metadata header line'));
      return;
    }

    current = normalizeProviderLine(current);
    if (!current) {
      if (original.trim()) removed.push(removedItem(index, original, 'empty after lyric sanitization'));
      return;
    }

    if (PRODUCTION_CUE_WORDS.test(current)) {
      removed.push(removedItem(index, original, 'production cue line'));
      return;
    }

    cleanLines.push(current);
  });

  const cleanLyrics = cleanLines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const residualIssues = findProviderLyricPayloadIssues(cleanLyrics, { forbiddenElements, blockBrandContamination });
  const forbiddenHits = blockBrandContamination ? findForbiddenElementHits(cleanLyrics, forbiddenElements) : [];

  return {
    lyrics: cleanLyrics,
    removed,
    residualIssues,
    forbiddenHits,
    blocked: blockBrandContamination && forbiddenHits.length > 0,
    blockReason: blockBrandContamination && forbiddenHits.length > 0 ? 'Brand contamination blocked lyrics' : null,
  };
}

export function findProviderLyricPayloadIssues(lyrics = '', options = {}) {
  const forbiddenElements = Array.isArray(options.forbiddenElements) ? options.forbiddenElements : [];
  const blockBrandContamination = Boolean(options.blockBrandContamination);
  const issues = [];
  const text = String(lyrics || '');

  if (!text.trim()) issues.push('empty lyrics payload');
  if (EMOJI_MATCHER.test(text)) issues.push('emoji remains in provider lyrics payload');
  if (ANY_BRACKETED_PAYLOAD.test(text)) issues.push('bracketed label or direction remains in provider lyrics payload');
  if (INLINE_MARKDOWN_PAYLOAD.test(text) || text.split('\n').some(line => MARKDOWN_ARTIFACT_LINE.test(line.trim()))) {
    issues.push('markdown remains in provider lyrics payload');
  }
  if (text.split('\n').some(line => SPEAKER_OR_CUE_LABEL.test(line.trim()))) {
    issues.push('speaker or cue label remains in provider lyrics payload');
  }
  if (text.split('\n').some(line => METADATA_HEADER_LINE.test(line.trim()))) {
    issues.push('metadata header line remains in provider lyrics payload');
  }
  if (PRODUCTION_CUE_WORDS.test(text)) {
    issues.push('production direction cue remains in provider lyrics payload');
  }

  if (blockBrandContamination) {
    for (const hit of findForbiddenElementHits(text, forbiddenElements)) {
      issues.push(`forbidden active-profile element remains: ${hit.element}`);
    }
  }

  return [...new Set(issues)];
}

export function assertProviderLyricsSafe(lyrics = '', options = {}) {
  const result = sanitizeLyricsForProvider(lyrics, options);
  if (result.blocked || result.blockReason) {
    throw new Error(result.blockReason || 'Brand contamination blocked lyrics');
  }
  if (result.residualIssues.length > 0) {
    throw new Error(`Provider lyric payload blocked: ${result.residualIssues.join('; ')}`);
  }
  return result;
}

export function findForbiddenElementHits(text = '', forbiddenElements = []) {
  const normalized = normalizeForForbiddenMatch(text);
  return forbiddenElements
    .flatMap(element => buildForbiddenPatterns(element).map(pattern => ({ element, pattern })))
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ element, pattern }) => ({ element, pattern: pattern.source }));
}

function stripEmojiWithLog(line, removed, index) {
  const matches = String(line || '').match(EMOJI_STRIPPER);
  if (matches?.length) {
    for (const fragment of matches) removed.push(removedItem(index, fragment, 'emoji'));
  }
  return String(line || '').replace(EMOJI_STRIPPER, '');
}

function normalizeProviderLine(line = '') {
  return String(line)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function removedItem(index, content, reason) {
  return {
    line: index + 1,
    reason,
    content: String(content || '').trim(),
  };
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
