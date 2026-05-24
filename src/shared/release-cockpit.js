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
import { getDistroKidJob } from './distrokid-jobs.js';
import { getReleaseAssetState } from './song-release-assets-service.js';
import { getMarketingCampaigns } from './marketing-db.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SONG_OUTPUT_ROOT = path.join(REPO_ROOT, 'output', 'songs');

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
    const vm = buildReleaseCockpitViewModel('album', album.id);
    return entryFromViewModel(vm);
  }).filter(Boolean);
  const singles = getAllSongs()
    .filter(song => !song.album_id)
    .map(song => {
      const vm = buildReleaseCockpitViewModel('single', song.id);
      return entryFromViewModel(vm);
    })
    .filter(Boolean);
  return [...albums, ...singles].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function buildReleaseCockpitViewModel(releaseType, releaseId) {
  const type = normalizeReleaseType(releaseType);
  const release = type === 'album' ? buildAlbumRelease(releaseId) : buildSingleRelease(releaseId);
  if (!release) return null;

  const tracks = release.tracks.map((track, index) => ({
    ...track,
    track_number: track.track_number || index + 1,
    fsAssets: scanSongOutput(track.id),
    links: getReleaseLinks(track.id),
    distrokidJob: getDistroKidJob(track.id),
  }));
  const assetState = getReleaseAssetState(type === 'album' ? 'album' : 'song', release.id);
  const campaigns = findReleaseCampaigns(tracks.map(track => track.id));
  const social = summarizeSocialPosts(tracks.map(track => track.id));
  const hyperfollow = findHyperFollow(tracks);
  const logs = getReleaseCockpitLogs(type, release.id, { limit: 50 });
  const stages = buildStages({ release, tracks, assetState, campaigns, social, hyperfollow });
  const blockers = stages.filter(stage => stage.blocksLiveSubmit && stage.status !== 'complete').flatMap(stage => stage.issues);
  const nextActions = buildNextActions({ type, release, stages, blockers, hyperfollow });

  return {
    type,
    id: release.id,
    title: release.title,
    subtitle: release.subtitle,
    releaseDate: release.releaseDate,
    brandProfileId: release.brandProfileId,
    canonicalMediaOwner: assetState.owner,
    tracks,
    stages,
    blockers,
    canLiveSubmit: blockers.length === 0,
    hyperfollow,
    campaigns,
    social,
    logs,
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
  if (!vm.canLiveSubmit) {
    throw new Error(`Live submit blocked: ${vm.blockers.join(', ')}`);
  }
  return vm;
}

export async function buildReleasePackageForCockpit(releaseType, releaseId) {
  const vm = buildReleaseCockpitViewModel(releaseType, releaseId);
  if (!vm) throw new Error('Release not found.');
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
  return { ok: true, releaseType: vm.type, releaseId: vm.id, trackCount: vm.tracks.length, results };
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

function buildStages({ release, tracks, assetState, campaigns, social, hyperfollow }) {
  const metadataIssues = [];
  if (!release.title) metadataIssues.push('Release title is missing');
  if (!release.releaseDate) metadataIssues.push('Release date is missing');
  for (const track of tracks) {
    if (!track.title && !track.topic) metadataIssues.push(`${track.id}: track title is missing`);
    if (!track.fsAssets.metadata && !track.metadata_path) metadataIssues.push(`${track.id}: metadata.json is missing`);
  }

  const audioIssues = tracks
    .filter(track => !(track.fsAssets.audioFiles || []).length)
    .map(track => `${track.id}: audio file is missing`);

  const mediaIssues = [];
  if (!assetState.primaryImage?.path) mediaIssues.push('Primary release image is missing');
  const missingDerivatives = (assetState.assets || []).filter(asset => !asset.publicUrl).map(asset => asset.label || asset.name);
  if (missingDerivatives.length) mediaIssues.push(`Platform derivatives missing: ${missingDerivatives.slice(0, 3).join(', ')}${missingDerivatives.length > 3 ? '...' : ''}`);

  const jobs = tracks.map(track => track.distrokidJob).filter(Boolean);
  const previewComplete = jobs.some(job => ['dry_run_ready', 'awaiting_manual_review', 'submitted', 'submitted_pending_hyperfollow', 'package_built'].includes(job.status));
  const liveComplete = tracks.every(track => ['submitted', 'submitted_pending_hyperfollow'].includes(track.distrokidJob?.status) || /submitted to distrokid/i.test(track.status || ''));
  const postLinks = tracks.flatMap(track => track.links || []).filter(link => !/hyperfollow/i.test(`${link.platform} ${link.url}`));

  return [
    stage('metadata', 'Metadata ready', metadataIssues.length ? 'blocked' : 'complete', metadataIssues, true),
    stage('audio', 'Audio present', audioIssues.length ? 'blocked' : 'complete', audioIssues, true),
    stage('media', release.tracks?.length > 1 ? 'Album media ready' : 'Single media ready', mediaIssues.length ? 'needs_action' : 'complete', mediaIssues, true),
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

function buildNextActions({ type, release, stages, blockers, hyperfollow }) {
  return [
    { key: 'readiness', label: 'Run readiness check', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/readiness`, enabled: true },
    { key: 'package', label: 'Build/rebuild release package', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/package`, enabled: true },
    { key: 'preview', label: 'Run DistroKid automation preview', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-preview`, enabled: true },
    { key: 'live_submit', label: 'Run DistroKid live submit', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/distrokid-live-submit`, enabled: blockers.length === 0, confirmation: 'Run the live DistroKid submit? This can submit externally.' },
    { key: 'hyperfollow', label: hyperfollow?.url ? 'Refresh HyperFollow URL' : 'Fetch/add HyperFollow URL', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/hyperfollow`, enabled: true },
    { key: 'outreach', label: 'Build outreach campaign', method: 'POST', url: `/releases/${type}/${encodeURIComponent(release.id)}/actions/outreach`, enabled: true },
    { key: 'byteseed', label: 'ByteSeed video publishing', enabled: false, placeholder: true },
    { key: 'meta_publish', label: 'Meta publishing', enabled: false, placeholder: true },
  ].map(action => ({
    ...action,
    disabledReason: action.key === 'live_submit' && blockers.length ? `Blocked: ${blockers.join(', ')}` : action.placeholder ? 'Placeholder: automation not implemented yet' : '',
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
    releaseDate: vm.releaseDate,
    stageSummary: `${vm.stages.filter(stage => stage.status === 'complete').length}/${vm.stages.length} complete`,
    blockerCount: vm.blockers.length,
    updatedAt: vm.updatedAt,
  };
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
