import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import {
  getAlbum,
  getReleaseLinks,
  getSong,
  getSongsForAlbum,
  upsertReleaseLink,
  upsertSong,
} from './db.js';
import { saveSongMarketingKit } from './song-marketing-kit.js';
import { markSongSubmittedToDistroKid } from './distrokid-release.js';
import {
  DISTROKID_JOB_STATUSES,
  getDistroKidJob,
  markDistroKidJobStatus,
} from './distrokid-jobs.js';
import {
  buildReleasePackageForCockpit,
  getCanonicalReleaseManifestPath,
} from './release-cockpit.js';
import { DISTROKID_AUTH_PATH, hasDistrokidCookies } from '../../scripts/distrokid/lib.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGE_ROOT = join(REPO_ROOT, 'output', 'release-packages');
const AUTOMATION_TIMEOUT_MS = 20 * 60 * 1000;

export function hasConfirmedDistroKidAuth() {
  try {
    if (!existsSync(DISTROKID_AUTH_PATH)) return false;
    const auth = JSON.parse(readFileSync(DISTROKID_AUTH_PATH, 'utf8'));
    return hasDistrokidCookies(auth);
  } catch {
    return false;
  }
}

export function buildDistroKidUploadInvocation({ manifestPath, mode = 'preview', interactivePreview = false, authConfirmed = hasConfirmedDistroKidAuth() } = {}) {
  const resolvedMode = mode === 'live' ? 'live' : 'preview';
  const args = [
    join(REPO_ROOT, 'scripts/distrokid/upload-release.mjs'),
    '--manifest',
    manifestPath,
  ];
  if (!(interactivePreview && !authConfirmed && resolvedMode === 'preview')) args.push('--no-pause');
  if (resolvedMode === 'live') args.push('--live-submit', '--confirm-live-submit');
  else args.push('--dry-run');
  return {
    args,
    authConfirmed,
    interactivePreview,
    command: `${process.execPath} ${args.map(arg => String(arg).includes(' ') ? JSON.stringify(arg) : arg).join(' ')}`,
  };
}

export async function runDistroKidSongAutomation(songId, options = {}) {
  const mode = options.mode === 'live' ? 'live' : 'preview';
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  if (mode === 'live' && options.confirm !== true) {
    throw new Error('Live DistroKid submit requires explicit confirmation.');
  }

  const log = [];
  const append = message => log.push({ at: new Date().toISOString(), message });
  append(`Starting ${mode} automation for ${songId}`);

  if (process.env.PANCAKE_DISTROKID_AUTOMATION_STUB === '1') {
    return runStubSongAutomation(songId, { mode, append, log, options });
  }

  await buildSongPackage(songId);
  append('Package built or refreshed');

  const manifestPath = join(PACKAGE_ROOT, songId, 'manifest.json');
  const manifest = readJsonIfExists(manifestPath);
  const blocking = manifest?.readiness?.blocking_missing_fields || [];
  if (!manifest?.readiness?.ready_for_distrokid_dry_run) {
    markDistroKidJobStatus(songId, DISTROKID_JOB_STATUSES.BLOCKED_MISSING_FIELDS, {
      package_path: relativePackagePath(songId),
      latest_error_json: { blocking_missing_fields: blocking },
    });
    throw new Error(`DistroKid package is blocked: ${blocking.join(', ') || 'unknown readiness failure'}`);
  }

  const uploadArgs = buildDistroKidUploadInvocation({ manifestPath, mode }).args;

  append(mode === 'live' ? 'Running Playwright upload and live submit' : 'Running Playwright preview upload');
  const upload = await execNode(uploadArgs).catch(error => {
    throw enrichAutomationError(songId, error);
  });
  append(trimOutput(upload.stdout) || 'Playwright upload finished');

  const job = getDistroKidJob(songId);
  const capturedReleaseUrl = extractFirstUrl(`${upload.stdout}\n${upload.stderr}`) || job?.distrokid_url || null;
  let submitResult = null;
  let hyperfollow = null;
  if (mode === 'live') {
    submitResult = markSongSubmittedToDistroKid(songId, {
      distrokid_url: capturedReleaseUrl || '',
      submitted_at: new Date().toISOString(),
      notes: 'Submitted by Figment Factory DistroKid automation.',
    });
    append('Release status updated to submitted to DistroKid');
    hyperfollow = await captureHyperFollowLink(songId, { releaseUrl: capturedReleaseUrl, append });
  }

  return finishAutomationResult(songId, {
    ok: true,
    mode,
    log,
    job: getDistroKidJob(songId),
    releaseUrl: capturedReleaseUrl,
    hyperfollow,
    submitResult,
  });
}

