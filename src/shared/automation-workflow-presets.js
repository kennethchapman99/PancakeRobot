import fs from 'fs';

import { buildDistroKidPayloadFromCockpit } from './distrokid-payload.js';

export const DISTROKID_ALBUM_WORKFLOW_ID = 'distrokid-album-submit';
export const DISTROKID_ALBUM_WORKFLOW_NAME = 'DistroKid Album Submit';
export const PANCAKE_SOURCE_APP = 'pancake-robot';
export const DISTROKID_TARGET_URL = 'https://distrokid.com/new/';

export const DISTROKID_ALBUM_BINDING_HINTS = Object.freeze([
  'releaseId',
  'albumId',
  'album.id',
  'album.releaseId',
  'album.title',
  'album.artistName',
  'album.releaseDate',
  'album.language',
  'album.primaryGenre',
  'album.secondaryGenre',
  'album.coverArtPath',
  'tracks.length',
  'tracks[].index',
  'tracks[].title',
  'tracks[].audioPath',
  'tracks[].explicit',
  'tracks[].isrc',
  'tracks[].lyrics',
  'tracks[].songwriterCredits',
  'tracks[].aiDisclosure',
]);

export function getDistroKidAlbumSubmitPreset({ browsyBaseUrl = '', targetUrl = DISTROKID_TARGET_URL } = {}) {
  return {
    workflowId: DISTROKID_ALBUM_WORKFLOW_ID,
    workflowRef: `${PANCAKE_SOURCE_APP}.${DISTROKID_ALBUM_WORKFLOW_ID}`,
    workflowName: DISTROKID_ALBUM_WORKFLOW_NAME,
    sourceApp: PANCAKE_SOURCE_APP,
    targetUrl,
    browsyBaseUrl,
    inputSchema: {
      type: 'object',
      required: ['releaseId', 'album', 'tracks'],
      properties: {
        releaseId: { type: 'string' },
        albumId: { type: 'string' },
        album: {
          type: 'object',
          required: ['title', 'artistName', 'releaseDate', 'language', 'primaryGenre', 'coverArtPath'],
          properties: {
            id: { type: 'string' },
            releaseId: { type: 'string' },
            title: { type: 'string' },
            artistName: { type: 'string' },
            releaseDate: { type: ['string'], format: 'date' },
            language: { type: 'string' },
            primaryGenre: { type: 'string' },
            secondaryGenre: { type: 'string' },
            coverArtPath: { type: 'string', contentMediaType: 'application/octet-stream', 'x-pancake-kind': 'file' },
          },
        },
        tracks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['index', 'title', 'audioPath', 'explicit'],
            properties: {
              index: { type: 'number' },
              title: { type: 'string' },
              audioPath: { type: 'string', contentMediaType: 'application/octet-stream', 'x-pancake-kind': 'file' },
              explicit: { type: 'boolean' },
              isrc: { type: 'string' },
              lyrics: { type: 'string' },
              songwriterCredits: { type: 'object' },
              aiDisclosure: { type: 'object' },
            },
          },
        },
        derived: {
          type: 'object',
          properties: {
            numberOfSongs: { const: 'tracks.length', description: 'Derived from tracks.length' },
          },
        },
      },
    },
    requiredAssets: [
      { path: 'album.coverArtPath', type: 'file', label: 'Album cover art', required: true },
      { path: 'tracks[].audioPath', type: 'file', label: 'Track audio files', required: true },
    ],
    derivedVariables: {
      'derived.numberOfSongs': 'tracks.length',
      numberOfSongs: 'tracks.length',
    },
    bindingHints: DISTROKID_ALBUM_BINDING_HINTS.map(path => ({ path, label: path })),
  };
}

export function buildDistroKidAlbumSamplePayload(cockpit = null, options = {}) {
  if (!cockpit) return safeSamplePayload(options);
  const canonical = buildDistroKidPayloadFromCockpit(cockpit, options);
  const releaseId = clean(options.releaseId || canonical.releaseId || canonical.release_id || cockpit.id);
  const tracks = (canonical.tracks || []).map((track, index) => ({
    index: Number(track.trackNumber || track.track_number || index + 1),
    title: track.title || track.trackTitle || track.track_title || '',
    audioPath: track.audioPath || track.audio_path || '',
    explicit: Boolean(track.explicit),
    isrc: track.isrc || '',
    lyrics: track.lyrics || '',
    songwriterCredits: track.songwriterCredits || track.songwriter_credits || {},
    aiDisclosure: track.aiDisclosure || track.ai_disclosure || {},
  }));
  return {
    releaseId,
    albumId: releaseId,
    album: {
      id: releaseId,
      releaseId,
      title: canonical.releaseTitle || canonical.release_title || '',
      artistName: canonical.artistName || canonical.artist || cockpit.brandProfileName || '',
      releaseDate: canonical.releaseDate || canonical.release_date || '',
      language: canonical.language || 'English',
      primaryGenre: canonical.primaryGenre || canonical.primary_genre || canonical.genre || '',
      secondaryGenre: canonical.secondaryGenre || canonical.secondary_genre || '',
      coverArtPath: canonical.artworkPath || canonical.artwork_path || '',
    },
    tracks,
    derived: {
      numberOfSongs: tracks.length,
    },
  };
}

