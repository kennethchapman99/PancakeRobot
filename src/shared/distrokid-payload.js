import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCHEMA_VERSION = 'pancake-distrokid-payload-v1';

export function buildDistroKidPayloadFromCockpit(cockpit, options = {}) {
  if (!cockpit) throw new Error('Release cockpit view model is required.');
  const repoRoot = options.repoRoot || REPO_ROOT;
  const manifest = cockpit.packageState?.manifest || {};
  const uploadPayload = manifest.canonical_distrokid_upload_payload || {};
  const releaseType = normalizeReleaseType(cockpit.type || manifest.release_type || uploadPayload.release_type);
  const releaseId = clean(
    cockpit.id
    || cockpit.releaseId
    || cockpit.release_id
    || cockpit.songId
    || cockpit.song_id
    || cockpit.release?.id
    || cockpit.release?.releaseId
    || cockpit.release?.release_id
    || uploadPayload.releaseId
    || uploadPayload.release_id
    || uploadPayload.albumId
    || uploadPayload.album_id
    || uploadPayload.songId
    || uploadPayload.song_id
    || manifest.releaseId
    || manifest.release_id
    || manifest.albumId
    || manifest.album_id
    || manifest.songId
    || manifest.song_id
    || (releaseType === 'single' ? findFirstSongId(cockpit.tracks?.[0], cockpit, manifest, uploadPayload) : '')
  );
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

  const sourceTracks = collectPayloadTracks({ cockpit, manifest, uploadPayload, releaseType, releaseId });
  const tracks = sourceTracks.map((track, index) => buildTrackPayload({
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

export function buildCanonicalDistroKidPayload(input, options = {}) {
  if (!input) throw new Error('DistroKid payload input is required.');

  if (input.packageState || input.tracks || input.type || input.id) {
    return buildDistroKidPayloadFromCockpit(input, options);
  }

  const manifest = input;
  const releaseType = normalizeReleaseType(
    manifest.release_type || (Array.isArray(manifest.tracks) && manifest.tracks.length > 1 ? 'album' : 'single')
  );

  const cockpit = {
    id: manifest.release_id || manifest.album_id || manifest.song_id,
    type: releaseType,
    title: manifest.release_title || manifest.album_title || manifest.title,
    releaseDate: manifest.release_date,
    packageState: { manifest },
    tracks: Array.isArray(manifest.tracks)
      ? manifest.tracks.map((track, index) => ({
          ...track,
          id: track.id || track.song_id || track.track_id || `track-${index + 1}`,
          title: track.title || track.track_title || track.topic,
        }))
      : [],
  };

  return buildDistroKidPayloadFromCockpit(cockpit, options);
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

function collectPayloadTracks({ cockpit, manifest, uploadPayload, releaseType, releaseId }) {
  const cockpitTracks = Array.isArray(cockpit?.tracks) ? cockpit.tracks.filter(Boolean) : [];
  if (cockpitTracks.length) return cockpitTracks;

  const manifestTracks = Array.isArray(manifest?.tracks) ? manifest.tracks.filter(Boolean) : [];
  if (manifestTracks.length) return manifestTracks;

  const uploadTracks = Array.isArray(uploadPayload?.tracks) ? uploadPayload.tracks.filter(Boolean) : [];
  if (uploadTracks.length) return uploadTracks;

  if (releaseType !== 'single') return [];

  const singleTrack = pruneUndefined({
    ...manifest,
    ...uploadPayload,
    id: releaseId
      || cockpit?.id
      || cockpit?.songId
      || cockpit?.song_id
      || manifest?.song_id
      || manifest?.songId
      || uploadPayload?.song_id
      || uploadPayload?.songId,
    song_id: releaseId
      || cockpit?.song_id
      || cockpit?.songId
      || manifest?.song_id
      || manifest?.songId
      || uploadPayload?.song_id
      || uploadPayload?.songId,
    songId: releaseId
      || cockpit?.songId
      || cockpit?.song_id
      || manifest?.songId
      || manifest?.song_id
      || uploadPayload?.songId
      || uploadPayload?.song_id,
    title: cockpit?.title
      || uploadPayload?.track_title
      || uploadPayload?.title
      || manifest?.track_title
      || manifest?.title
      || manifest?.release_title,
    track_title: uploadPayload?.track_title
      || manifest?.track_title
      || cockpit?.title
      || manifest?.title
      || manifest?.release_title,
    audioPath: uploadPayload?.audioPath
      || uploadPayload?.audio_path
      || uploadPayload?.audio_file
      || manifest?.audioPath
      || manifest?.audio_path
      || manifest?.audio_file,
    audio_path: uploadPayload?.audio_path
      || uploadPayload?.audioPath
      || uploadPayload?.audio_file
      || manifest?.audio_path
      || manifest?.audioPath
      || manifest?.audio_file,
    audio_file: uploadPayload?.audio_file
      || uploadPayload?.audioPath
      || uploadPayload?.audio_path
      || manifest?.audio_file
      || manifest?.audioPath
      || manifest?.audio_path,
    lyrics: uploadPayload?.lyrics || uploadPayload?.lyrics_text || manifest?.lyrics || manifest?.lyrics_text,
    lyricsPath: uploadPayload?.lyricsPath || uploadPayload?.lyrics_path || uploadPayload?.lyrics_file || manifest?.lyricsPath || manifest?.lyrics_path || manifest?.lyrics_file,
    lyrics_path: uploadPayload?.lyrics_path || uploadPayload?.lyricsPath || uploadPayload?.lyrics_file || manifest?.lyrics_path || manifest?.lyricsPath || manifest?.lyrics_file,
    metadata_path: uploadPayload?.metadata_path || uploadPayload?.metadataPath || manifest?.metadata_path || manifest?.metadataPath,
  });

  return singleTrack.song_id || singleTrack.songId || singleTrack.id || singleTrack.audioPath || singleTrack.audio_path || singleTrack.audio_file
    ? [singleTrack]
    : [];
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
  const songId = findFirstSongId(track, trackManifest, uploadTrack, metadata);
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

function findFirstSongId(...sources) {
  for (const source of sources) {
    const found = findSongIdInObject(source);
    if (found) return found;
  }
  return '';
}

function findSongIdInObject(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return '';

  const direct = clean(
    value.song_id
    || value.songId
    || value.songID
    || value.song_uuid
    || value.catalog_song_id
    || value.catalogSongId
    || value.source_song_id
    || value.sourceSongId
  );
  if (direct) return direct;

  const id = clean(value.id);
  if (id && /SONG/i.test(id)) return id;

  const nestedKeys = [
    'song',
    'sourceSong',
    'catalogSong',
    'track',
    'track_metadata',
    'trackMetadata',
    'metadata',
    'releaseSong',
    'dbSong',
    'record',
  ];

  for (const key of nestedKeys) {
    const found = findSongIdInObject(value[key], depth + 1);
    if (found) return found;
  }

  return '';
}

function findTrackManifest(container, track) {
  const tracks = Array.isArray(container?.tracks) ? container.tracks : [];
  const songId = clean(
    track?.id
    || track?.song_id
    || track?.songId
    || track?.song?.id
    || track?.song?.song_id
    || track?.track_metadata?.id
    || track?.metadata?.id
    || track?.metadata?.song_id
  );
  if (!tracks.length) {
    return container?.song_id || container?.songId || container?.id || container?.audio_file || container?.track_title ? container : null;
  }
  return tracks.find(item => clean(
    item?.song_id
    || item?.songId
    || item?.id
    || item?.track_id
    || item?.track_metadata?.id
    || item?.metadata?.id
    || item?.metadata?.song_id
  ) === songId) || tracks[0] || null;
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
}

function readJsonIfExists(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

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
}