export async function runDistroKidAlbumAutomation(albumId, options = {}) {
  const mode = options.mode === 'live' ? 'live' : 'preview';
  const album = getAlbum(albumId);
  if (!album) throw new Error(`Album not found: ${albumId}`);
  if (mode === 'live' && options.confirm !== true) {
    throw new Error('Live DistroKid submit requires explicit confirmation.');
  }
  const tracks = getSongsForAlbum(albumId);
  if (!tracks.length) throw new Error(`Album has no tracks: ${albumId}`);

  const log = [];
  const append = message => log.push({ at: new Date().toISOString(), message });
  append(`Starting ${mode} album automation for ${albumId}`);

  if (process.env.PANCAKE_DISTROKID_AUTOMATION_STUB === '1') {
    return runStubAlbumAutomation(album, tracks, { mode, append, log, options });
  }

  const packageResult = await buildReleasePackageForCockpit('album', albumId);
  const albumManifestPath = getCanonicalReleaseManifestPath('album', albumId);
  append(`Canonical album package ready: ${packageResult.manifestPath || albumManifestPath}`);

  const uploadArgs = buildDistroKidUploadInvocation({ manifestPath: albumManifestPath, mode }).args;

  const upload = await execNode(uploadArgs).catch(error => {
    throw enrichAutomationError(albumId, error);
  });
  append(trimOutput(upload.stdout) || 'Album Playwright upload finished');

  const capturedReleaseUrl = extractFirstUrl(`${upload.stdout}\n${upload.stderr}`);
  let hyperfollow = null;
  if (mode === 'live') {
    for (const track of tracks) {
      markSongSubmittedToDistroKid(track.id, {
        distrokid_url: capturedReleaseUrl || '',
        submitted_at: new Date().toISOString(),
        notes: `Submitted as part of album ${album.album_title || album.id}.`,
      });
    }
    append(`Updated ${tracks.length} track statuses to submitted to DistroKid`);
    hyperfollow = await captureHyperFollowForMany(tracks.map(track => track.id), { releaseUrl: capturedReleaseUrl, append });
  }

  return {
    ok: true,
    mode,
    entityType: 'album',
    albumId,
    trackCount: tracks.length,
    releaseUrl: capturedReleaseUrl,
    hyperfollow,
    latest_run_log_path: `output/release-packages/${albumId}/distrokid-run/run-log.json`,
    log,
  };
}

export async function captureHyperFollowLink(songId, options = {}) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  const existing = getReleaseLinks(songId).find(link => /hyperfollow/i.test(link.platform || '') || /hyperfollow/i.test(link.url || ''));
  if (existing?.url) return saveHyperFollow(songId, existing.url, options.append);

  const candidate = String(options.hyperfollowUrl || process.env.PANCAKE_DISTROKID_HYPERFOLLOW_URL || '').trim();
  if (candidate && /hyperfollow|distrokid\.com\/hyperfollow/i.test(candidate)) {
    return saveHyperFollow(songId, candidate, options.append);
  }

  markDistroKidJobStatus(songId, DISTROKID_JOB_STATUSES.SUBMITTED_PENDING_HYPERFOLLOW, {
    latest_error_json: { message: 'Submitted, HyperFollow link not available yet.' },
  });
  options.append?.('HyperFollow link is not available yet');
  return { status: 'submitted_pending_hyperfollow', url: null };
}

async function captureHyperFollowForMany(songIds, options = {}) {
  const results = [];
  for (const songId of songIds) results.push(await captureHyperFollowLink(songId, options));
  return results.find(result => result.url) || results[0] || { status: 'submitted_pending_hyperfollow', url: null };
}

function saveHyperFollow(songId, url, append) {
  upsertReleaseLink(songId, 'HyperFollow', url);
  saveSongMarketingKit(songId, { marketing_links: { smart_link: url } });
  markDistroKidJobStatus(songId, DISTROKID_JOB_STATUSES.SUBMITTED, {
    latest_error_json: null,
  });
  append?.('HyperFollow link saved');
  return { status: 'captured', url };
}

async function buildSongPackage(songId) {
  await execNode([
    join(REPO_ROOT, 'scripts/distrokid/build-release-package.mjs'),
    '--song-id',
    songId,
  ]);
}

async function runStubSongAutomation(songId, { mode, append, log, options }) {
  writeStubRunArtifacts(songId, { mode });
  markDistroKidJobStatus(songId, DISTROKID_JOB_STATUSES.PACKAGE_BUILT, {
    package_path: relativePackagePath(songId),
    latest_run_log_path: `output/release-packages/${songId}/distrokid-run/run-log.json`,
    latest_error_json: null,
  });
  append('Package built or refreshed');
  append(mode === 'live' ? 'Stub live Playwright submit completed' : 'Stub preview Playwright upload completed without submitting');
  let submitResult = null;
  let hyperfollow = null;
  if (mode === 'live') {
    submitResult = markSongSubmittedToDistroKid(songId, {
      distrokid_url: options.releaseUrl || 'https://distrokid.com/release/stub',
      submitted_at: new Date().toISOString(),
      notes: 'Submitted by Figment Factory DistroKid automation test stub.',
    });
    hyperfollow = await captureHyperFollowLink(songId, { hyperfollowUrl: options.hyperfollowUrl, append });
  }
  return finishAutomationResult(songId, {
    ok: true,
    mode,
    log,
    job: getDistroKidJob(songId),
    releaseUrl: options.releaseUrl || null,
    hyperfollow,
    submitResult,
  });
}

