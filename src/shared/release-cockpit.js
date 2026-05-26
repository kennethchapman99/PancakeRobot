import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

import {
  addReleaseCockpitLog,
  getAlbum,
  getAllAlbums,
  getAllSongs,
  getDb,
  getReleaseCockpitLogs,
  getReleaseLinks,
  getSong,
  getSongsForAlbum,
} from './db.js';
import { DISTROKID_JOB_STATUSES, getDistroKidJob, markDistroKidJobStatus } from './distrokid-jobs.js';
import { getReleaseAssetState } from './song-release-assets-service.js';
import { getMarketingCampaigns } from './marketing-db.js';
import { DEFAULT_PROFILE_ID, getActiveProfileId, loadBrandProfileById } from './brand-profile.js';
import { getSelectedReleaseAudio } from './song-audio-selection.js';
import { summarizeMagicReleaseForCockpit } from './magic-release.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SONG_OUTPUT_ROOT = path.join(REPO_ROOT, 'output', 'songs');
const RELEASE_PACKAGE_ROOT = path.join(REPO_ROOT, 'output', 'release-packages');

export const RELEASE_LIFECYCLE_STATES = Object.freeze([
  'draft',
  'ready_for_review',
  'approved_for_distribution',
  'distrokid_previewed',
  'submitted_to_distrokid',
  'hyperfollow_ready',
  'pre_release_marketing_ready',
  'scheduled',
  'released',
  'post_release_complete',
]);

const RELEASE_LIFECYCLE_INDEX = new Map(RELEASE_LIFECYCLE_STATES.map((state, index) => [state, index]));
const PACKAGE_READY_JOB_STATUSES = new Set([
  DISTROKID_JOB_STATUSES.PACKAGE_BUILT,
  DISTROKID_JOB_STATUSES.DRY_RUN_READY,
  DISTROKID_JOB_STATUSES.AWAITING_MANUAL_REVIEW,
  DISTROKID_JOB_STATUSES.SUBMITTED,
  DISTROKID_JOB_STATUSES.SUBMITTED_PENDING_HYPERFOLLOW,
]);
const PREVIEW_READY_JOB_STATUSES = new Set([
  DISTROKID_JOB_STATUSES.DRY_RUN_READY,
  DISTROKID_JOB_STATUSES.AWAITING_MANUAL_REVIEW,
  DISTROKID_JOB_STATUSES.SUBMITTED,
  DISTROKID_JOB_STATUSES.SUBMITTED_PENDING_HYPERFOLLOW,
]);

export const RELEASE_COCKPIT_STAGES = Object.freeze([
  'metadata',
  'audio',
  'media',
  'distrokid_preview',
  'distrokid_live_submit',
  'hyperfollow',
  'youtube',
  'meta',
  'outreach',
  'platform_links',
]);

