import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import fs from 'fs';
import { getAllSongs, getSong, upsertSong, upsertReleaseLink, getReleaseLinks } from '../../../shared/db.js';
import { renderMarketingLayout } from '../views/layout.js';
import { esc, attr, redirect } from '../utils/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const multer = _require('multer');

const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aiff', '.m4a']);

function buildAudioUpload(songId) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = join(__dirname, '../../../../../output/songs', songId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase() || '.mp3';
        cb(null, `audio${ext}`);
      },
    }),
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      cb(null, ALLOWED_AUDIO_EXTS.has(extname(file.originalname).toLowerCase()));
    },
  });
}

export function renderNewRelease(req, res) {
  const songs = getAllSongs().sort((a, b) => (a.title || a.topic || '').localeCompare(b.title || b.topic || ''));
  const error = req.query.error || null;

  const songOptions = songs.map(s =>
    `<option value="${attr(s.id)}">${esc(s.title || s.topic || s.id)} (${esc(s.status)})</option>`
  ).join('');

  const body = `<main class="p-8 max-w-2xl mx-auto space-y-6">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <h1 class="text-2xl font-extrabold mb-1">Add Release</h1>
      <p class="text-sm text-zinc-500 mb-6">Link a song to the marketing release list and fill in distribution details. <a href="/marketing" class="text-blue-600 hover:underline">← Marketing</a></p>
      ${error ? `<div class="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">${esc(error)}</div>` : ''}
      <form method="POST" action="/marketing/releases" enctype="multipart/form-data" class="space-y-5">

        <div>
          <label class="block text-sm font-semibold mb-1">Song <span class="text-red-500">*</span></label>
          <select name="song_id" required class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            <option value="">— select a song —</option>
            ${songOptions}
          </select>
          <p class="text-xs text-zinc-400 mt-1">Must be an existing song in the catalog. <a href="/songs" class="text-blue-600 hover:underline">Browse songs →</a></p>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-semibold mb-1">Release date</label>
            <input type="date" name="release_date" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-sm font-semibold mb-1">Distributor</label>
            <input type="text" name="distributor" placeholder="e.g. DistroKid" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
          </div>
        </div>

        <div>
          <label class="block text-sm font-semibold mb-1">Promote to status</label>
          <select name="status" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            <option value="">— keep current status —</option>
            <option value="approved">approved</option>
            <option value="metadata_ready">metadata_ready</option>
            <option value="ready_to_publish">ready_to_publish</option>
            <option value="submitted_to_distributor">submitted_to_distributor</option>
            <option value="published">published</option>
          </select>
          <p class="text-xs text-zinc-400 mt-1">Songs appear in the marketing release list when status is approved or higher.</p>
        </div>

        <div>
          <label class="block text-sm font-semibold mb-2">Streaming links</label>
          <div id="links" class="space-y-2">
            <div class="flex gap-2">
              <input type="text" name="link_platform[]" placeholder="Platform (e.g. Spotify)" class="w-40 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
              <input type="url" name="link_url[]" placeholder="https://..." class="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            </div>
            <div class="flex gap-2">
              <input type="text" name="link_platform[]" placeholder="Platform (e.g. Apple Music)" class="w-40 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
              <input type="url" name="link_url[]" placeholder="https://..." class="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            </div>
            <div class="flex gap-2">
              <input type="text" name="link_platform[]" placeholder="Platform (e.g. YouTube)" class="w-40 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
              <input type="url" name="link_url[]" placeholder="https://..." class="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            </div>
          </div>
        </div>

        <div>
          <label class="block text-sm font-semibold mb-1">Audio file <span class="text-zinc-400 font-normal">(optional — mp3/wav/flac)</span></label>
          <input type="file" name="audio_file" accept=".mp3,.wav,.flac,.aiff,.m4a" class="block w-full text-sm text-zinc-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-zinc-200 file:text-sm file:bg-zinc-50 hover:file:bg-zinc-100">
          <p class="text-xs text-zinc-400 mt-1">Saved as <code>audio.mp3</code> (or matching extension) in the song's output directory.</p>
        </div>

        <div>
          <label class="block text-sm font-semibold mb-1">Marketing notes</label>
          <textarea name="notes" rows="3" placeholder="Any notes for the marketing team…" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm resize-none"></textarea>
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <a href="/marketing" class="border border-zinc-200 rounded-lg px-4 py-2 text-sm hover:bg-zinc-50">Cancel</a>
          <button type="submit" class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Save release</button>
        </div>
      </form>
    </section>
  </main>`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout('Add Release', body));
}

export function postNewRelease(req, res) {
  const songId = (req.body?.song_id || '').trim();
  if (!songId) {
    return redirect(res, `/marketing/releases/new?error=${encodeURIComponent('Please select a song.')}`);
  }

  const song = getSong(songId);
  if (!song) {
    return redirect(res, `/marketing/releases/new?error=${encodeURIComponent('Song not found.')}`);
  }

  const fields = {};
  if (req.body.release_date) fields.release_date = req.body.release_date;
  if (req.body.distributor?.trim()) fields.distributor = req.body.distributor.trim();
  if (req.body.status) fields.status = req.body.status;
  if (req.body.notes?.trim()) fields.notes = req.body.notes.trim();

  if (req.file) {
    fields.audio_prompt_path = req.file.path;
  }

  if (Object.keys(fields).length) {
    upsertSong({ id: songId, ...fields });
  }

  // Save streaming links
  const platforms = [].concat(req.body['link_platform[]'] || []);
  const urls = [].concat(req.body['link_url[]'] || []);
  for (let i = 0; i < platforms.length; i++) {
    const platform = (platforms[i] || '').trim();
    const url = (urls[i] || '').trim();
    if (platform && url) {
      upsertReleaseLink(songId, platform, url);
    }
  }

  redirect(res, `/songs/${songId}?message=${encodeURIComponent('Release info saved.')}`);
}

// Multer middleware that resolves the song ID from req.body first (multipart)
export function handleNewReleaseUpload(req, res, next) {
  // We need to parse multipart to get song_id, then handle the file.
  // Use a temporary memoryStorage pass to get body fields first.
  const tmpUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }).single('audio_file');
  tmpUpload(req, res, (err) => {
    if (err && err.code !== 'LIMIT_UNEXPECTED_FILE') return next(err);

    const songId = (req.body?.song_id || '').trim();
    if (!songId || !req.file) return next(); // no file or no songId — skip disk write

    // Write the in-memory buffer to the correct output directory
    const dir = join(__dirname, '../../../../../output/songs', songId);
    fs.mkdirSync(dir, { recursive: true });
    const ext = extname(req.file.originalname).toLowerCase() || '.mp3';
    const dest = join(dir, `audio${ext}`);
    try {
      fs.writeFileSync(dest, req.file.buffer);
      req.file.path = dest;
    } catch (writeErr) {
      console.error('[releases] audio write failed', writeErr.message);
      req.file = null;
    }
    next();
  });
}
