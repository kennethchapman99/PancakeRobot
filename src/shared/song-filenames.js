import fs from 'fs';
import path from 'path';

export function slugifySongFilename(title, ext = 'mp3') {
  const base = String(title || 'untitled-song')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'untitled-song';

  const cleanExt = String(ext || 'mp3').replace(/^\.+/, '').toLowerCase() || 'mp3';
  return `${base}.${cleanExt}`;
}

export function buildUniqueSongFilename({ dir, title, ext = 'mp3' } = {}) {
  const initial = slugifySongFilename(title, ext);
  if (!dir) return initial;

  const parsed = path.parse(initial);
  let attempt = 1;
  let candidate = initial;

  while (fs.existsSync(path.join(dir, candidate))) {
    attempt += 1;
    candidate = `${parsed.name}-${attempt}${parsed.ext}`;
  }

  return candidate;
}