export function listReleaseCockpitEntries() {
  const albums = getAllAlbums().map(album => {
    const tracks = getSongsForAlbum(album.id);
    const hyperfollowUrl = findPersistedHyperFollowUrl(tracks);
    return {
      type: 'album',
      id: album.id,
      title: album.album_title || album.album_theme || album.id,
      subtitle: 'Album release',
      lifecycle: hyperfollowUrl ? 'hyperfollow_ready' : (album.status || 'draft'),
      releaseDate: album.release_date || null,
      stageSummary: `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
      blockerCount: 0,
      trackCount: tracks.length,
      brandProfileId: album.brand_profile_id || null,
      hyperfollowUrl,
      distributionStatus: summarizePersistedDistributionStatus(tracks),
      updatedAt: album.updated_at || album.created_at,
    };
  });
  const singles = getAllSongs()
    .filter(song => !song.album_id)
    .map(song => {
      const hyperfollowUrl = findPersistedHyperFollowUrl([song]);
      return {
        type: 'single',
        id: song.id,
        title: song.title || song.topic || song.id,
        subtitle: 'Single release',
        lifecycle: hyperfollowUrl ? 'hyperfollow_ready' : (song.status || 'draft'),
        releaseDate: song.release_date || null,
        stageSummary: '1 track',
        blockerCount: 0,
        trackCount: 1,
        brandProfileId: song.brand_profile_id || null,
        hyperfollowUrl,
        distributionStatus: song.distribution_status || song.status || null,
        updatedAt: song.updated_at || song.created_at,
      };
    });
  return [...albums, ...singles].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function buildReleaseCockpitViewModel(releaseType, releaseId) {
  const type = normalizeReleaseType(releaseType);
  const release = type === 'album' ? buildAlbumRelease(releaseId) : buildSingleRelease(releaseId);
  if (!release) return null;

  const tracks = release.tracks.map((track, index) => {
    const fsAssets = scanSongOutput(track.id);
    const releaseAudio = getSelectedReleaseAudio(track.id);
    return {
      ...track,
      track_number: track.track_number || index + 1,
      fsAssets,
      releaseAudio,
      links: getReleaseLinks(track.id),
      distrokidJob: getDistroKidJob(track.id),
    };
  });
  const assetState = getReleaseAssetState(type === 'album' ? 'album' : 'song', release.id);
  const campaigns = findReleaseCampaigns(tracks.map(track => track.id));
  const social = summarizeSocialPosts(tracks.map(track => track.id));
  const hyperfollow = findHyperFollow(tracks);
  const packageState = readReleasePackageState(type, release.id, tracks);
  const logs = getReleaseCockpitLogs(type, release.id, { limit: 50 });
  const magicRelease = summarizeMagicReleaseForCockpit(type, release.id);
  const stages = buildStages({ release, tracks, assetState, campaigns, social, hyperfollow, packageState, logs });
  const blockers = stages.filter(stage => stage.blocksLiveSubmit && stage.status !== 'complete').flatMap(stage => stage.issues);
  const lifecycle = determineReleaseLifecycle({ tracks, stages, blockers, hyperfollow, campaigns, packageState });
  const nextActions = buildNextActions({ type, release, stages, blockers, hyperfollow, lifecycle, packageState });

  return {
    type,
    id: release.id,
    title: release.title,
    subtitle: release.subtitle,
    releaseDate: release.releaseDate,
    brandProfileId: release.brandProfileId,
    canonicalMediaOwner: assetState.owner,
    releaseAssetState: assetState,
    tracks,
    lifecycle,
    packageState,
    stages,
    blockers,
    canLiveSubmit: blockers.length === 0,
    hyperfollow,
    campaigns,
    social,
    logs,
    magicRelease,
    nextActions,
    updatedAt: release.updatedAt,
  };
}

export function logReleaseCockpitEvent(releaseType, releaseId, action, status, message, payload = null) {
  return addReleaseCockpitLog({
    releaseType: normalizeReleaseType(releaseType),
    releaseId,
    action,
    status,
    message,
    payload,
  });
}

export function assertReleaseLiveSubmitReady(releaseType, releaseId) {
  const vm = buildReleaseCockpitViewModel(releaseType, releaseId);
  if (!vm) throw new Error('Release not found.');
  validateReleaseAction('live_submit', vm, { confirm: true });
  return vm;
}

export async function buildReleasePackageForCockpit(releaseType, releaseId) {
  const vm = buildReleaseCockpitViewModel(releaseType, releaseId);
  if (!vm) throw new Error('Release not found.');
  validateReleaseAction('package', vm);
  const results = [];
  for (const track of vm.tracks) {
    const output = await execFileAsync(process.execPath, [
      path.join(REPO_ROOT, 'scripts', 'distrokid', 'build-release-package.mjs'),
      '--song-id',
      track.id,
    ], {
      cwd: REPO_ROOT,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 4,
    });
    results.push({
      song_id: track.id,
      stdout: tail(output.stdout),
      stderr: tail(output.stderr),
    });
  }
  if (vm.type === 'album') {
    const manifest = writeCanonicalAlbumReleasePackage(vm);
    return {
      ok: manifest.readiness.ready_for_distrokid_dry_run,
      releaseType: vm.type,
      releaseId: vm.id,
      trackCount: vm.tracks.length,
      packagePath: releasePackagePath(vm.type, vm.id),
      manifestPath: releasePackageManifestPath(vm.type, vm.id),
      readiness: manifest.readiness,
      results,
    };
  }
  const manifest = readJsonIfExists(releasePackageManifestPath(vm.type, vm.id));
  return {
    ok: Boolean(manifest?.readiness?.ready_for_distrokid_dry_run),
    releaseType: vm.type,
    releaseId: vm.id,
    trackCount: vm.tracks.length,
    packagePath: releasePackagePath(vm.type, vm.id),
    manifestPath: releasePackageManifestPath(vm.type, vm.id),
    readiness: manifest?.readiness || null,
    results,
  };
}

export function validateReleaseAction(action, cockpit, options = {}) {
  if (!cockpit) throw new Error('Release not found.');
  const key = normalizeActionKey(action);
  const blockers = [];

  if (key === 'readiness') return { ok: true, state: cockpit.lifecycle.current, blockers: cockpit.blockers };

  if (['package', 'preview', 'live_submit'].includes(key) && cockpit.blockers.length) {
    blockers.push(...cockpit.blockers);
  }

  if (key === 'preview' && !cockpit.packageState.ready) {
    blockers.push(...(cockpit.packageState.blockers.length ? cockpit.packageState.blockers : ['Release package has not been built or is not DistroKid-ready']));
  }

  if (key === 'live_submit') {
    if (!cockpit.packageState.ready) blockers.push(...(cockpit.packageState.blockers.length ? cockpit.packageState.blockers : ['Release package has not been built or is not DistroKid-ready']));
    if (cockpit.stages.find(stage => stage.key === 'distrokid_preview')?.status !== 'complete' || !isAtLeastLifecycle(cockpit.lifecycle.current, 'distrokid_previewed')) {
      blockers.push('DistroKid preview has not been completed');
    }
    if (options.confirm !== true) blockers.push('Live DistroKid submit requires explicit confirmation.');
  }

  if (key === 'hyperfollow' && !isAtLeastLifecycle(cockpit.lifecycle.current, 'submitted_to_distrokid')) {
    blockers.push('HyperFollow requires submitted_to_distrokid lifecycle state.');
  }

  if (key === 'outreach' && !cockpit.hyperfollow?.url && options.draftOnly !== true) {
    blockers.push('Outreach requires HyperFollow unless it is explicitly created as a pre-HyperFollow draft-only campaign.');
  }

  if (blockers.length) throw new Error(`${actionLabel(key)} blocked: ${[...new Set(blockers)].join(', ')}`);
  return { ok: true, state: cockpit.lifecycle.current, blockers: [] };
}

export function getCanonicalReleaseManifestPath(releaseType, releaseId) {
  return releasePackageManifestPath(normalizeReleaseType(releaseType), releaseId);
}

export function getCanonicalReleaseManifest(releaseType, releaseId) {
  return readJsonIfExists(getCanonicalReleaseManifestPath(releaseType, releaseId));
}

function buildAlbumRelease(albumId) {
  const album = getAlbum(albumId);
  if (!album) return null;
  return {
    id: album.id,
    title: album.album_title || album.album_theme || album.id,
    subtitle: 'Album release',
    releaseDate: album.release_date || null,
    brandProfileId: album.brand_profile_id || null,
    tracks: getSongsForAlbum(album.id),
    updatedAt: album.updated_at || album.created_at,
  };
}

function buildSingleRelease(songId) {
  const song = getSong(songId);
  if (!song || song.album_id) return null;
  return {
    id: song.id,
    title: song.title || song.topic || song.id,
    subtitle: 'Single release',
    releaseDate: song.release_date || null,
    brandProfileId: song.brand_profile_id || null,
    tracks: [song],
    updatedAt: song.updated_at || song.created_at,
  };
}

function buildStages({ release, tracks, assetState, campaigns, social, hyperfollow, packageState, logs = [] }) {
  const metadataIssues = [];
  if (!release.title) metadataIssues.push('Release title is missing');
  if (!release.releaseDate) metadataIssues.push('Release date is missing');
  for (const track of tracks) {
    if (!track.title && !track.topic) metadataIssues.push(`${track.id}: track title is missing`);
    if (!track.fsAssets.metadata && !track.metadata_path) metadataIssues.push(`${track.id}: metadata.json is missing`);
  }

  const audioIssues = tracks.flatMap(track => {
    if (track.releaseAudio?.requiresSelection) {
      return [`${track.id}: choose release audio master (${track.releaseAudio.candidates?.length || 0} candidates)`];
    }
    if (!track.releaseAudio?.selected && !(track.fsAssets.audioFiles || []).length) {
      return [`${track.id}: audio file is missing`];
    }
    return [];
  });

  const mediaIssues = [];
  if (!assetState.primaryImage?.path) mediaIssues.push('Primary release image is missing');
  const missingDerivatives = (assetState.assets || []).filter(asset => !asset.publicUrl).map(asset => asset.label || asset.name);
  if (missingDerivatives.length) mediaIssues.push(`Platform derivatives missing: ${missingDerivatives.slice(0, 3).join(', ')}${missingDerivatives.length > 3 ? '...' : ''}`);

  const jobs = tracks.map(track => track.distrokidJob).filter(Boolean);
  const previewComplete = logs.some(log => log.action === 'distrokid_preview' && log.status === 'complete')
    || jobs.some(job => PREVIEW_READY_JOB_STATUSES.has(job.status));
  const liveComplete = tracks.every(track => ['submitted', 'submitted_pending_hyperfollow'].includes(track.distrokidJob?.status) || /submitted to distrokid/i.test(track.status || ''));
  const postLinks = tracks.flatMap(track => track.links || []).filter(link => !/hyperfollow|distrokid/i.test(`${link.platform} ${link.url}`));

  return [
    stage('metadata', 'Metadata ready', metadataIssues.length ? 'blocked' : 'complete', metadataIssues, true),
    stage('audio', 'Release audio selected', audioIssues.length ? 'blocked' : 'complete', audioIssues, true),
    stage('media', release.tracks?.length > 1 ? 'Album media ready' : 'Single media ready', mediaIssues.length ? 'needs_action' : 'complete', mediaIssues, true),
    stage('package', 'Canonical release package ready', packageState.ready ? 'complete' : packageState.exists ? 'blocked' : 'not_started', packageState.ready ? [] : packageState.blockers, false),
    stage('distrokid_preview', 'DistroKid preview complete', previewComplete ? 'complete' : 'not_started', previewComplete ? [] : ['Preview has not been run yet'], false),
    stage('distrokid_live_submit', 'DistroKid live submit complete', liveComplete ? 'complete' : 'not_started', liveComplete ? [] : ['Live submit has not been completed'], false),
    stage('hyperfollow', 'HyperFollow URL captured', hyperfollow?.url ? 'complete' : 'not_started', hyperfollow?.url ? [] : ['HyperFollow URL is not captured yet'], false),
    stage('youtube', 'YouTube publish/schedule status', social.youtube.complete ? 'complete' : social.youtube.any ? 'needs_action' : 'placeholder', social.youtube.issues, false),
    stage('meta', 'Meta/Instagram/Facebook publish/schedule status', social.meta.complete ? 'complete' : social.meta.any ? 'needs_action' : 'placeholder', social.meta.issues, false),
    stage('outreach', 'Outreach campaign status', campaigns.length ? 'complete' : 'not_started', campaigns.length ? [] : ['No outreach campaign is linked yet'], false),
    stage('platform_links', 'Post-release platform links updated', postLinks.length ? 'complete' : 'not_started', postLinks.length ? [] : ['Spotify, Apple, YouTube Music, and other platform links are not recorded yet'], false),
  ];
}

function stage(key, label, status, issues, blocksLiveSubmit) {
  return { key, label, status, issues, blocksLiveSubmit };
}

function buildNextActions({ type, release, stages, blockers, hyperfollow, lifecycle, packageState }) {
  const previewEnabled = blockers.length === 0 && packageState.ready;
  const liveEnabled = previewEnabled && isAtLeastLifecycle(lifecycle.current, 'distrokid_previewed');
  const hyperfollowEnabled = isAtLeastLifecycle(lifecycle.current, 'submitted_to_distrokid');
  return [
    { key: 'readiness', label: 'Run readiness check', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/readiness`, enabled: true },
    { key: 'package', label: 'Build/rebuild release package', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/package`, enabled: blockers.length === 0 },
    { key: 'preview', label: 'Run DistroKid automation preview', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-preview`, enabled: previewEnabled },
    { key: 'live_submit', label: 'Run DistroKid live submit', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-live-submit`, enabled: liveEnabled, confirmation: 'Run the live DistroKid submit? This can submit externally.' },
    { key: 'hyperfollow', label: hyperfollow?.url ? 'Refresh HyperFollow URL' : 'Fetch/add HyperFollow URL', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/hyperfollow`, enabled: hyperfollowEnabled },
    { key: 'outreach', label: 'Build outreach campaign', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/outreach`, enabled: true },
    { key: 'byteseed', label: 'ByteSeed video publishing', enabled: false, placeholder: true },
    { key: 'meta_publish', label: 'Meta publishing', enabled: false, placeholder: true },
  ].map(action => ({
    ...action,
    disabledReason: action.placeholder ? 'Placeholder: automation not implemented yet' : disabledReasonForAction(action.key, { blockers, packageState, lifecycle }),
    status: stages.find(stage => stage.key === action.key)?.status || null,
  }));
}

function entryFromViewModel(vm) {
  if (!vm) return null;
  return {
    type: vm.type,
    id: vm.id,
    title: vm.title,
    subtitle: vm.subtitle,
    lifecycle: vm.lifecycle.current,
    releaseDate: vm.releaseDate,
    stageSummary: `${vm.stages.filter(stage => stage.status === 'complete').length}/${vm.stages.length} complete`,
    blockerCount: vm.blockers.length,
    updatedAt: vm.updatedAt,
  };
}

function determineReleaseLifecycle({ tracks, stages, blockers, hyperfollow, campaigns, packageState }) {
  const complete = key => stages.find(stage => stage.key === key)?.status === 'complete';
  let current = 'draft';
  if (complete('metadata') || complete('audio') || complete('media')) current = 'ready_for_review';
  if (!blockers.length && packageState.ready) current = 'approved_for_distribution';
  if (complete('distrokid_preview')) current = 'distrokid_previewed';
  if (complete('distrokid_live_submit')) current = 'submitted_to_distrokid';
  if (hyperfollow?.url) current = 'hyperfollow_ready';
  if (campaigns.length) current = 'pre_release_marketing_ready';
  if (complete('youtube') || complete('meta')) current = 'scheduled';
  if (complete('platform_links')) current = 'released';
  if (complete('platform_links') && campaigns.length && (complete('youtube') || complete('meta'))) current = 'post_release_complete';

  const next = RELEASE_LIFECYCLE_STATES[Math.min(RELEASE_LIFECYCLE_INDEX.get(current) + 1, RELEASE_LIFECYCLE_STATES.length - 1)] || current;
  return { current, next, states: RELEASE_LIFECYCLE_STATES };
}

function isAtLeastLifecycle(current, target) {
  return (RELEASE_LIFECYCLE_INDEX.get(current) ?? 0) >= (RELEASE_LIFECYCLE_INDEX.get(target) ?? 0);
}

function readReleasePackageState(type, releaseId, tracks) {
  const manifestPath = releasePackageManifestPath(type, releaseId);
  const manifest = readJsonIfExists(manifestPath);
  if (manifest) {
    const blockers = manifest.readiness?.blocking_missing_fields || [];
    return {
      exists: true,
      ready: Boolean(manifest.readiness?.ready_for_distrokid_dry_run),
      path: releasePackagePath(type, releaseId),
      manifestPath,
      blockers,
      manifest,
    };
  }
  if (type === 'single') {
    const job = tracks[0]?.distrokidJob;
    const ready = PACKAGE_READY_JOB_STATUSES.has(job?.status);
    return {
      exists: Boolean(job?.package_path),
      ready,
      path: job?.package_path || releasePackagePath(type, releaseId),
      manifestPath,
      blockers: ready ? [] : ['Canonical release package has not been built'],
      manifest: null,
    };
  }
  return {
    exists: false,
    ready: false,
    path: releasePackagePath(type, releaseId),
    manifestPath,
    blockers: ['Canonical album release package has not been built'],
    manifest: null,
  };
}

function writeCanonicalAlbumReleasePackage(vm) {
  const packageDir = path.join(RELEASE_PACKAGE_ROOT, vm.id);
  fs.mkdirSync(packageDir, { recursive: true });
  const trackManifests = vm.tracks.map((track, index) => {
    const manifestPath = releasePackageManifestPath('single', track.id);
    const manifest = readJsonIfExists(manifestPath);
    if (!manifest) throw new Error(`Missing track package manifest: ${track.id}`);
    return {
      ...manifest,
      track_number: track.track_number || index + 1,
      track_title: manifest.track_title || track.title || track.topic || track.id,
      track_metadata: {
        id: track.id,
        title: track.title || track.topic || track.id,
        release_date: track.release_date || vm.releaseDate || null,
        brand_profile_id: track.brand_profile_id || vm.brandProfileId || null,
        status: track.status || null,
      },
    };
  });
  const first = trackManifests[0] || {};
  const album = getAlbum(vm.id);
  const profileId = vm.brandProfileId || first.brand_profile_id || getActiveProfileId();
  const brandProfile = loadProfile(profileId);
  const albumCover = vm.releaseAssetState?.primaryImage?.path
    ? copyAlbumCoverToPackage(vm.releaseAssetState.primaryImage.path, packageDir)
    : (first.cover_art || null);
  const blocking = trackManifests.flatMap(track => (track.readiness?.blocking_missing_fields || [])
    .filter(field => !(field === 'cover_art' && albumCover))
    .map(field => `${track.song_id}:${field}`));
  if (!albumCover) blocking.push('cover_art');

  const canonicalDistroKidUploadPayload = {
    release_type: 'album',
    artist: first.artist || brandProfile.distribution?.default_artist || brandProfile.brand_name || 'Pancake Robot',
    release_title: vm.title,
    release_date: vm.releaseDate,
    primary_genre: first.primary_genre || brandProfile.distribution?.primary_genre || null,
    secondary_genre: first.secondary_genre || null,
    cover_art: albumCover,
    tracks: trackManifests.map(track => ({
      track_number: track.track_number,
      track_title: track.track_title,
      audio_file: track.audio_file,
      lyrics_file: track.lyrics_file,
      explicit: track.explicit,
      songwriter: track.songwriter,
      producer: track.producer,
      is_ai_generated: track.is_ai_generated,
      ai_disclosure: track.ai_disclosure,
    })),
  };

  const manifest = {
    ...first,
    schema_version: 'distrokid-album-release-package-v1',
    song_id: vm.id,
    album_id: vm.id,
    release_type: 'album',
    brand_profile_id: profileId,
    release_title: vm.title,
    track_title: undefined,
    audio_file: undefined,
    lyrics_file: undefined,
    album_metadata: {
      id: vm.id,
      title: vm.title,
      theme: album?.album_theme || null,
      release_date: vm.releaseDate,
      number_of_songs: vm.tracks.length,
      brand_profile_id: profileId,
      status: album?.status || null,
    },
    inherited_album_media: {
      owner: vm.canonicalMediaOwner,
      primary_image: albumCover,
      assets: (vm.releaseAssetState?.assets || []).map(asset => ({
        name: asset.name,
        label: asset.label,
        filePath: asset.filePath || asset.path || null,
        publicUrl: asset.publicUrl || null,
        dimensions: asset.dimensions || null,
      })),
    },
    canonical_distrokid_upload_payload: canonicalDistroKidUploadPayload,
    tracks: trackManifests,
    readiness: {
      ready_for_distrokid_dry_run: blocking.length === 0 && trackManifests.length > 0,
      blocking_missing_fields: [...new Set(blocking)],
      track_count: trackManifests.length,
      ordered_tracks: trackManifests.map(track => track.song_id),
    },
  };

  fs.writeFileSync(path.join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(packageDir, 'missing-fields.json'), `${JSON.stringify({
    blocking_missing_fields: manifest.readiness.blocking_missing_fields,
    warning_missing_fields: [],
    all_missing_fields: manifest.readiness.blocking_missing_fields,
  }, null, 2)}\n`, 'utf8');
  for (const track of vm.tracks) {
    markDistroKidJobStatus(track.id, manifest.readiness.ready_for_distrokid_dry_run ? DISTROKID_JOB_STATUSES.PACKAGE_BUILT : DISTROKID_JOB_STATUSES.BLOCKED_MISSING_FIELDS, {
      package_path: releasePackagePath('album', vm.id),
      latest_error_json: manifest.readiness.blocking_missing_fields.length ? { blocking_missing_fields: manifest.readiness.blocking_missing_fields } : null,
    });
  }
  return manifest;
}

function copyAlbumCoverToPackage(sourcePath, packageDir) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const ext = path.extname(sourcePath).toLowerCase() || '.png';
  const dest = path.join(packageDir, `cover-art${ext}`);
  fs.copyFileSync(sourcePath, dest);
  return path.relative(REPO_ROOT, dest).replace(/\\/g, '/');
}

function releasePackagePath(type, releaseId) {
  return `output/release-packages/${String(releaseId || '')}`;
}

function releasePackageManifestPath(type, releaseId) {
  return path.join(REPO_ROOT, releasePackagePath(type, releaseId), 'manifest.json');
}

function readJsonIfExists(filePath) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

function loadProfile(profileId) {
  return loadBrandProfileById(profileId || DEFAULT_PROFILE_ID);
}

function normalizeActionKey(action) {
  const value = String(action || '').trim();
  if (value === 'distrokid-preview') return 'preview';
  if (value === 'distrokid-live-submit') return 'live_submit';
  return value;
}

function actionLabel(action) {
  return {
    package: 'Package',
    preview: 'DistroKid preview',
    live_submit: 'Live submit',
    hyperfollow: 'HyperFollow',
    outreach: 'Outreach',
  }[action] || action;
}

function disabledReasonForAction(key, { blockers, packageState, lifecycle }) {
  if (key === 'package' && blockers.length) return `Blocked: ${blockers.join(', ')}`;
  if (key === 'preview' && blockers.length) return `Blocked: ${blockers.join(', ')}`;
  if (key === 'preview' && !packageState.ready) return `Blocked: ${packageState.blockers.join(', ')}`;
  if (key === 'live_submit' && blockers.length) return `Blocked: ${blockers.join(', ')}`;
  if (key === 'live_submit' && !isAtLeastLifecycle(lifecycle.current, 'distrokid_previewed')) return 'Blocked: DistroKid preview has not been completed';
  if (key === 'hyperfollow' && !isAtLeastLifecycle(lifecycle.current, 'submitted_to_distrokid')) return 'Blocked: requires submitted_to_distrokid';
  return '';
}

function scanSongOutput(songId) {
  const songDir = path.join(SONG_OUTPUT_ROOT, songId);
  const result = { audioFiles: [] };
  if (!fs.existsSync(songDir)) return result;
  const exists = candidate => fs.existsSync(candidate) ? candidate : null;
  result.metadata = exists(path.join(songDir, 'metadata.json'));
  result.lyrics = exists(path.join(songDir, 'lyrics.md'));
  const rootAudio = [path.join(songDir, 'audio.mp3'), path.join(songDir, 'audio.wav')].filter(fs.existsSync);
  const audioDir = path.join(songDir, 'audio');
  const nested = fs.existsSync(audioDir)
    ? fs.readdirSync(audioDir).filter(name => /\.(mp3|wav)$/i.test(name)).map(name => path.join(audioDir, name))
    : [];
  result.audioFiles = [...rootAudio, ...nested].map(filePath => ({ path: filePath, name: path.basename(filePath), size: fs.statSync(filePath).size }));
  return result;
}

function findPersistedHyperFollowUrl(tracks = []) {
  for (const track of tracks) {
    const smartLink = track?.marketing_links?.smart_link;
    if (smartLink && /hyperfollow|distrokid/i.test(smartLink)) return smartLink;
    for (const link of getReleaseLinks(track.id)) {
      if (link?.url && /hyperfollow|distrokid/i.test(`${link.platform || ''} ${link.url || ''}`)) return link.url;
    }
  }
  return '';
}

function summarizePersistedDistributionStatus(tracks = []) {
  const statuses = [...new Set(tracks.map(track => track.distribution_status || track.status).filter(Boolean))];
  if (!statuses.length) return null;
  if (statuses.length === 1) return statuses[0];
  return `${statuses.length} statuses`;
}

function findHyperFollow(tracks) {
  for (const track of tracks) {
    const link = (track.links || []).find(item => /hyperfollow/i.test(`${item.platform || ''} ${item.url || ''}`));
    if (link?.url) return { url: link.url, sourceSongId: track.id, persisted: true };
    if (track.marketing_links?.smart_link && /hyperfollow|distrokid/i.test(track.marketing_links.smart_link)) {
      return { url: track.marketing_links.smart_link, sourceSongId: track.id, persisted: true };
    }
  }
  return { url: null, sourceSongId: null, persisted: false };
}

function findReleaseCampaigns(songIds) {
  const ids = new Set(songIds);
  return getMarketingCampaigns(500).filter(campaign => ids.has(campaign.focus_song_id));
}

function summarizeSocialPosts(songIds) {
  const ids = songIds.filter(Boolean);
  if (!ids.length) return emptySocialSummary();
  const placeholders = ids.map(() => '?').join(',');
  let rows = [];
  try {
    rows = getDb().prepare(`SELECT * FROM social_posts WHERE song_id IN (${placeholders})`).all(...ids);
  } catch {
    rows = [];
  }
  const youtubeRows = rows.filter(row => row.platform === 'youtube');
  const metaRows = rows.filter(row => ['instagram', 'facebook'].includes(row.platform));
  return {
    youtube: summarizePlatformRows(youtubeRows, 'YouTube publishing is not scheduled or published yet'),
    meta: summarizePlatformRows(metaRows, 'Meta publishing is a placeholder until Instagram/Facebook live publishing is implemented'),
  };
}

function emptySocialSummary() {
  return {
    youtube: { any: false, complete: false, issues: ['YouTube publishing is not scheduled or published yet'] },
    meta: { any: false, complete: false, issues: ['Meta publishing is a placeholder until Instagram/Facebook live publishing is implemented'] },
  };
}

function summarizePlatformRows(rows, fallbackIssue) {
  const any = rows.length > 0;
  const complete = any && rows.every(row => ['scheduled', 'published'].includes(row.status));
  return {
    any,
    complete,
    issues: complete ? [] : [fallbackIssue],
  };
}

function normalizeReleaseType(value) {
  return String(value || '').toLowerCase() === 'album' ? 'album' : 'single';
}

function tail(value) {
  return String(value || '').trim().split('\n').slice(-8).join('\n');
}
