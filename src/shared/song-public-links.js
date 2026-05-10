import fs from 'fs';
import path from 'path';

import { buildPublicUrl, getPublicBaseUrl, isLocalPublicBaseUrl } from './public-url.js';

const ROOT_DIR = process.cwd();
const OUTPUT_SONGS_DIR = path.resolve(ROOT_DIR, 'output', 'songs');
const SONG_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidSongId(songId) {
  return SONG_ID_PATTERN.test(String(songId || ''));
}

export function assertValidSongId(songId) {
  if (!isValidSongId(songId)) {
    throw new Error(`Invalid song id: ${songId}`);
  }
}

export function getSongDir(songId) {
  assertValidSongId(songId);
  const songDir = path.resolve(OUTPUT_SONGS_DIR, songId);
  if (!songDir.startsWith(`${OUTPUT_SONGS_DIR}${path.sep}`)) {
    throw new Error(`Unsafe song path for: ${songId}`);
  }
  return songDir;
}

export function getSongAudioPaths(songId) {
  const songDir = getSongDir(songId);
  return {
    mastered: path.join(songDir, 'masters', 'local_fast_master', 'mastered_320.mp3'),
    original: path.join(songDir, 'media', 'source', 'original.mp3'),
  };
}

export function getBestSongAudioFile(songId) {
  const audioPaths = getSongAudioPaths(songId);
  if (fs.existsSync(audioPaths.mastered)) {
    return { kind: 'mastered', filePath: audioPaths.mastered };
  }
  if (fs.existsSync(audioPaths.original)) {
    return { kind: 'original', filePath: audioPaths.original };
  }
  return null;
}

export function getSongAudioPublicPath(songId, kind = 'mastered') {
  assertValidSongId(songId);
  const safeId = encodeURIComponent(songId);
  if (kind === 'original') return `/media/songs/${safeId}/media/source/original.mp3`;
  return `/media/songs/${safeId}/masters/local_fast_master/mastered_320.mp3`;
}

export function buildSongPublicLinks(songId, options = {}) {
  assertValidSongId(songId);
  const safeId = encodeURIComponent(songId);
  const bestAudio = getBestSongAudioFile(songId);
  const audioKind = bestAudio?.kind || 'mastered';
  const detailPath = `/songs/${safeId}`;
  const releaseKitPath = `/release-kit/${safeId}?preview=1`;
  const audioPath = getSongAudioPublicPath(songId, audioKind);
  const baseUrl = getPublicBaseUrl({ allowLocalFallback: options.allowLocalFallback !== false });

  return {
    songId,
    baseUrl,
    publicBaseConfigured: Boolean(getPublicBaseUrl({ allowLocalFallback: false })),
    isLocalBaseUrl: isLocalPublicBaseUrl(baseUrl),
    audioKind,
    hasAudio: Boolean(bestAudio),
    audioPath,
    audioUrl: buildPublicUrl(audioPath, options),
    detailPath,
    detailUrl: buildPublicUrl(detailPath, options),
    releaseKitPath,
    releaseKitUrl: buildPublicUrl(releaseKitPath, options),
  };
}
