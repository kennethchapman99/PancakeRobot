import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getAlbum, getSong, getSongsForAlbum } from './db.js';
import { getSelectedReleaseAudio } from './song-audio-selection.js';
import { getReleaseAssetState } from './song-release-assets-service.js';
import { getActiveProfileId, loadBrandProfileById } from './brand-profile.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');

export function buildCanonicalDistroKidPayload({ releaseType, releaseId } = {}) {
  const normalizedType = String(releaseType || '').toLowerCase() === 'album' ? 'album' : 'single';
  const manifest = readJsonIfExists(path.join(REPO_ROOT, 'output', 'release-packages', String(releaseId || ''), 'manifest.json'));
  const release = normalizedType === 'album'
    ? buildAlbumReleaseContext(releaseId)
    : buildSingleReleaseContext(releaseId);
  const brandProfile = loadBrandProfileById(release.brandProfileId || getActiveProfileId());
  const releaseAssetState = getReleaseAssetState(normalizedType === 'album' ? 'album' : 'song', release.id);
  const topLevelMetadata = collectReleaseMetadata({ normalizedType, release, manifest, brandProfile });
  const trackPayloads = release.tracks.map((track, index) => {
    const trackManifest = normalizedType === 'album'
      ? (manifest?.tracks || []).find(item => item?.song_id === track.id || item?.track_metadata?.id === track.id) || null
      : manifest;
    return buildTrackPayload({
      track,
      index,
      trackManifest,
      fallbackArtistName: topLevelMetadata.artistName,
    });
  });

  return {
    releaseId: release.id,
    albumId: normalizedType === 'album' ? release.id : null,
    albumTitle: topLevelMetadata.albumTitle,
    artistName: topLevelMetadata.artistName,
    label: topLevelMetadata.label,
    releaseDate: topLevelMetadata.releaseDate,
    genre: topLevelMetadata.genre,
    language: topLevelMetadata.language,
    artworkPath: resolveArtworkPath({ manifest, releaseAssetState }),
    trackCount: trackPayloads.length,
    tracks: trackPayloads,
  };
}

function buildAlbumReleaseContext(albumId) {
  const album = getAlbum(albumId);
  if (!album) throw new Error(`Album not found: ${albumId}`);
  return {
    id: album.id,
    title: album.album_title || album.album_theme || album.id,
    releaseDate: album.release_date || null,
    brandProfileId: album.brand_profile_id || null,
    tracks: getSongsForAlbum(album.id),
  };
}

function buildSingleReleaseContext(songId) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  if (song.album_id) throw new Error(`Song ${songId} belongs to album ${song.album_id}; build the album payload instead.`);
  return {
    id: song.id,
    title: song.title || song.topic || song.id,
    releaseDate: song.release_date || null,
    brandProfileId: song.brand_profile_id || null,
    tracks: [song],
  };
}

function collectReleaseMetadata({ normalizedType, release, manifest, brandProfile }) {
  const firstTrack = release.tracks[0] || null;
  const firstMetadata = firstTrack ? loadMetadata(firstTrack) : {};
  const distribution = brandProfile?.distribution || {};
  return {
    albumTitle: clean(
      normalizedType === 'album'
        ? manifest?.album_metadata?.title || manifest?.release_title || release.title
        : manifest?.release_title || release.title
    ) || null,
    artistName: clean(manifest?.artist || firstMetadata.artist || firstMetadata.primary_artist || distribution.default_artist || brandProfile?.brand_name) || null,
    label: clean(manifest?.label || firstMetadata.label || distribution.label || brandProfile?.brand_name) || null,
    releaseDate: clean(manifest?.release_date || release.releaseDate) || null,
    genre: clean(manifest?.primary_genre || firstMetadata.primary_genre || firstMetadata.genre || distribution.primary_genre) || null,
    language: clean(manifest?.language || firstMetadata.language) || null,
  };
}