export function buildDistroKidAlbumWorkflowContext({ cockpit = null, browsyBaseUrl = '', targetUrl = DISTROKID_TARGET_URL, releaseId = '', packageId = '' } = {}) {
  const preset = getDistroKidAlbumSubmitPreset({ browsyBaseUrl, targetUrl });
  const resolvedReleaseId = releaseId || cockpit?.id || null;
  const samplePayload = buildDistroKidAlbumSamplePayload(cockpit, { releaseId: resolvedReleaseId });
  return {
    ...preset,
    releaseId: resolvedReleaseId,
    packageId: packageId || cockpit?.packageState?.id || cockpit?.packageState?.manifestPath || null,
    samplePayload,
    validation: validateDistroKidAlbumWorkflowContext({ ...preset, samplePayload }),
  };
}

export function validateDistroKidAlbumWorkflowContext(context = {}) {
  const errors = [];
  const warnings = [];
  const targetUrl = String(context.targetUrl || '').trim();
  const payload = context.samplePayload || {};
  const album = payload.album || {};
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];

  if (!targetUrl) errors.push('Target URL is required.');
  if (targetUrl === 'about:blank') errors.push('Target URL cannot be about:blank.');
  if (!context.inputSchema) errors.push('Input schema is required.');
  if (!payload.releaseId) errors.push('releaseId is required.');
  if (!album.title) errors.push('album.title is required.');
  if (!album.artistName) errors.push('album.artistName is required.');
  if (!album.releaseDate) errors.push('album.releaseDate is required.');
  if (!album.coverArtPath) errors.push('album.coverArtPath is required.');
  else if (!fileExistsIfLocal(album.coverArtPath)) warnings.push(`album.coverArtPath does not exist on disk: ${album.coverArtPath}`);
  if (tracks.length <= 0) errors.push('At least one track is required.');
  tracks.forEach((track, index) => {
    const label = `tracks[${index}]`;
    if (!track.title) errors.push(`${label}.title is required.`);
    if (!track.audioPath) errors.push(`${label}.audioPath is required.`);
    else if (!fileExistsIfLocal(track.audioPath)) warnings.push(`${label}.audioPath does not exist on disk: ${track.audioPath}`);
  });
  return {
    ok: errors.length === 0,
    state: errors.length ? 'setup_incomplete' : 'setup_valid',
    errors,
    warnings,
    indicators: [
      { key: 'targetUrl', label: 'Target URL', ok: Boolean(targetUrl && targetUrl !== 'about:blank') },
      { key: 'releaseId', label: 'Release ID', ok: Boolean(payload.releaseId) },
      { key: 'album.title', label: 'Album title', ok: Boolean(album.title) },
      { key: 'album.artistName', label: 'Artist name', ok: Boolean(album.artistName) },
      { key: 'album.releaseDate', label: 'Release date', ok: Boolean(album.releaseDate) },
      { key: 'album.coverArtPath', label: 'Cover art path', ok: Boolean(album.coverArtPath) },
      { key: 'tracks.length', label: 'Track count > 0', ok: tracks.length > 0 },
      { key: 'tracks[].title', label: 'Every track has a title', ok: tracks.length > 0 && tracks.every(track => Boolean(track.title)) },
      { key: 'tracks[].audioPath', label: 'Every track has an audio path', ok: tracks.length > 0 && tracks.every(track => Boolean(track.audioPath)) },
    ],
  };
}

function safeSamplePayload() {
  const releaseId = 'ALBUM_SAMPLE';
  return {
    releaseId,
    albumId: releaseId,
    album: {
      id: releaseId,
      releaseId,
      title: 'Sample Album',
      artistName: 'Sample Artist',
      releaseDate: '2026-09-01',
      language: 'English',
      primaryGenre: 'Hip Hop/Rap',
      secondaryGenre: '',
      coverArtPath: '/path/to/cover-art.png',
    },
    tracks: [
      {
        index: 1,
        title: 'Sample Track',
        audioPath: '/path/to/audio.wav',
        explicit: false,
        isrc: '',
        lyrics: '',
        songwriterCredits: {},
        aiDisclosure: {},
      },
    ],
    derived: { numberOfSongs: 1 },
  };
}

function fileExistsIfLocal(value) {
  const raw = String(value || '').trim();
  if (!raw || /^https?:\/\//i.test(raw)) return true;
  return fs.existsSync(raw);
}

function clean(value) {
  return String(value || '').trim();
}
