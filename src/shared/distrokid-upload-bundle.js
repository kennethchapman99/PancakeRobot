import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function absPath(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

function sanitizeName(name) {
  return String(name || '').replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Resolves the album's cover art + ordered track audio into a display/upload
// manifest. Paths match exactly what the Browsy replay payload sends, so what
// Ken uploads during recording is the same file the automation re-uploads later.
export function buildUploadManifest(samplePayload = {}) {
  const album = samplePayload.album || {};
  const coverSrc = absPath(album.coverArtPath);
  const coverExt = coverSrc ? path.extname(coverSrc) || '.png' : '.png';
  const tracks = (samplePayload.tracks || []).map((track, index) => {
    const number = Number(track.index || track.trackNumber || index + 1);
    const cleanTitle = sanitizeName(track.title) || `Track ${pad2(number)}`;
    const src = absPath(track.audioPath);
    const ext = src ? path.extname(src) || '.mp3' : '.mp3';
    return {
      number,
      title: track.title || `Track ${number}`,
      sourcePath: src,
      exists: src ? fs.existsSync(src) : false,
      bundleName: `${pad2(number)} - ${cleanTitle}${ext}`,
    };
  });
  return {
    cover: coverSrc
      ? {
          title: 'Album cover art',
          sourcePath: coverSrc,
          exists: fs.existsSync(coverSrc),
          bundleName: `cover-art${coverExt}`,
        }
      : null,
    tracks,
    bundleDirName: 'distrokid-upload',
  };
}

// Materializes a single folder of nicely-named files (hardlinked, falling back
// to copy across filesystems) so Finder shows them in track order for an easy
// multi-select during recording. Idempotent: the folder is rebuilt each call.
export function materializeUploadBundle({ releaseId, manifest }) {
  if (!releaseId) throw new Error('releaseId is required to materialize an upload bundle');
  const bundleDir = path.join(REPO_ROOT, 'output', 'release-packages', releaseId, manifest.bundleDirName);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  const linked = [];
  const missing = [];
  const place = (src, destName) => {
    if (!src || !fs.existsSync(src)) {
      missing.push(destName);
      return;
    }
    const dest = path.join(bundleDir, destName);
    try {
      fs.linkSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
    }
    linked.push(destName);
  };
  if (manifest.cover) place(manifest.cover.sourcePath, manifest.cover.bundleName);
  for (const track of manifest.tracks) place(track.sourcePath, track.bundleName);
  return { bundleDir, linked, missing };
}

export function openInFinder(targetPath) {
  return new Promise(resolve => {
    execFile('open', [targetPath], err => resolve(!err));
  });
}