function buildTrackPayload({ track, index, trackManifest, fallbackArtistName }) {
  const metadata = loadMetadata(track);
  const absoluteLyricsPath = resolveAbsolutePath(trackManifest?.lyrics_file) || findLyricsPath(track);
  return {
    trackNumber: Number(trackManifest?.track_number || track.track_number || index + 1),
    title: clean(trackManifest?.track_title || metadata.title || track.title || track.topic || track.id) || track.id,
    audioPath: resolveAbsolutePath(trackManifest?.audio_file) || findAudioPath(track),
    artistName: clean(trackManifest?.artist || metadata.artist || metadata.primary_artist || fallbackArtistName) || null,
    songwriter: clean(trackManifest?.songwriter || metadata.songwriter) || null,
    producer: clean(trackManifest?.producer || metadata.producer) || null,
    songwriterRealName: normalizeObject(trackManifest?.songwriter_real_name || metadata.songwriter_real_name),
    appleMusicCredits: normalizeObject(trackManifest?.apple_music_credits || metadata.apple_music_credits),
    explicit: normalizeExplicit(trackManifest?.explicit ?? metadata.explicit ?? metadata.explicit_content_rating),
    instrumental: normalizeInstrumental(trackManifest?.instrumental, metadata),
    isAIGenerated: normalizeNullableBoolean(trackManifest?.is_ai_generated ?? metadata.is_ai_generated),
    aiDisclosure: normalizeObject(trackManifest?.ai_disclosure || metadata.ai_disclosure),
    lyrics: absoluteLyricsPath && fs.existsSync(absoluteLyricsPath)
      ? fs.readFileSync(absoluteLyricsPath, 'utf8')
      : null,
  };
}

function resolveArtworkPath({ manifest, releaseAssetState }) {
  const candidates = [
    resolveAbsolutePath(manifest?.cover_art),
    resolveAbsolutePath(manifest?.inherited_album_media?.primary_image),
    ...((manifest?.inherited_album_media?.assets || []).map(asset => resolveAbsolutePath(asset?.filePath || asset?.path || null))),
    releaseAssetState?.primaryImage?.path || null,
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function loadMetadata(song) {
  const candidates = [
    path.join(OUTPUT_DIR, 'distribution-ready', song.id, 'metadata.json'),
    resolveAbsolutePath(song.metadata_path),
    path.join(OUTPUT_DIR, 'songs', song.id, 'metadata.json'),
  ];
  for (const filePath of candidates) {
    if (filePath && fs.existsSync(filePath)) {
      return readJsonIfExists(filePath) || {};
    }
  }
  return song || {};
}

function findAudioPath(song) {
  const releaseAudio = getSelectedReleaseAudio(song.id);
  if (releaseAudio?.selected?.path && fs.existsSync(releaseAudio.selected.path)) return releaseAudio.selected.path;
  const candidates = [
    path.join(OUTPUT_DIR, 'distribution-ready', song.id, 'upload-this.wav'),
    path.join(OUTPUT_DIR, 'distribution-ready', song.id, 'upload-this.mp3'),
    path.join(OUTPUT_DIR, 'songs', song.id, 'audio.wav'),
    path.join(OUTPUT_DIR, 'songs', song.id, 'audio.mp3'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function findLyricsPath(song) {
  const candidates = [
    resolveAbsolutePath(song.lyrics_path),
    path.join(OUTPUT_DIR, 'songs', song.id, 'lyrics.txt'),
    path.join(OUTPUT_DIR, 'songs', song.id, 'lyrics.md'),
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function readJsonIfExists(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

function resolveAbsolutePath(filePath) {
  const value = clean(filePath);
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function clean(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length ? value : null;
}

function normalizeNullableBoolean(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'yes', '1', 'explicit', 'instrumental'].includes(normalized)) return true;
  if (['false', 'no', '0', 'clean'].includes(normalized)) return false;
  return null;
}

function normalizeExplicit(value) {
  return normalizeNullableBoolean(value);
}

function normalizeInstrumental(trackManifestValue, metadata = {}) {
  const direct = normalizeNullableBoolean(trackManifestValue);
  if (direct !== null) return direct;
  const fromMetadata = normalizeNullableBoolean(metadata.instrumental ?? metadata.is_instrumental);
  if (fromMetadata !== null) return fromMetadata;
  if (metadata.contains_lyrics === false) return true;
  return null;
}
