import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

<<<<<<< HEAD
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
=======
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCHEMA_VERSION = 'pancake-distrokid-payload-v1';

export function buildDistroKidPayloadFromCockpit(cockpit, options = {}) {
  if (!cockpit) throw new Error('Release cockpit view model is required.');
  const repoRoot = options.repoRoot || REPO_ROOT;
  const manifest = cockpit.packageState?.manifest || {};
  const uploadPayload = manifest.canonical_distrokid_upload_payload || {};
  const releaseType = normalizeReleaseType(cockpit.type || manifest.release_type || uploadPayload.release_type);
  const releaseId = clean(cockpit.id || manifest.release_id || manifest.album_id || manifest.song_id);
  const releaseTitle = clean(uploadPayload.release_title || manifest.release_title || cockpit.title);
  const artistName = clean(uploadPayload.artist || manifest.artist || options.artistName || options.artist);
  const releaseDate = clean(uploadPayload.release_date || manifest.release_date || cockpit.releaseDate);
  const label = clean(uploadPayload.label || manifest.label || manifest.record_label || options.label);
  const primaryGenre = clean(uploadPayload.primary_genre || manifest.primary_genre || uploadPayload.genre || manifest.genre || options.primaryGenre || options.genre);
  const secondaryGenre = clean(uploadPayload.secondary_genre || manifest.secondary_genre || options.secondaryGenre);
  const artworkPath = toAbsolutePath(firstText(
    uploadPayload.artworkPath,
    uploadPayload.artwork_path,
    uploadPayload.cover_art,
    manifest.artworkPath,
    manifest.artwork_path,
    manifest.cover_art,
    cockpit.distrokidArtwork?.path,
    cockpit.releaseAssetState?.primaryImage?.path,
  ), repoRoot);

  const tracks = (cockpit.tracks || []).map((track, index) => buildTrackPayload({
    track,
    index,
    manifest,
    uploadPayload,
    repoRoot,
  }));

  const validation = buildValidation({ artworkPath, tracks });
  return pruneUndefined({
    schema_version: SCHEMA_VERSION,
    schemaVersion: SCHEMA_VERSION,
    source_system: 'pancake_robot',
    sourceSystem: 'pancake_robot',
    generated_at: options.generatedAt || new Date().toISOString(),
    generatedAt: options.generatedAt || new Date().toISOString(),
    release_type: releaseType,
    releaseType,
    release_id: releaseId,
    releaseId,
    album_id: releaseType === 'album' ? releaseId : undefined,
    albumId: releaseType === 'album' ? releaseId : undefined,
    release_title: releaseTitle,
    releaseTitle,
    artist: artistName,
    artistName,
    release_date: releaseDate,
    releaseDate,
    label,
    genre: primaryGenre,
    primary_genre: primaryGenre,
    primaryGenre,
    secondary_genre: secondaryGenre,
    secondaryGenre,
    artwork_path: artworkPath,
    artworkPath,
    artwork_exists: Boolean(artworkPath && fs.existsSync(artworkPath)),
    artworkExists: Boolean(artworkPath && fs.existsSync(artworkPath)),
    package_path: cockpit.packageState?.path || null,
    packagePath: cockpit.packageState?.path || null,
    package_manifest_path: cockpit.packageState?.manifestPath || null,
    packageManifestPath: cockpit.packageState?.manifestPath || null,
    tracks,
    track_count: tracks.length,
    trackCount: tracks.length,
    validation,
  });
}

