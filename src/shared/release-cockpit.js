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
import { getSongFinanceSummary } from './finance-manager.js';
import { getSelectedReleaseAudio } from './song-audio-selection.js';
import { isRealSongCatalogRow } from './song-catalog-cleanup.js';
import { summarizeMagicReleaseForCockpit } from './magic-release.js';
import { validateCanonicalReleasePackageManifest } from './release-package-validation.js';

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
const DISTROKID_DIAGNOSTIC_CATEGORY_ORDER = Object.freeze([
  'album_metadata',
  'tracks',
  'audio_uploads',
  'artwork',
  'ai_disclosure',
  'certifications',
]);
const DISTROKID_DIAGNOSTIC_CATEGORY_LABELS = Object.freeze({
  album_metadata: 'Album metadata',
  tracks: 'Tracks',
  audio_uploads: 'Audio uploads',
  artwork: 'Artwork',
  ai_disclosure: 'AI disclosure',
  certifications: 'Certifications',
});

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
  const albums = getAllAlbums().flatMap(album => {
    const tracks = getSongsForAlbum(album.id).filter(isRealSongCatalogRow);
    const plannedTrackCount = Array.isArray(album.shared_orchestration?.plan?.tracks)
      ? album.shared_orchestration.plan.tracks.length
      : 0;
    const allowPlannedAlbum = tracks.length === 0 && plannedTrackCount > 0 && album.status === 'generating_tracks';
    if (tracks.length === 0 && !allowPlannedAlbum) return [];
    const hyperfollowUrl = findPersistedHyperFollowUrl(tracks);
    const trackCount = tracks.length || plannedTrackCount;
    return {
      type: 'album',
      id: album.id,
      title: album.album_title || album.album_theme || album.id,
      subtitle: 'Album release',
      lifecycle: hyperfollowUrl ? 'hyperfollow_ready' : (album.status || 'draft'),
      releaseDate: album.release_date || null,
      stageSummary: tracks.length
        ? `${trackCount} track${trackCount === 1 ? '' : 's'}`
        : `${trackCount} planned track${trackCount === 1 ? '' : 's'}`,
      blockerCount: 0,
      trackCount,
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
    const finance = getSongFinanceSummary(track.id, { syncArtifacts: false });
    return {
      ...track,
      track_number: track.track_number || index + 1,
      fsAssets,
      releaseAudio,
      finance,
      links: getReleaseLinks(track.id),
      distrokidJob: getDistroKidJob(track.id),
    };
  });
  const assetState = getReleaseAssetState(type === 'album' ? 'album' : 'song', release.id);
  const distrokidArtwork = resolveDistroKidArtwork(assetState);
  const campaigns = findReleaseCampaigns(tracks.map(track => track.id));
  const social = summarizeSocialPosts(tracks.map(track => track.id));
  const hyperfollow = findHyperFollow(tracks);
  const packageState = readReleasePackageState(type, release.id, tracks);
  const logs = getReleaseCockpitLogs(type, release.id, { limit: 50 });
  const runHistory = buildRunHistory(logs);
  const magicRelease = summarizeMagicReleaseForCockpit(type, release.id);
  const liveSubmitApproval = summarizeLiveSubmitApproval(magicRelease);
  const stages = buildStages({
    type,
    release,
    tracks,
    assetState,
    distrokidArtwork,
    campaigns,
    social,
    hyperfollow,
    packageState,
    logs,
    runHistory,
    liveSubmitApproval,
    magicRelease,
  });
  const blockers = stages.filter(stage => stage.blocksLiveSubmit && stage.status !== 'complete').flatMap(stage => stage.issues);
  const lifecycle = determineReleaseLifecycle({ tracks, stages, blockers, hyperfollow, campaigns, packageState });
  const nextActions = buildNextActions({ type, release, stages, blockers, hyperfollow, lifecycle, packageState, liveSubmitApproval, magicRelease });
  const trackTable = buildTrackTable({ type, release, tracks });
  const commandCenter = buildCommandCenter({ type, release, stages, nextActions, magicRelease, liveSubmitApproval, packageState, hyperfollow });
  const blockerSummary = summarizeCockpitBlockers({ type, release, stages, blockers });
  const canLiveSubmit = Boolean(nextActions.find(action => action.key === 'live_submit')?.enabled);

  return {
    type,
    id: release.id,
    title: release.title,
    subtitle: release.subtitle,
    releaseDate: release.releaseDate,
    brandProfileId: release.brandProfileId,
    canonicalMediaOwner: assetState.owner,
    releaseAssetState: assetState,
    distrokidArtwork,
    tracks,
    lifecycle,
    packageState,
    stages,
    blockers,
    blockerSummary,
    canLiveSubmit,
    hyperfollow,
    campaigns,
    social,
    logs,
    runHistory,
    magicRelease,
    liveSubmitApproval,
    nextActions,
    commandCenter,
    trackTable,
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
  const validation = validateCanonicalReleasePackageManifest(manifest, { releaseType: vm.type });
  return {
    ok: validation.ready,
    releaseType: vm.type,
    releaseId: vm.id,
    trackCount: vm.tracks.length,
    packagePath: releasePackagePath(vm.type, vm.id),
    manifestPath: releasePackageManifestPath(vm.type, vm.id),
    readiness: manifest?.readiness || { ready_for_distrokid_dry_run: validation.ready, blocking_missing_fields: validation.blocking_missing_fields },
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

  if (key === 'approve_live_submit') {
    blockers.push(...getPreviewApprovalBlockers(cockpit));
  }

  if (key === 'live_submit') {
    if (!cockpit.packageState.ready) blockers.push(...(cockpit.packageState.blockers.length ? cockpit.packageState.blockers : ['Release package has not been built or is not DistroKid-ready']));
    blockers.push(...getPreviewApprovalBlockers(cockpit));
    if (!cockpit.liveSubmitApproval?.approved) blockers.push('Live DistroKid submit requires explicit human approval.');
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

export function resolveDistroKidArtwork(assetState) {
  const img = assetState?.primaryImage;
  if (!img?.path || !fs.existsSync(img.path)) {
    return { path: null, ext: null, source: null, blocked: true };
  }
  const ext = path.extname(img.path).replace(/^\./, '').toLowerCase() || 'png';
  return { path: img.path, ext, source: img.source || 'release_primary', blocked: false };
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

function buildStages({ type, release, tracks, assetState, distrokidArtwork, campaigns, social, hyperfollow, packageState, logs = [], runHistory = [], liveSubmitApproval = null, magicRelease = null }) {
  const metadataIssues = [];
  const metadataTrackIds = [];
  if (!release.title) metadataIssues.push('Release title is missing');
  if (!release.releaseDate) metadataIssues.push('Release date is missing');
  for (const track of tracks) {
    if (!track.title && !track.topic) metadataIssues.push(`${track.id}: track title is missing`);
    if (!track.fsAssets.metadata && !track.metadata_path) {
      metadataIssues.push(`${track.id}: metadata.json is missing`);
      metadataTrackIds.push(track.id);
    }
  }

  const audioTrackIds = [];
  const audioIssues = tracks.flatMap(track => {
    if (track.releaseAudio?.requiresSelection) {
      audioTrackIds.push(track.id);
      return [`${track.id}: choose release audio master (${track.releaseAudio.candidates?.length || 0} candidates)`];
    }
    if (!track.releaseAudio?.selected && !(track.fsAssets.audioFiles || []).length) {
      audioTrackIds.push(track.id);
      return [`${track.id}: audio file is missing`];
    }
    return [];
  });

  const mediaIssues = [];
  if (!assetState.primaryImage?.path) mediaIssues.push('Primary release image is missing');
  const missingDerivatives = (assetState.assets || []).filter(asset => !asset.publicUrl).map(asset => asset.label || asset.name);
  if (missingDerivatives.length) mediaIssues.push(`Platform derivatives missing: ${missingDerivatives.slice(0, 3).join(', ')}${missingDerivatives.length > 3 ? '...' : ''}`);

  const jobs = tracks.map(track => track.distrokidJob).filter(Boolean);
  const latestPreviewRun = findLatestRun(runHistory, 'distrokid_preview');
  const latestLiveSubmitRun = findLatestRun(runHistory, 'distrokid_live_submit');
  const latestHyperFollowRun = findLatestRun(runHistory, 'hyperfollow');
  const latestOutreachRun = findLatestRun(runHistory, 'outreach_campaign');
  const previewAssessment = assessPreviewRun({
    run: latestPreviewRun,
    releaseType: type,
    releaseId: release.id,
    packageState,
  });
  const previewPassed = previewAssessment.outcome === 'passed';
  const liveComplete = tracks.every(track => ['submitted', 'submitted_pending_hyperfollow'].includes(track.distrokidJob?.status) || /submitted to distrokid/i.test(track.status || ''));
  const postLinks = tracks.flatMap(track => track.links || []).filter(link => !/hyperfollow|distrokid/i.test(`${link.platform} ${link.url}`));
  const tracksMetadataUrl = `/releases/${type}/${encodeURIComponent(release.id)}?focus=metadata#tracks`;
  const tracksAudioUrl = `/releases/${type}/${encodeURIComponent(release.id)}?focus=audio#tracks`;
  const needsPackageCoverArtFix = packageState.validation.missingCoverArtCount > 0;
  const packageBuildLabel = packageState.exists ? 'Rebuild canonical package' : 'Build canonical package';
  const artworkBlockerMsg = distrokidArtwork?.blocked ? 'DistroKid artwork not resolved: upload a release image or configure a brand default image.' : null;
  const readyForPackage = !metadataIssues.length && !audioIssues.length && !mediaIssues.length;
  const readyForPreview = readyForPackage && packageState.ready && !artworkBlockerMsg;
  const readyForApproval = previewPassed && packageState.ready && getPreviewApprovalBlockers({
    type,
    id: release.id,
    latestPreviewRun,
    latestPreviewAssessment: previewAssessment,
    packageState,
    stages: [],
    lifecycle: { current: previewPassed ? 'distrokid_previewed' : 'approved_for_distribution' },
  }).length === 0;
  const readyForLiveSubmit = readyForApproval;
  const readyHyperfollowCapture = Boolean(magicRelease?.tasks?.some(task => task.task_key === 'hyperfollow_capture' && task.status === 'ready'));
  const packageBlockedReason = readyForPackage ? packageState.summary : `Blocked by ${[metadataIssues.length ? 'metadata' : '', audioIssues.length ? 'audio' : '', mediaIssues.length ? 'release assets' : ''].filter(Boolean).join(', ')}`;
  const previewDetail = previewAssessment.summary
    || latestPreviewRun?.error
    || latestPreviewRun?.message
    || (artworkBlockerMsg ? artworkBlockerMsg : readyForPreview ? 'Ready to run the DistroKid preview automation.' : (packageState.ready ? 'Resolve release blockers before preview can run.' : 'Waiting for the canonical package to become ready.'));
  const liveSubmitDetail = latestLiveSubmitRun?.error
    || latestLiveSubmitRun?.message
    || (liveComplete
      ? 'Live submit completed.'
      : readyForLiveSubmit
        ? (liveSubmitApproval?.approved ? 'Ready to run the live submit automation.' : 'Waiting for explicit human approval before live submit.')
        : 'Waiting for DistroKid preview to complete.');
  const hyperfollowDetail = latestHyperFollowRun?.error
    || latestHyperFollowRun?.message
    || (hyperfollow?.url ? `Saved HyperFollow URL: ${hyperfollow.url}` : liveComplete ? 'Paste or capture the HyperFollow URL after submission.' : 'Waiting for DistroKid submission before HyperFollow can be captured.');
  const outreachDetail = latestOutreachRun?.error
    || latestOutreachRun?.message
    || (campaigns.length ? `Built ${campaigns.length} outreach campaign${campaigns.length === 1 ? '' : 's'}.` : hyperfollow?.url ? 'Ready to build outreach and social tasks.' : 'Waiting for HyperFollow before non-draft outreach.');

  return [
    stage('metadata', 'Metadata inspection', metadataIssues.length ? 'blocked' : 'complete', metadataIssues, true, {
      owner: 'Pipeline',
      affectedTrackIds: metadataTrackIds,
      detail: metadataIssues.length ? metadataIssues.join('; ') : 'All required release metadata is present.',
      actions: [
        { label: 'Fix metadata', method: 'GET', url: metadataTrackIds.length === 1 ? `/songs/${encodeURIComponent(metadataTrackIds[0])}?tab=meta` : tracksMetadataUrl, enabled: metadataIssues.length > 0 },
        { label: 'Generate missing metadata', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/generate-metadata`, enabled: metadataTrackIds.length > 0 },
        { label: 'Open filtered tracks', method: 'GET', url: tracksMetadataUrl, enabled: metadataTrackIds.length > 0 },
      ],
    }),
    stage('audio', 'Release audio master', audioIssues.length ? 'blocked' : 'complete', audioIssues, true, {
      owner: 'Human review',
      affectedTrackIds: audioTrackIds,
      detail: audioIssues.length ? audioIssues.join('; ') : 'Every track has a selected release master.',
      actions: [
        { label: 'Choose master', method: 'GET', url: audioTrackIds.length === 1 ? `/songs/${encodeURIComponent(audioTrackIds[0])}/release-audio?return_to=${encodeURIComponent(`/releases/${type}/${encodeURIComponent(release.id)}`)}` : tracksAudioUrl, enabled: audioTrackIds.length > 0 },
        { label: 'Generate master', method: 'GET', url: audioTrackIds.length === 1 ? `/songs/${encodeURIComponent(audioTrackIds[0])}/generate` : tracksAudioUrl, enabled: audioTrackIds.length > 0 },
        { label: 'Open affected tracks', method: 'GET', url: tracksAudioUrl, enabled: audioTrackIds.length > 0 },
      ],
    }),
    stage('media', release.tracks?.length > 1 ? 'Release assets' : 'Release assets', mediaIssues.length ? 'blocked' : 'complete', mediaIssues, true, {
      owner: 'Pipeline',
      detail: mediaIssues.length ? mediaIssues.join('; ') : 'Primary artwork and platform derivatives are ready.',
      actions: [
        { label: assetState.primaryImage?.path ? 'Generate / refresh release assets' : 'Open album details', method: assetState.primaryImage?.path ? 'POST' : 'GET', url: assetState.primaryImage?.path ? `/releases/${type}/${encodeURIComponent(release.id)}/actions/release-assets/build` : (type === 'album' ? `/albums/${encodeURIComponent(release.id)}` : `/songs/${encodeURIComponent(tracks[0]?.id || release.id)}`), enabled: true },
      ],
    }),
    stage('package', 'Canonical package', packageState.ready ? 'complete' : (packageState.exists ? 'blocked' : (readyForPackage ? 'ready' : 'blocked')), packageState.ready ? [] : [packageBlockedReason], false, {
      owner: 'Pipeline',
      detail: packageState.ready ? 'Canonical package is ready for DistroKid.' : packageState.summary,
      issues: packageState.validation.issues.map(issue => issue.message),
      blockerCount: packageState.validation.issues.length || (packageState.ready ? 0 : 1),
      actions: [
        { label: packageBuildLabel, method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/package`, enabled: readyForPackage, disabledReason: readyForPackage ? '' : packageBlockedReason },
        { label: 'Generate / rebuild release assets', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/release-assets/build`, enabled: needsPackageCoverArtFix, disabledReason: needsPackageCoverArtFix ? '' : 'Release assets only need rebuilding when cover art is missing from the canonical package.' },
        { label: 'Rerun package validation', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/package-validation`, enabled: true },
      ],
    }),
    stage('distrokid_preview', 'DistroKid preview',
      latestPreviewRun?.status === 'running'
        ? 'running'
        : latestPreviewRun?.status === 'blocked'
          ? 'blocked'
          : latestPreviewRun?.status === 'failed' || previewAssessment.outcome === 'failed'
            ? 'failed'
            : previewPassed
              ? 'complete'
              : previewAssessment.outcome === 'incomplete'
                ? 'blocked'
              : readyForPreview
                ? 'ready'
                : 'blocked',
      artworkBlockerMsg
        ? [artworkBlockerMsg]
        : (['blocked', 'failed'].includes(latestPreviewRun?.status) || ['failed', 'incomplete'].includes(previewAssessment.outcome)
          ? [previewAssessment.summary || latestPreviewRun?.error || latestPreviewRun?.message || previewDetail]
          : (previewPassed ? [] : [previewDetail])), false, {
      owner: 'Browsy automation',
      detail: readyForPreview || latestPreviewRun ? previewDetail : packageState.summary,
      issues: !readyForPreview ? packageState.validation.issues.map(issue => issue.message) : [],
      blockerCount: !readyForPreview && packageState.validation.issues.length ? packageState.validation.issues.length : 1,
      latestRun: latestPreviewRun,
      outcome: previewAssessment.outcome,
      outcomeLabel: previewAssessment.outcomeLabel,
      processStatusLabel: latestPreviewRun?.processStatusLabel || null,
      diagnostics: previewAssessment.diagnostics,
      actions: [
        { label: latestPreviewRun?.status === 'blocked' ? 'Complete login in browser, then resume preview' : (latestPreviewRun ? 'Rerun DistroKid preview automation' : 'Run DistroKid preview automation'), method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-preview`, enabled: readyForPreview && latestPreviewRun?.status !== 'running' && !latestPreviewRun?.payload?.active, disabledReason: latestPreviewRun?.status === 'running' || latestPreviewRun?.payload?.active ? 'Preview automation is already running.' : (readyForPreview ? '' : packageState.summary) },
        { label: 'Stop / cancel run', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-preview/stop`, enabled: Boolean(latestPreviewRun?.payload?.active) && ['running', 'blocked'].includes(latestPreviewRun?.status), disabledReason: latestPreviewRun?.payload?.active ? '' : 'No active preview run is available to stop.' },
      ],
    }),
    stage('distrokid_live_submit', 'Live submit', latestLiveSubmitRun?.status === 'running' ? 'running' : latestLiveSubmitRun?.status === 'failed' ? 'failed' : liveComplete ? 'complete' : readyForLiveSubmit && liveSubmitApproval?.approved ? 'ready' : 'blocked', latestLiveSubmitRun?.status === 'failed' ? [latestLiveSubmitRun.error || latestLiveSubmitRun.message] : (liveComplete ? [] : [liveSubmitDetail]), false, {
      owner: liveSubmitApproval?.approved ? 'Browsy automation' : 'Human review',
      detail: liveSubmitDetail,
      latestRun: latestLiveSubmitRun,
      actions: [
        { label: liveSubmitApproval?.approved ? 'Live submit approved' : 'Approve live submit', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/approve-live-submit`, enabled: readyForApproval && !liveComplete, disabledReason: readyForApproval ? '' : getPreviewApprovalBlockers({ type, id: release.id, latestPreviewRun, latestPreviewAssessment: previewAssessment, packageState, stages: [], lifecycle: { current: previewPassed ? 'distrokid_previewed' : 'approved_for_distribution' } }).join(', ') || 'Preview must pass before live submit can be approved.' },
        { label: 'Run live submit automation', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-live-submit`, enabled: readyForLiveSubmit && Boolean(liveSubmitApproval?.approved) && !liveComplete && latestLiveSubmitRun?.status !== 'running', confirmation: 'Run the live DistroKid submit? This can submit externally.', disabledReason: latestLiveSubmitRun?.status === 'running' ? 'Live submit automation is already running.' : (liveSubmitApproval?.approved ? '' : 'Human approval is still required.') },
      ],
    }),
    stage('hyperfollow', 'HyperFollow capture', latestHyperFollowRun?.status === 'failed' ? 'failed' : hyperfollow?.url ? 'complete' : liveComplete ? 'ready' : 'blocked', latestHyperFollowRun?.status === 'failed' ? [latestHyperFollowRun.error || latestHyperFollowRun.message] : (hyperfollow?.url ? [] : [hyperfollowDetail]), false, {
      owner: liveComplete ? 'Browsy automation' : 'Platform/manual',
      detail: hyperfollowDetail,
      latestRun: latestHyperFollowRun,
      actions: [
        { label: 'Paste HyperFollow URL', method: 'GET', url: `/releases/${type}/${encodeURIComponent(release.id)}#hyperfollow-step`, enabled: liveComplete || Boolean(hyperfollow?.url) },
        { label: 'Save HyperFollow', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/hyperfollow`, enabled: liveComplete || Boolean(hyperfollow?.url), disabledReason: liveComplete || hyperfollow?.url ? '' : 'Available after live submit.' },
        { label: 'Capture with Browsy', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/magic-release/tasks/hyperfollow_capture/run`, enabled: readyHyperfollowCapture, disabledReason: readyHyperfollowCapture ? '' : 'No HyperFollow capture workflow is ready yet.' },
      ],
    }),
    stage('outreach', 'Outreach / social handoff', latestOutreachRun?.status === 'failed' ? 'failed' : campaigns.length ? 'complete' : hyperfollow?.url ? 'ready' : 'blocked', latestOutreachRun?.status === 'failed' ? [latestOutreachRun.error || latestOutreachRun.message] : (campaigns.length ? [] : [outreachDetail]), false, {
      owner: 'Pipeline',
      detail: outreachDetail,
      latestRun: latestOutreachRun,
      actions: [
        { label: 'Build outreach campaign', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/outreach`, enabled: true },
        { label: 'Send outreach / social tasks', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/outreach`, enabled: true },
      ],
    }),
    stage('platform_links', 'Platform links', postLinks.length ? 'complete' : liveComplete ? 'not_started' : 'blocked', postLinks.length ? [] : [liveComplete ? 'Post-release store links are not recorded yet.' : 'Waiting for submission before link harvest.'], false, {
      owner: liveComplete ? 'Browsy automation' : 'Platform/manual',
      detail: postLinks.length ? `Captured ${postLinks.length} post-release platform link${postLinks.length === 1 ? '' : 's'}.` : (liveComplete ? 'Post-release store links are not recorded yet.' : 'Waiting for submission before link harvest.'),
      actions: [],
    }),
  ];
}

function stage(key, label, status, issues, blocksLiveSubmit, options = {}) {
  return {
    key,
    label,
    status,
    displayStatus: humanizeCockpitStatus(status),
    issues,
    blocksLiveSubmit,
    owner: options.owner || 'Pipeline',
    optional: options.optional === true,
    affectedTrackIds: options.affectedTrackIds || [],
    blockerCount: options.blockerCount || (options.affectedTrackIds || []).length || issues.length,
    detail: options.detail || ((issues || []).length ? issues.join('; ') : 'Ready.'),
    validationIssues: options.issues || [],
    latestRun: options.latestRun || null,
    outcome: options.outcome || null,
    outcomeLabel: options.outcomeLabel || null,
    processStatusLabel: options.processStatusLabel || null,
    diagnostics: options.diagnostics || null,
    actions: (options.actions || []).filter(action => action && action.label),
  };
}

function buildNextActions({ type, release, stages, blockers, hyperfollow, lifecycle, packageState, liveSubmitApproval, magicRelease }) {
  const previewEnabled = blockers.length === 0 && packageState.ready;
  const previewStage = stages.find(stage => stage.key === 'distrokid_preview') || null;
  const previewBlockers = getPreviewApprovalBlockers({
    type,
    id: release.id,
    latestPreviewRun: previewStage?.latestRun || null,
    latestPreviewAssessment: previewStage ? {
      outcome: previewStage.outcome,
      diagnostics: previewStage.diagnostics,
    } : null,
    packageState,
    stages,
    lifecycle,
  });
  const approvalEnabled = previewBlockers.length === 0 && !liveSubmitApproval?.approved;
  const liveEnabled = isAtLeastLifecycle(lifecycle.current, 'distrokid_previewed') && Boolean(liveSubmitApproval?.approved) && previewBlockers.length === 0;
  const hyperfollowEnabled = isAtLeastLifecycle(lifecycle.current, 'submitted_to_distrokid');
  return [
    { key: 'readiness', label: 'Run readiness check', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/readiness`, enabled: true },
    { key: 'plan', label: 'Generate / refresh release plan', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/magic-release/plan`, enabled: true },
    { key: 'package', label: 'Build canonical package', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/package`, enabled: blockers.length === 0 },
    { key: 'preview', label: 'Run DistroKid preview automation', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-preview`, enabled: previewEnabled },
    { key: 'approve_live_submit', label: 'Approve live submit', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/approve-live-submit`, enabled: approvalEnabled },
    { key: 'live_submit', label: 'Run live submit automation', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-live-submit`, enabled: liveEnabled, confirmation: 'Run the live DistroKid submit? This can submit externally.' },
    { key: 'hyperfollow', label: hyperfollow?.url ? 'Save HyperFollow' : 'Capture HyperFollow URL', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/hyperfollow`, enabled: hyperfollowEnabled },
    { key: 'outreach', label: 'Build outreach campaign', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/outreach`, enabled: true },
    { key: 'release_assets', label: 'Generate / refresh release assets', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/release-assets/build`, enabled: Boolean(stages.find(stage => stage.key === 'media')?.actions?.some(action => action.enabled)) },
    { key: 'browsy_dry_run', label: 'Run Browsy dry run', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/magic-release/browsy-dry-run`, enabled: Boolean(magicRelease?.tasks?.some(task => task.owner === 'browsy' && task.status === 'ready')) },
  ].map(action => ({
    ...action,
    disabledReason: disabledReasonForAction(action.key, {
      blockers,
      packageState,
      lifecycle,
      liveSubmitApproval,
      cockpit: {
        type,
        id: release.id,
        stages,
        latestPreviewAssessment: previewStage ? {
          outcome: previewStage.outcome,
          diagnostics: previewStage.diagnostics,
        } : null,
      },
    }),
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

function getPreviewApprovalBlockers(cockpit) {
  const blockers = [];
  const previewStage = cockpit?.stages?.find(stage => stage.key === 'distrokid_preview') || null;
  const latestPreviewRun = cockpit?.latestPreviewRun || previewStage?.latestRun || cockpit?.latestPreviewRun || null;
  const previewOutcome = previewStage?.outcome || cockpit?.latestPreviewAssessment?.outcome || cockpit?.latestPreviewAssessment || null;
  const diagnostics = previewStage?.diagnostics || cockpit?.latestPreviewAssessment?.diagnostics || null;
  const runLog = latestPreviewRun?.diagnostics?.runLog || null;

  if (!latestPreviewRun) blockers.push('No latest DistroKid preview run exists.');
  if (!runLog) blockers.push('Latest DistroKid preview diagnostics were not found.');
  if (latestPreviewRun && runLog && !previewRunMatchesRelease(runLog, cockpit?.type, cockpit?.id)) {
    blockers.push('Latest DistroKid preview is not for this release package.');
  }
  if (previewOutcome !== 'passed') {
    blockers.push(previewOutcome === 'incomplete'
      ? 'Latest DistroKid preview did not stage the release.'
      : previewOutcome === 'failed'
        ? 'Latest DistroKid preview failed.'
        : 'Latest DistroKid preview has not passed.');
  }
  if (runLog && Number(runLog.filled_count || 0) === 0) blockers.push('Latest DistroKid preview filled 0 fields.');
  if (runLog && Number(runLog.error_count || 0) > 0) blockers.push(`Latest DistroKid preview has ${runLog.error_count} error${Number(runLog.error_count) === 1 ? '' : 's'}.`);
  if (runLog && runLog.stopped_before_submit !== true) blockers.push('Latest DistroKid preview did not stop before submit.');
  if (runLog && runLog.dry_run !== true) blockers.push('Latest DistroKid preview was not a dry run.');
  if (diagnostics?.requiredMissingCount > 0) blockers.push('Required DistroKid uploads or controls are still missing.');
  return [...new Set(blockers)];
}

function isAtLeastLifecycle(current, target) {
  return (RELEASE_LIFECYCLE_INDEX.get(current) ?? 0) >= (RELEASE_LIFECYCLE_INDEX.get(target) ?? 0);
}

function readReleasePackageState(type, releaseId, tracks) {
  const manifestPath = releasePackageManifestPath(type, releaseId);
  const manifest = readJsonIfExists(manifestPath);
  if (manifest) {
    const validation = validateCanonicalReleasePackageManifest(manifest, { releaseType: type });
    const blockers = validation.issues.map(issue => issue.message);
    return {
      exists: true,
      ready: validation.ready,
      path: releasePackagePath(type, releaseId),
      manifestPath,
      blockers,
      summary: validation.summary,
      validation,
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
      summary: ready ? 'Canonical package is valid.' : 'Canonical package manifest is missing.',
      validation: validateCanonicalReleasePackageManifest(null, { releaseType: type }),
      manifest: null,
    };
  }
  return {
    exists: false,
    ready: false,
    path: releasePackagePath(type, releaseId),
    manifestPath,
    blockers: ['Canonical album release package has not been built'],
    summary: 'Canonical package manifest is missing.',
    validation: validateCanonicalReleasePackageManifest(null, { releaseType: type }),
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

  const canonicalDistroKidUploadPayload = {
    release_type: 'album',
    artist: first.artist || brandProfile.distribution?.default_artist || brandProfile.brand_name || 'Pancake Robot',
    release_title: vm.title,
    release_date: vm.releaseDate,
    primary_genre: first.primary_genre || brandProfile.distribution?.primary_genre || null,
    secondary_genre: first.secondary_genre || null,
    cover_art: albumCover,
    tracks: trackManifests.map(track => ({
      song_id: track.song_id,
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
    song_id: undefined,
    album_id: vm.id,
    release_id: vm.id,
    release_type: 'album',
    brand_profile_id: profileId,
    release_title: vm.title,
    track_title: undefined,
    audio_file: undefined,
    cover_art: albumCover,
    lyrics_file: undefined,
    track_number: undefined,
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
  };
  manifest.field_sources = {
    ...(manifest.field_sources || {}),
    album_id: 'derived',
    release_id: 'derived',
    cover_art: albumCover ? 'release_assets' : 'missing',
  };
  delete manifest.field_sources.song_id;
  delete manifest.field_sources.audio_file;
  delete manifest.field_sources.track_title;

  const validation = validateCanonicalReleasePackageManifest(manifest, { releaseType: 'album' });
  manifest.readiness = {
    ready_for_distrokid_dry_run: validation.ready,
    blocking_missing_fields: validation.blocking_missing_fields,
    track_count: trackManifests.length,
    ordered_tracks: trackManifests.map(track => track.song_id),
    validation_summary: validation.summary,
  };

  fs.writeFileSync(path.join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(packageDir, 'missing-fields.json'), `${JSON.stringify({
    blocking_missing_fields: validation.blocking_missing_fields,
    warning_missing_fields: [],
    all_missing_fields: validation.blocking_missing_fields,
  }, null, 2)}\n`, 'utf8');
  for (const track of vm.tracks) {
    markDistroKidJobStatus(track.id, validation.ready ? DISTROKID_JOB_STATUSES.PACKAGE_BUILT : DISTROKID_JOB_STATUSES.BLOCKED_MISSING_FIELDS, {
      package_path: releasePackagePath('album', vm.id),
      latest_error_json: validation.blocking_missing_fields.length ? { blocking_missing_fields: validation.blocking_missing_fields } : null,
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
    approve_live_submit: 'Live submit approval',
    live_submit: 'Live submit',
    hyperfollow: 'HyperFollow',
    outreach: 'Outreach',
  }[action] || action;
}

function disabledReasonForAction(key, { blockers, packageState, lifecycle, liveSubmitApproval, cockpit }) {
  if (key === 'package' && blockers.length) return `Blocked: ${blockers.join(', ')}`;
  if (key === 'release_assets' && blockers.length && !blockers.every(blocker => /Primary release image|Platform derivatives/i.test(blocker))) return 'Blocked: fix metadata or audio before refreshing release assets only if asset problems remain.';
  if (key === 'preview' && blockers.length) return `Blocked: ${blockers.join(', ')}`;
  if (key === 'preview' && !packageState.ready) return `Blocked: ${packageState.blockers.join(', ')}`;
  if (key === 'approve_live_submit') {
    const previewBlockers = getPreviewApprovalBlockers(cockpit);
    if (previewBlockers.length) return `Blocked: ${previewBlockers.join(', ')}`;
  }
  if (key === 'live_submit' && blockers.length) return `Blocked: ${blockers.join(', ')}`;
  if (key === 'live_submit') {
    const previewBlockers = getPreviewApprovalBlockers(cockpit);
    if (previewBlockers.length) return `Blocked: ${previewBlockers.join(', ')}`;
  }
  if (key === 'live_submit' && !liveSubmitApproval?.approved) return 'Blocked: explicit human approval is required';
  if (key === 'hyperfollow' && !isAtLeastLifecycle(lifecycle.current, 'submitted_to_distrokid')) return 'Blocked: requires submitted_to_distrokid';
  if (key === 'browsy_dry_run') return 'Blocked: no ready Browsy task is available.';
  return '';
}

function summarizeLiveSubmitApproval(magicRelease) {
  const task = magicRelease?.tasks?.find(item => item.task_key === 'distrokid_final_submit_approval') || null;
  return {
    taskKey: 'distrokid_final_submit_approval',
    approved: task?.status === 'complete',
    status: task?.status || 'not_started',
    reason: task?.reason || '',
    completedAt: task?.completed_at || null,
  };
}

function buildTrackTable({ type, release, tracks }) {
  return {
    focusOptions: ['all', 'metadata', 'audio'],
    rows: tracks.map(track => {
      const hasMetadata = Boolean(track.fsAssets.metadata || track.metadata_path);
      const hasAnyAudio = Boolean(track.releaseAudio?.selected || (track.fsAssets.audioFiles || []).length);
      const needsAudioSelection = Boolean(track.releaseAudio?.requiresSelection);
      const affected = {
        metadata: !hasMetadata,
        audio: !hasAnyAudio || needsAudioSelection,
      };
      const canRemove = type === 'album';
      const costKnown = track.finance?.event_count > 0 || Number(track.total_cost_usd || 0) > 0;
      return {
        ...track,
        affected,
        metadataStatus: {
          status: hasMetadata ? 'complete' : 'blocked',
          label: hasMetadata ? 'complete' : 'blocked',
        },
        audioStatus: {
          status: needsAudioSelection ? 'needs_attention' : (hasAnyAudio ? 'complete' : 'blocked'),
          label: needsAudioSelection
            ? `choose master (${track.releaseAudio?.candidates?.length || 0})`
            : (track.releaseAudio?.selected ? 'master selected' : (hasAnyAudio ? 'available' : 'missing')),
          fileName: track.releaseAudio?.selected?.name || track.releaseAudio?.selected?.relativePath || null,
        },
        costDisplay: costKnown ? formatUsd(track.finance?.total_cost_usd ?? track.total_cost_usd ?? 0) : '—',
        lifecycleLabel: String(track.status || 'draft'),
        actions: {
          openSong: `/songs/${encodeURIComponent(track.id)}`,
          fixMetadata: `/songs/${encodeURIComponent(track.id)}?tab=meta`,
          generateMetadata: `/releases/${type}/${encodeURIComponent(release.id)}/tracks/${encodeURIComponent(track.id)}/metadata/generate`,
          chooseMaster: `/songs/${encodeURIComponent(track.id)}/release-audio?return_to=${encodeURIComponent(`/releases/${type}/${encodeURIComponent(release.id)}`)}`,
          generateMaster: `/songs/${encodeURIComponent(track.id)}/generate`,
          removeTrack: canRemove ? `/releases/${type}/${encodeURIComponent(release.id)}/tracks/${encodeURIComponent(track.id)}/remove` : null,
        },
      };
    }),
  };
}

function buildCommandCenter({ type, release, stages, nextActions, magicRelease, liveSubmitApproval, packageState, hyperfollow }) {
  const findAction = key => nextActions.find(action => action.key === key) || null;
  const nextAutomatableAction = [
    findAction('release_assets'),
    findAction('package'),
    findAction('preview'),
    findAction('approve_live_submit'),
    findAction('live_submit'),
    findAction('hyperfollow'),
    findAction('outreach'),
  ].find(action => action?.enabled);
  const stepActions = [
    findAction('preview'),
    findAction('approve_live_submit'),
    findAction('live_submit'),
    findAction('hyperfollow'),
    findAction('outreach'),
  ].filter(Boolean).filter(action => action.enabled || action.key === 'approve_live_submit');
  return {
    title: 'Magic Release',
    primaryActions: [
      magicRelease ? { key: 'start_full_magic_release', label: 'Start full Magic Release', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/magic-release/run-next`, enabled: true } : { key: 'start_full_magic_release', label: 'Start full Magic Release', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/magic-release/create`, enabled: true },
      nextAutomatableAction ? { ...nextAutomatableAction, label: 'Run next fixable step' } : { key: 'run_next_fixable', label: 'Run next fixable step', enabled: false, disabledReason: 'No fixable step is runnable yet.' },
      findAction('readiness'),
      findAction('plan'),
      findAction('browsy_dry_run')?.enabled ? findAction('browsy_dry_run') : null,
    ].filter(Boolean),
    stepActions: [],
  };
}

function summarizeCockpitBlockers({ type, release, stages, blockers }) {
  const actionableStages = stages.filter(stage => ['blocked', 'failed', 'ready', 'running', 'not_started'].includes(stage.status) && stage.issues.length);
  const primary = actionableStages[0] || null;
  return {
    count: blockers.length,
    category: primary?.label || 'Release blockers',
    headline: blockers.length ? `${blockers.length} blocking issue${blockers.length === 1 ? '' : 's'} need attention` : 'No blocking issues',
    issues: actionableStages.slice(0, 4).map(stage => ({
      key: stage.key,
      label: stage.label,
      count: stage.blockerCount || stage.issues.length,
      url: `/releases/${type}/${encodeURIComponent(release.id)}${stage.key === 'metadata' || stage.key === 'audio' ? `?focus=${stage.key}#tracks` : ''}`,
      actions: stage.actions,
    })),
  };
}

function humanizeCockpitStatus(status) {
  return String(status || 'not_started').replace(/_/g, ' ');
}

function buildRunHistory(logs = []) {
  const records = [];
  const seen = new Map();
  for (const log of logs) {
    const runId = String(log.payload?.runId || '').trim();
    const key = `${log.action}:${runId || log.id}`;
    const normalizedStatus = normalizeRunStatus(log.status);
    let record = seen.get(key);
    if (!record) {
      record = {
        key,
        runId: runId || log.id,
        action: log.action,
        status: normalizedStatus,
        startedAt: normalizedStatus === 'running' ? log.created_at : null,
        finishedAt: isTerminalRunStatus(log.status) ? log.created_at : null,
        latestAt: log.created_at,
        message: log.message || '',
        error: extractRunError(log),
        command: log.payload?.command || log.payload?.commandLine || '',
        script: log.payload?.script || '',
        logPath: extractRunLogPath(log),
        outputPath: log.payload?.outputPath || '',
        logUrl: toOutputMediaUrl(extractRunLogPath(log)),
        payload: log.payload || {},
      };
      seen.set(key, record);
      records.push(record);
    } else if (shouldReplaceRunRecord(record, log, normalizedStatus)) {
      record.status = normalizedStatus;
      record.latestAt = log.created_at;
      record.finishedAt = isTerminalRunStatus(log.status) ? log.created_at : record.finishedAt;
      record.message = log.message || record.message;
      record.error = extractRunError(log) || record.error;
      record.command = log.payload?.command || log.payload?.commandLine || record.command;
      record.script = log.payload?.script || record.script;
      record.logPath = extractRunLogPath(log) || record.logPath;
      record.logUrl = toOutputMediaUrl(record.logPath);
      record.payload = log.payload || record.payload;
    }
    if (normalizedStatus === 'running') {
      record.startedAt = log.created_at;
      if (!record.command) record.command = log.payload?.command || log.payload?.commandLine || '';
      if (!record.script) record.script = log.payload?.script || '';
      if (!record.logPath) {
        record.logPath = extractRunLogPath(log);
        record.logUrl = toOutputMediaUrl(record.logPath);
      }
    }
  }
  return records
    .map(enrichRunRecord)
    .sort((a, b) => String(b.latestAt || '').localeCompare(String(a.latestAt || '')));
}

function findLatestRun(runHistory = [], action) {
  return runHistory.find(run => run.action === action) || null;
}

function normalizeRunStatus(status) {
  if (status === 'success') return 'complete';
  if (status === 'warning') return 'failed';
  if (status === 'pending') return 'running';
  return String(status || 'not_started');
}

function enrichRunRecord(record) {
  const diagnostics = loadRunDiagnostics(record.logPath);
  const status = coerceRunStatusFromDiagnostics(record.status, diagnostics.runLog);
  return {
    ...record,
    status,
    diagnostics,
    processStatus: status,
    processStatusLabel: humanizeProcessStatus(status),
    displayStatus: humanizeRunDisplayStatus({ ...record, status, diagnostics }),
  };
}

function humanizeProcessStatus(status) {
  if (status === 'complete') return 'process complete';
  return humanizeCockpitStatus(status);
}

function humanizeRunDisplayStatus(record) {
  if (record.action === 'distrokid_preview') {
    const outcome = assessPreviewRun({
      run: { ...record, diagnostics: record.diagnostics },
      releaseType: record.payload?.entityType,
      releaseId: record.payload?.releaseId,
      packageState: { ready: true, summary: '' },
    }).outcomeLabel;
    if (record.status === 'complete') return `process complete${outcome ? ` · ${outcome}` : ''}`;
  }
  return humanizeProcessStatus(record.status);
}

function isTerminalRunStatus(status) {
  return ['complete', 'failed', 'blocked', 'cancelled', 'skipped', 'success', 'warning'].includes(String(status || ''));
}

function extractRunError(log) {
  return log.payload?.error
    || log.payload?.latest_error
    || log.payload?.latestError
    || log.payload?.result?.error
    || (/failed|blocked/i.test(String(log.status || '')) ? log.message : '');
}

function extractRunLogPath(log) {
  return log.payload?.logPath
    || log.payload?.latest_run_log_path
    || log.payload?.latestRunLogPath
    || log.payload?.job?.latest_run_log_path
    || '';
}

function loadRunDiagnostics(logPath) {
  const resolved = resolveOutputPath(logPath);
  if (!resolved) return { runLog: null, errors: [], skippedFields: [], artifacts: [] };
  const runLog = readJsonIfExists(resolved);
  const runDir = path.dirname(resolved);
  return {
    runLog,
    errors: readJsonIfExists(path.join(runDir, 'errors.json')) || [],
    skippedFields: readJsonIfExists(path.join(runDir, 'skipped-fields.json')) || runLog?.diagnostics?.skipped_fields || [],
    artifacts: collectRunArtifacts(runDir),
  };
}

function resolveOutputPath(filePath) {
  const value = String(filePath || '').trim();
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
}

function toOutputMediaUrl(filePath) {
  const relativePath = String(filePath || '').trim().replace(/^output\//, '');
  return relativePath ? `/media/${relativePath}` : '';
}

function collectRunArtifacts(runDir) {
  const files = [
    ['Final review screenshot', 'screenshot-final-review.png'],
    ['After fill screenshot', 'screenshot-after-fill.png'],
    ['Errors JSON', 'errors.json'],
    ['Filled fields JSON', 'filled-fields.json'],
    ['Skipped fields JSON', 'skipped-fields.json'],
    ['Run log JSON', 'run-log.json'],
    ['HTML snapshot', 'html-snapshot.html'],
    ['Page text snapshot', 'page-text-snapshot.txt'],
  ];
  return files
    .map(([label, filename]) => {
      const absolutePath = path.join(runDir, filename);
      if (!fs.existsSync(absolutePath)) return null;
      const relativePath = path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/');
      return {
        label,
        filename,
        path: relativePath,
        url: toOutputMediaUrl(relativePath),
      };
    })
    .filter(Boolean);
}

function coerceRunStatusFromDiagnostics(status, runLog) {
  if (status !== 'running' || !runLog?.finished_at) return status;
  if (runLog.final_status) return normalizeRunStatus(runLog.final_status);
  if (Number(runLog.error_count || 0) > 0) return 'failed';
  return 'complete';
}

function shouldReplaceRunRecord(record, log, normalizedStatus) {
  if (String(log.created_at || '') > String(record.latestAt || '')) return true;
  return runStatusRank(normalizedStatus) > runStatusRank(record.status);
}

function runStatusRank(status) {
  return {
    failed: 5,
    complete: 4,
    blocked: 3,
    cancelled: 2,
    skipped: 2,
    running: 1,
    ready: 0,
    not_started: 0,
  }[String(status || 'not_started')] ?? 0;
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `$${amount.toFixed(4)}`;
}

function assessPreviewRun({ run, releaseType, releaseId, packageState }) {
  const empty = {
    outcome: run ? 'needs_review' : null,
    outcomeLabel: run ? 'needs review' : null,
    summary: run?.status === 'running'
      ? 'DistroKid preview is still running.'
      : run?.status === 'blocked'
        ? (run.error || run.message || 'DistroKid preview is blocked.')
        : run?.status === 'failed'
          ? (run.error || run.message || 'DistroKid preview failed.')
          : (packageState.ready ? 'Ready to run the DistroKid preview automation.' : packageState.summary),
    diagnostics: null,
  };
  if (!run) return empty;
  const runLog = run.diagnostics?.runLog || null;
  const diagnostics = summarizeDistroKidDiagnostics(run);
  if (run.status === 'running') {
    return { outcome: 'needs_review', outcomeLabel: 'needs review', summary: 'DistroKid preview is still running.', diagnostics };
  }
  if (run.status === 'blocked') {
    return { outcome: 'failed', outcomeLabel: 'failed', summary: run.error || run.message || 'DistroKid preview is blocked.', diagnostics };
  }
  if (run.status === 'failed') {
    return { outcome: 'failed', outcomeLabel: 'failed', summary: run.error || run.message || 'DistroKid preview failed.', diagnostics };
  }
  if (!runLog) {
    return { outcome: 'needs_review', outcomeLabel: 'needs review', summary: 'DistroKid preview process completed, but diagnostics were not found.', diagnostics };
  }
  const sameRelease = previewRunMatchesRelease(runLog, releaseType, releaseId);
  const filledCount = Number(runLog.filled_count || 0);
  const skippedCount = Number(runLog.skipped_count || 0);
  const errorCount = Number(runLog.error_count || 0);
  const previewPassed = sameRelease
    && runLog.dry_run === true
    && runLog.stopped_before_submit === true
    && filledCount > 0
    && errorCount === 0
    && diagnostics.requiredMissingCount === 0;
  if (previewPassed) {
    return {
      outcome: 'passed',
      outcomeLabel: 'passed',
      summary: `DistroKid preview passed. ${filledCount} field${filledCount === 1 ? '' : 's'} filled. ${errorCount} errors. ${skippedCount} skipped.`,
      diagnostics,
    };
  }
  const missingSentence = diagnostics.requiredMissingCount > 0 ? ' Required DistroKid controls/files were not found.' : '';
  const baseSummary = `DistroKid preview completed, but did not stage the release. ${filledCount} fields filled. ${errorCount} errors. ${skippedCount} skipped.${missingSentence}`;
  if (!sameRelease || runLog.dry_run !== true || runLog.stopped_before_submit !== true) {
    return {
      outcome: 'needs_review',
      outcomeLabel: 'needs review',
      summary: baseSummary,
      diagnostics,
    };
  }
  return {
    outcome: errorCount > 0 ? 'failed' : 'incomplete',
    outcomeLabel: errorCount > 0 ? 'failed' : 'incomplete',
    summary: baseSummary,
    diagnostics,
  };
}

function summarizeDistroKidDiagnostics(run) {
  const runLog = run?.diagnostics?.runLog || null;
  if (!runLog) return null;
  const grouped = groupDistroKidMissingFields(run);
  const requiredMissingCount = grouped.reduce((sum, group) => sum + group.items.length, 0);
  const trackCountValidation = runLog?.diagnostics?.track_count_validation || null;
  return {
    filledCount: Number(runLog.filled_count || 0),
    skippedCount: Number(runLog.skipped_count || 0),
    errorCount: Number(runLog.error_count || 0),
    requiredMissingCount,
    missingGroups: grouped,
    artifacts: run?.diagnostics?.artifacts || [],
    trackCountValidation: trackCountValidation ? {
      requestedTrackCount: Number(trackCountValidation.requestedTrackCount || 0) || 0,
      selectedOption: trackCountValidation.selectedOption || '',
      renderedTrackCount: Number(trackCountValidation.renderedTrackCount || 0) || 0,
      ok: trackCountValidation.ok === true,
    } : null,
  };
}

function groupDistroKidMissingFields(run) {
  const source = [
    ...(Array.isArray(run?.diagnostics?.errors) ? run.diagnostics.errors : []),
    ...(Array.isArray(run?.diagnostics?.skippedFields) ? run.diagnostics.skippedFields : []),
  ];
  const grouped = new Map(DISTROKID_DIAGNOSTIC_CATEGORY_ORDER.map(key => [key, new Map()]));
  for (const item of source) {
    const classification = classifyDistroKidFieldIssue(item);
    if (!classification.required) continue;
    const bucket = grouped.get(classification.category);
    if (!bucket) continue;
    bucket.set(classification.key, classification.label);
  }
  return DISTROKID_DIAGNOSTIC_CATEGORY_ORDER.map(key => ({
    key,
    label: DISTROKID_DIAGNOSTIC_CATEGORY_LABELS[key],
    items: [...(grouped.get(key)?.values() || [])],
  })).filter(group => group.items.length);
}

function classifyDistroKidFieldIssue(item = {}) {
  const field = String(item.field || '').trim();
  const message = String(item.error || item.reason || '').trim();
  const label = humanizeDistroKidIssueLabel(field, message);
  const required = /not found|missing/i.test(message);
  if (/cover_art|artwork|cover/i.test(field) || /cover art|artwork/i.test(message)) {
    return { category: 'artwork', key: field || label, label, required };
  }
  if (/audio_file/i.test(field) || /file input not found/i.test(message)) {
    return { category: 'audio_uploads', key: field || label, label, required };
  }
  if (/track_title/i.test(field) || /track \d+ title/i.test(message)) {
    return { category: 'tracks', key: field || label, label, required };
  }
  if (/ai/i.test(field) || /ai/i.test(message)) {
    return { category: 'ai_disclosure', key: field || label, label, required };
  }
  if (/explicit|clean|radio|instrumental|not_explicit|explicit_lyrics/i.test(field)) {
    return { category: 'certifications', key: field || label, label, required };
  }
  if (/genre|language|original|release|artist|album/i.test(field) || /genre|language|original song|album|artist/i.test(message)) {
    return { category: 'album_metadata', key: field || label, label, required };
  }
  return { category: 'certifications', key: field || label, label, required: false };
}

function humanizeDistroKidIssueLabel(field, message) {
  if (/^cover_art$/i.test(field)) return 'Cover art upload';
  const trackTitleMatch = field.match(/^track_title_track_(\d+)$/i);
  if (trackTitleMatch) return `Track ${trackTitleMatch[1]} title`;
  const audioMatch = field.match(/^audio_file_track_(\d+)$/i);
  if (audioMatch) return `Track ${audioMatch[1]} audio upload`;
  const explicitMatch = field.match(/^not_explicit_track_(\d+)$/i);
  if (explicitMatch) return `Track ${explicitMatch[1]} not explicit certification`;
  if (/^language$/i.test(field)) return 'Language';
  if (/^primary_genre$/i.test(field)) return 'Primary genre';
  if (/^original_song$/i.test(field)) return 'Original song';
  if (/^ai_generated_gate$/i.test(field)) return 'AI disclosure';
  return message || field || 'Missing required DistroKid control';
}

function previewRunMatchesRelease(runLog, releaseType, releaseId) {
  const release = String(releaseId || '').trim();
  const manifestPath = String(runLog?.manifest_path || '');
  const manifestMatch = manifestPath.includes(`output/release-packages/${release}/manifest.json`);
  if (String(releaseType || '') === 'album') {
    return String(runLog?.release_id || '').trim() === release && manifestMatch;
  }
  return (String(runLog?.song_id || '').trim() === release || String(runLog?.release_id || '').trim() === release) && manifestMatch;
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
