import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createAsset, getAssetsForSong } from './db.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');
const RELEASE_AUDIO_ASSET_TYPE = 'release_audio';
const AUDIO_EXT_RE = /\.(mp3|wav)$/i;

export function listSongAudioCandidates(songId, { assets = null } = {}) {
  const seen = new Set();
  const candidates = [];
  const songDir = path.join(OUTPUT_DIR, 'songs', songId);
  const distributionDir = path.join(OUTPUT_DIR, 'distribution-ready', songId);

  const addCandidate = (filePath, source, label = null) => {
    const absPath = absoluteFromMaybeRelative(filePath);
    if (!absPath || !AUDIO_EXT_RE.test(absPath) || !fs.existsSync(absPath)) return;
    const key = path.resolve(absPath);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      path: absPath,
      relativePath: relativeToRepo(absPath),
      url: toOutputUrl(absPath),
      name: label || path.basename(absPath),
      source,
      size: safeSize(absPath),
    });
  };

  addCandidate(path.join(distributionDir, 'upload-this.wav'), 'distribution-ready/upload-this.wav', 'upload-this.wav');
  addCandidate(path.join(distributionDir, 'upload-this.mp3'), 'distribution-ready/upload-this.mp3', 'upload-this.mp3');
  addCandidate(path.join(songDir, 'audio.wav'), 'songs/audio.wav', 'audio.wav');
  addCandidate(path.join(songDir, 'audio.mp3'), 'songs/audio.mp3', 'audio.mp3');

  const audioDir = path.join(songDir, 'audio');
  if (fs.existsSync(audioDir)) {
    for (const name of fs.readdirSync(audioDir).filter(name => AUDIO_EXT_RE.test(name)).sort()) {
      addCandidate(path.join(audioDir, name), 'songs/audio', name);
    }
  }

  const songAssets = assets || getAssetsForSong(songId);
  for (const asset of songAssets) {
    if (!asset?.file_path || !AUDIO_EXT_RE.test(asset.file_path)) continue;
    addCandidate(asset.file_path, `asset:${asset.asset_type || 'audio'}`, asset.label || path.basename(asset.file_path));
  }

  return candidates;
}

export function getSelectedReleaseAudio(songId, { assets = null } = {}) {
  const songAssets = assets || getAssetsForSong(songId);
  const selectedAsset = songAssets.find(asset => asset.asset_type === RELEASE_AUDIO_ASSET_TYPE && asset.is_current && asset.file_path)
    || songAssets.find(asset => asset.asset_type === RELEASE_AUDIO_ASSET_TYPE && asset.file_path);
  const candidates = listSongAudioCandidates(songId, { assets: songAssets });
  const selectedPath = absoluteFromMaybeRelative(selectedAsset?.file_path);
  const selected = selectedPath
    ? candidates.find(candidate => path.resolve(candidate.path) === path.resolve(selectedPath))
    : null;

  if (selected) {
    // An explicit canonical master has been chosen. If extra files exist they are
    // tolerated duplicates that have already been resolved by the selection.
    return {
      status: 'selected',
      selected,
      candidates,
      requiresSelection: false,
      duplicate: false,
      blocking: false,
      duplicateCount: candidates.length > 1 ? candidates.length : 0,
      message: candidates.length > 1
        ? `Release master selected (${candidates.length - 1} other audio file(s) present and ignored).`
        : 'Release master selected.',
    };
  }

  if (candidates.length === 1) {
    return {
      status: 'auto',
      selected: candidates[0],
      candidates,
      requiresSelection: false,
      duplicate: false,
      blocking: false,
      duplicateCount: 0,
      message: 'Only one audio file found; using it as the release master.',
    };
  }

  if (candidates.length > 1) {
    // Multiple masters for ONE track with no explicit selection is a release-integrity
    // error (likely a duplicate paid render), not a normal "choose one" workflow.
    // Packaging/DistroKid must be blocked until a human resolves it via the recovery picker.
    return {
      status: 'duplicate',
      selected: null,
      candidates,
      requiresSelection: true,
      duplicate: true,
      blocking: true,
      duplicateCount: candidates.length,
      message: `Duplicate master audio detected for this track (${candidates.length} files). Packaging and DistroKid submission blocked until resolved.`,
    };
  }

  return {
    status: 'missing',
    selected: null,
    candidates,
    requiresSelection: false,
    duplicate: false,
    blocking: false,
    duplicateCount: 0,
    message: 'No audio files found.',
  };
}

export function selectReleaseAudio(songId, filePath) {
  const candidates = listSongAudioCandidates(songId);
  const requested = absoluteFromMaybeRelative(filePath);
  const match = candidates.find(candidate => path.resolve(candidate.path) === path.resolve(requested || ''));
  if (!match) throw new Error('Selected audio file is not one of this song\'s known audio candidates.');

  createAsset({
    song_id: songId,
    asset_type: RELEASE_AUDIO_ASSET_TYPE,
    label: 'Release master audio',
    file_path: match.relativePath,
    mime_type: match.relativePath.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
    is_current: true,
    notes: `Selected release master from ${match.source}`,
  });

  return getSelectedReleaseAudio(songId);
}

export function absoluteFromMaybeRelative(filePath) {
  if (!filePath) return null;
  const value = String(filePath).trim();
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
}

export function relativeToRepo(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function toOutputUrl(absPath) {
  return '/media/' + path.relative(OUTPUT_DIR, absPath).replace(/\\/g, '/');
}

function safeSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}