export function writeDistroKidPayloadFromCockpit(cockpit, outputPath, options = {}) {
  if (!outputPath) throw new Error('outputPath is required.');
  const payload = buildDistroKidPayloadFromCockpit(cockpit, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { payload, outputPath };
}

export function buildBrowsyDistroKidWorkflowPackage({
  cockpit,
  campaign = null,
  task = null,
  dryRun = true,
  workflowId = null,
  outputDir = null,
  repoRoot = REPO_ROOT,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!cockpit) throw new Error('Release cockpit view model is required.');
  const canonicalPayload = buildDistroKidPayloadFromCockpit(cockpit, { repoRoot, generatedAt });
  const resolvedWorkflowId = clean(workflowId || task?.source_workflow_id)
    || (canonicalPayload.release_type === 'album' ? 'distrokid-album-submit' : 'distrokid-single-submit');
  const mode = dryRun ? 'preview' : 'live';
  const workflowDir = outputDir || path.join(
    repoRoot,
    'output',
    'release-workflows',
    clean(campaign?.id) || canonicalPayload.release_id || `release-${Date.now()}`,
    clean(task?.task_key) || resolvedWorkflowId,
  );
  fs.mkdirSync(workflowDir, { recursive: true });

  const payloadPath = path.join(workflowDir, 'distrokid-payload.json');
  const manifestPath = path.join(workflowDir, 'manifest.json');
  const packagePath = path.join(workflowDir, 'workflow-package.json');
  fs.writeFileSync(payloadPath, `${JSON.stringify(canonicalPayload, null, 2)}\n`, 'utf8');

  const manifest = {
    campaign_id: campaign?.id || null,
    task_key: task?.task_key || null,
    workflow_id: resolvedWorkflowId,
    release_type: canonicalPayload.release_type,
    release_id: canonicalPayload.release_id,
    generated_at: generatedAt,
    payload_path: asRepoRelativePath(payloadPath, repoRoot),
    canonical_payload_schema_version: canonicalPayload.schema_version,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const workflowPackage = {
    workflow_id: resolvedWorkflowId,
    source_system: 'pancake_robot',
    entity_type: canonicalPayload.release_type,
    entity_id: canonicalPayload.release_id,
    mode,
    pancake_mode: dryRun ? 'dry_run' : 'live',
    human_gate: true,
    manifest_path: asRepoRelativePath(manifestPath, repoRoot),
    payload_path: asRepoRelativePath(payloadPath, repoRoot),
    canonical_payload: canonicalPayload,
    assets: canonicalPayload.artworkPath ? [{ type: 'artwork', path: canonicalPayload.artworkPath }] : [],
    capture_outputs: defaultCaptureOutputs(resolvedWorkflowId),
    on_failure: 'stop_and_return_blocked_result',
    return_contract_version: 'automation-result-v1',
  };
  fs.writeFileSync(packagePath, `${JSON.stringify(workflowPackage, null, 2)}\n`, 'utf8');

  return {
    packagePath,
    manifestPath,
    payloadPath,
    payload: canonicalPayload,
    workflowPackage,
  };
}

function buildTrackPayload({ track, index, manifest, uploadPayload, repoRoot }) {
  const trackManifest = findTrackManifest(manifest, track);
  const uploadTrack = findTrackManifest(uploadPayload, track);
  const metadata = readTrackMetadata(track, trackManifest, repoRoot);
  const audioPath = toAbsolutePath(firstText(
    track.audioPath,
    track.audio_path,
    track.audio_file,
    track.releaseAudio?.selected?.path,
    track.releaseAudio?.selected?.filePath,
    track.releaseAudio?.selected?.absolutePath,
    track.fsAssets?.audioFiles?.[0]?.path,
    trackManifest?.audioPath,
    trackManifest?.audio_path,
    trackManifest?.audio_file,
    uploadTrack?.audioPath,
    uploadTrack?.audio_path,
    uploadTrack?.audio_file,
  ), repoRoot);
  const lyricsPath = toAbsolutePath(firstText(
    track.lyricsPath,
    track.lyrics_path,
    track.lyrics_file,
    track.fsAssets?.lyrics,
    trackManifest?.lyricsPath,
    trackManifest?.lyrics_path,
    trackManifest?.lyrics_file,
    uploadTrack?.lyricsPath,
    uploadTrack?.lyrics_path,
    uploadTrack?.lyrics_file,
  ), repoRoot);
  const lyrics = firstText(
    track.lyrics,
    track.lyrics_text,
    trackManifest?.lyrics,
    trackManifest?.lyrics_text,
    uploadTrack?.lyrics,
    uploadTrack?.lyrics_text,
  ) || readTextIfExists(lyricsPath);
  const songId = clean(track.id || track.song_id || trackManifest?.song_id || trackManifest?.track_metadata?.id);
  const title = clean(
    trackManifest?.track_title
      || uploadTrack?.track_title
      || track.title
      || track.topic
      || metadata.title
      || songId,
  );
  const trackNumber = Number(
    track.track_number
      || track.trackNumber
      || trackManifest?.track_number
      || uploadTrack?.track_number
      || index + 1,
  );
  const explicit = normalizeBoolean(firstDefined(
    track.explicit,
    track.is_explicit,
    trackManifest?.explicit,
    uploadTrack?.explicit,
    metadata.explicit,
    metadata.is_explicit,
  ));
  const instrumental = normalizeBoolean(firstDefined(
    track.instrumental,
    track.is_instrumental,
    trackManifest?.instrumental,
    trackManifest?.is_instrumental,
    uploadTrack?.instrumental,
    uploadTrack?.is_instrumental,
    metadata.instrumental,
    metadata.is_instrumental,
  ));
  const isAiGenerated = normalizeBoolean(firstDefined(
    track.is_ai_generated,
    track.isAiGenerated,
    trackManifest?.is_ai_generated,
    trackManifest?.isAiGenerated,
    uploadTrack?.is_ai_generated,
    uploadTrack?.isAiGenerated,
    metadata.is_ai_generated,
    metadata.isAiGenerated,
  ));

  return pruneUndefined({
    song_id: songId,
    songId,
    track_number: Number.isFinite(trackNumber) ? trackNumber : index + 1,
    trackNumber: Number.isFinite(trackNumber) ? trackNumber : index + 1,
    title,
    track_title: title,
    trackTitle: title,
    audio_path: audioPath,
    audioPath,
    audio_exists: Boolean(audioPath && fs.existsSync(audioPath)),
    audioExists: Boolean(audioPath && fs.existsSync(audioPath)),
    lyrics_path: lyricsPath,
    lyricsPath,
    lyrics,
    explicit,
    instrumental,
    songwriter: firstText(track.songwriter, trackManifest?.songwriter, uploadTrack?.songwriter, metadata.songwriter),
    producer: firstText(track.producer, trackManifest?.producer, uploadTrack?.producer, metadata.producer),
    is_ai_generated: isAiGenerated,
    isAiGenerated,
    ai_disclosure: firstDefined(track.ai_disclosure, track.aiDisclosure, trackManifest?.ai_disclosure, uploadTrack?.ai_disclosure, metadata.ai_disclosure, metadata.aiDisclosure),
    aiDisclosure: firstDefined(track.aiDisclosure, track.ai_disclosure, trackManifest?.aiDisclosure, trackManifest?.ai_disclosure, uploadTrack?.aiDisclosure, uploadTrack?.ai_disclosure, metadata.aiDisclosure, metadata.ai_disclosure),
    metadata,
  });
}

function findTrackManifest(container, track) {
  const tracks = Array.isArray(container?.tracks) ? container.tracks : [];
  const songId = clean(track?.id || track?.song_id);
  if (!tracks.length) {
    return container?.song_id || container?.audio_file || container?.track_title ? container : null;
  }
  return tracks.find(item => clean(item?.song_id || item?.id || item?.track_metadata?.id) === songId) || tracks[0] || null;
}

function readTrackMetadata(track, trackManifest, repoRoot) {
  if (track?.metadata && typeof track.metadata === 'object') return track.metadata;
  if (trackManifest?.metadata && typeof trackManifest.metadata === 'object') return trackManifest.metadata;
  const metadataPath = toAbsolutePath(firstText(
    track?.metadata_path,
    track?.metadataPath,
    track?.fsAssets?.metadata,
    trackManifest?.metadata_path,
    trackManifest?.metadataPath,
  ), repoRoot);
  return readJsonIfExists(metadataPath) || {};
}

function buildValidation({ artworkPath, tracks }) {
  const errors = [];
  const warnings = [];
  if (!artworkPath) errors.push('artworkPath is missing.');
  else if (!fs.existsSync(artworkPath)) errors.push(`artworkPath does not exist: ${artworkPath}`);
  for (const track of tracks) {
    if (!track.audioPath) errors.push(`${track.songId || track.trackNumber}: audioPath is missing.`);
    else if (!fs.existsSync(track.audioPath)) errors.push(`${track.songId || track.trackNumber}: audioPath does not exist: ${track.audioPath}`);
    if (!track.lyrics && !track.instrumental) warnings.push(`${track.songId || track.trackNumber}: lyrics are missing and track is not marked instrumental.`);
  }
  return {
    ready: errors.length === 0,
    errors,
    warnings,
  };
}

function defaultCaptureOutputs(workflowId) {
  if (/distrokid/i.test(workflowId || '')) {
    return ['external_release_url', 'smart_link_url', 'submission_status', 'review_page_screenshot'];
  }
  return ['artifact_paths'];
}

function normalizeReleaseType(value) {
  return String(value || '').toLowerCase() === 'album' ? 'album' : 'single';
}

function toAbsolutePath(value, repoRoot) {
  const raw = clean(value);
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

function asRepoRelativePath(value, repoRoot) {
  if (!value) return null;
  return path.relative(repoRoot, value).replace(/\\/g, '/');
>>>>>>> origin/main
}

function readJsonIfExists(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

<<<<<<< HEAD
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
=======
function readTextIfExists(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return '';
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function clean(value) {
  return String(value || '').trim();
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return false;
  return ['true', 'yes', '1', 'y'].includes(String(value).trim().toLowerCase());
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
>>>>>>> origin/main
}