function runStubAlbumAutomation(album, tracks, { mode, append, log, options }) {
  writeStubRunArtifacts(album.id, { mode, releaseId: album.id, songId: null });
  append(`Album-level fields filled once for ${album.album_title || album.id}`);
  for (const track of tracks) append(`Track ${track.track_number || '?'} filled from package metadata: ${track.id}`);
  if (mode === 'live') {
    for (const track of tracks) {
      markSongSubmittedToDistroKid(track.id, {
        distrokid_url: options.releaseUrl || 'https://distrokid.com/release/stub-album',
        submitted_at: new Date().toISOString(),
        notes: `Submitted as part of album ${album.album_title || album.id}.`,
      });
      if (options.hyperfollowUrl) saveHyperFollow(track.id, options.hyperfollowUrl, append);
    }
  }
  return {
    ok: true,
    mode,
    entityType: 'album',
    albumId: album.id,
    trackCount: tracks.length,
    releaseUrl: options.releaseUrl || null,
    hyperfollow: options.hyperfollowUrl ? { status: 'captured', url: options.hyperfollowUrl } : { status: 'submitted_pending_hyperfollow', url: null },
    latest_run_log_path: `output/release-packages/${album.id}/distrokid-run/run-log.json`,
    log,
  };
}

function finishAutomationResult(songId, result) {
  return {
    entityType: 'single',
    songId,
    ...result,
    log: result.log?.length ? result.log : readRecentRunLogSummary(songId),
  };
}

function readRecentRunLogSummary(songId) {
  const logPath = join(PACKAGE_ROOT, songId, 'distrokid-run', 'run-log.json');
  const log = readJsonIfExists(logPath);
  if (!log) return [];
  return [
    { at: log.started_at, message: `Started ${log.dry_run ? 'preview' : 'live'} automation` },
    { at: log.finished_at, message: `Filled ${log.filled_count || 0}, skipped ${log.skipped_count || 0}, errors ${log.error_count || 0}` },
  ].filter(item => item.at);
}

function execNode(args) {
  return execFileAsync(process.execPath, args, {
    cwd: REPO_ROOT,
    timeout: AUTOMATION_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 8,
  });
}

function readJsonIfExists(filePath) {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

function relativePackagePath(songId) {
  return `output/release-packages/${songId}`;
}

function trimOutput(value) {
  return String(value || '').trim().split('\n').slice(-5).join('\n');
}

function extractFirstUrl(value) {
  return String(value || '').match(/https?:\/\/[^\s"'<>]+/i)?.[0] || null;
}

function enrichAutomationError(releaseId, error) {
  const runDir = join(PACKAGE_ROOT, releaseId, 'distrokid-run');
  const runLogPath = join(runDir, 'run-log.json');
  const errorsPath = join(runDir, 'errors.json');
  const runLog = readJsonIfExists(runLogPath);
  const errors = readJsonIfExists(errorsPath);
  const details = Array.isArray(errors)
    ? errors.map(item => item?.error || item?.message || '').filter(Boolean)
    : [];
  const detailText = details.length ? ` ${details.join('; ')}` : '';
  const enriched = new Error(`${error.message || 'DistroKid automation failed.'}${detailText}`.trim());
  enriched.runLogPath = existsSync(runLogPath) ? `output/release-packages/${releaseId}/distrokid-run/run-log.json` : null;
  enriched.runLog = runLog || null;
  enriched.details = details;
  return enriched;
}

function writeStubRunArtifacts(releaseId, { mode, releaseId: explicitReleaseId = releaseId, songId = releaseId } = {}) {
  const runDir = join(PACKAGE_ROOT, releaseId, 'distrokid-run');
  mkdirSync(runDir, { recursive: true });
  const dryRun = mode !== 'live';
  const startedAt = new Date().toISOString();
  const runLog = {
    song_id: songId,
    release_id: explicitReleaseId,
    manifest_path: `output/release-packages/${releaseId}/manifest.json`,
    dry_run: dryRun,
    stopped_before_submit: dryRun,
    started_at: startedAt,
    finished_at: startedAt,
    filled_count: dryRun ? 12 : 14,
    skipped_count: 0,
    error_count: 0,
  };
  writeFileSync(join(runDir, 'run-log.json'), `${JSON.stringify(runLog, null, 2)}\n`, 'utf8');
  writeFileSync(join(runDir, 'errors.json'), '[]\n', 'utf8');
  writeFileSync(join(runDir, 'skipped-fields.json'), '[]\n', 'utf8');
}
