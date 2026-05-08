const MAGIC_PATTERNS = [
  /^\/magic\s+(.+)/i,
  /^\/song\s+(.+)/i,
  /^(?:make|create|generate|write)\s+(?:me\s+)?(?:a\s+)?song\s+(?:about|for|called|with|where)?\s*(.+)$/i,
  /^song\s+(?:about|for)?\s*(.+)$/i,
];

export function parseTelegramCommand(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return { type: 'empty' };

  if (/^\/start\b/i.test(clean)) return { type: 'help' };
  if (/^\/help\b/i.test(clean)) return { type: 'help' };
  if (/^\/cancel\b/i.test(clean)) return { type: 'cancel' };
  if (/^\/brands\b/i.test(clean)) return { type: 'brands' };

  for (const pattern of MAGIC_PATTERNS) {
    const match = clean.match(pattern);
    if (match?.[1]?.trim()) {
      return {
        type: 'magic_song_request',
        theme: cleanupTheme(match[1]),
      };
    }
  }

  // Telegram is intended as an on-the-fly command surface. Treat normal text as a theme.
  return {
    type: 'magic_song_request',
    theme: cleanupTheme(clean),
  };
}

export function getHelpText() {
  return [
    'Text me a song theme and I will ask which brand to use.',
    '',
    'Examples:',
    '/magic a dinosaur who cannot reach the syrup',
    'make me a song about pancake robot in space',
    '',
    'Commands:',
    '/brands - show available brand profiles',
    '/cancel - cancel the pending request',
  ].join('\n');
}

function cleanupTheme(theme) {
  return String(theme || '')
    .replace(/^about\s+/i, '')
    .replace(/^for\s+/i, '')
    .trim();
}
