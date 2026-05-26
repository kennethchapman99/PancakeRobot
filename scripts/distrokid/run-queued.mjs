#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { join } from 'path';
import {
  DISTROKID_JOB_STATUSES,
  listQueuedDistroKidJobs,
  markDistroKidJobStatus,
} from '../../src/shared/distrokid-jobs.js';
import { getSong } from '../../src/shared/db.js';
import { SONG_STATUSES, normalizeSongStatus } from '../../src/shared/song-status.js';
import {
  DISTROKID_AUTH_PATH,
  REPO_ROOT,
  RELEASE_PACKAGES_DIR,
  ensureDir,
  exists,
  getReleasePackageDir,
  parseArgs,
  readJson,
  relativeToRepo,
  writeJson,
  writeText,
} from './lib.mjs';
import { BLOCKED_UPLOAD_VALIDATION_EXIT_CODE } from './upload-release-helpers.mjs';

const { values } = parseArgs({
  limit: { type: 'string', default: '5' },
  'dry-run': { type: 'boolean', default: true },
  'skip-upload': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
});

if (values.help) {
  console.error('Usage: npm run distrokid:run-queued -- --limit 5 --dry-run');
  process.exit(0);
}

const limit = Math.max(1, Math.min(Number(values.limit) || 5, 25));
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const batchRunDir = ensureDir(join(RELEASE_PACKAGES_DIR, 'batch-runs', timestamp));
const startedAt = new Date().toISOString();
const results = [];

const terminalSongStatuses = new Set([
  SONG_STATUSES.ARCHIVED,
  SONG_STATUSES.SUBMITTED_TO_DISTROKID,
  SONG_STATUSES.OUTREACH_COMPLETE,
]);

const jobs = listQueuedDistroKidJobs(100)
  .filter(job => job.status === DISTROKID_JOB_STATUSES.QUEUED)
  .filter(job => {
    const song = getSong(job.song_id);
    return song && !terminalSongStatuses.has(normalizeSongStatus(song.status));
  })
  .slice(0, limit);

console.log(`DistroKid queued dry-run: ${jobs.length} job(s), limit ${limit}`);
console.log('Safety: uploads run one at a time and never submit.');

if (!jobs.length) {
  writeReports();
  process.exit(0);
}

for (const job of jobs) {
  const result = {
    song_id: job.song_id,
    status: job.status,
    package_built: false,
    upload_run: false,
    skipped: false,
    error: null,
    blocking_fields: [],
    manifest_path: null,
  };
  results.push(result);

  try {
    console.log(`\n${job.song_id}`);
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'scripts/distrokid/build-release-package.mjs'),
      '--song-id',
      job.song_id,
    ], { cwd: REPO_ROOT, stdio: 'inherit' });
    result.package_built = true;

    const manifestPath = join(getReleasePackageDir(job.song_id), 'manifest.json');
    result.manifest_path = relativeToRepo(manifestPath);
    const manifest = readJson(manifestPath);
    result.blocking_fields = manifest.readiness?.blocking_missing_fields || [];
    if (!manifest.readiness?.ready_for_distrokid_dry_run) {
      result.skipped = true;
      result.status = DISTROKID_JOB_STATUSES.BLOCKED_MISSING_FIELDS;
      markDistroKidJobStatus(job.song_id, DISTROKID_JOB_STATUSES.BLOCKED_MISSING_FIELDS, {
        package_path: relativeToRepo(getReleasePackageDir(job.song_id)),
        latest_error_json: { blocking_missing_fields: result.blocking_fields },
      });
      continue;
    }

    if (!exists(DISTROKID_AUTH_PATH)) {
      result.skipped = true;
      result.status = DISTROKID_JOB_STATUSES.AUTH_NEEDED;
      markDistroKidJobStatus(job.song_id, DISTROKID_JOB_STATUSES.AUTH_NEEDED, {
        latest_error_json: { message: '.auth/distrokid.json is missing' },
      });
      continue;
    }

    if (values['skip-upload']) {
      result.skipped = true;
      result.status = DISTROKID_JOB_STATUSES.DRY_RUN_READY;
      markDistroKidJobStatus(job.song_id, DISTROKID_JOB_STATUSES.DRY_RUN_READY, {
        package_path: relativeToRepo(getReleasePackageDir(job.song_id)),
      });
      continue;
    }

    execFileSync(process.execPath, [
      join(REPO_ROOT, 'scripts/distrokid/upload-release.mjs'),
      '--manifest',
      manifestPath,
      '--dry-run',
    ], { cwd: REPO_ROOT, stdio: 'inherit' });
    result.upload_run = true;
    result.status = DISTROKID_JOB_STATUSES.AWAITING_MANUAL_REVIEW;
  } catch (error) {
    result.error = error.message;
    if (error.status === BLOCKED_UPLOAD_VALIDATION_EXIT_CODE) {
      result.status = DISTROKID_JOB_STATUSES.BLOCKED_UPLOAD_VALIDATION;
      markDistroKidJobStatus(job.song_id, DISTROKID_JOB_STATUSES.BLOCKED_UPLOAD_VALIDATION, {
        latest_error_json: { message: error.message },
      });
    } else {
      result.status = DISTROKID_JOB_STATUSES.FAILED;
      markDistroKidJobStatus(job.song_id, DISTROKID_JOB_STATUSES.FAILED, {
        latest_error_json: { message: error.message },
      });
    }
  }
}

writeReports();
const failed = results.filter(result => result.error).length;
if (failed) process.exit(1);

function writeReports() {
  const report = {
    batch_id: timestamp,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    dry_run: true,
    total: results.length,
    uploaded: results.filter(result => result.upload_run).length,
    skipped: results.filter(result => result.skipped).length,
    errors: results.filter(result => result.error).length,
    results,
  };
  writeJson(join(batchRunDir, 'batch-report.json'), report);
  writeText(join(batchRunDir, 'batch-report.md'), [
    '# DistroKid Queued Batch Report',
    '',
    `Batch ID: ${timestamp}`,
    `Started: ${report.started_at}`,
    `Finished: ${report.finished_at}`,
    'Mode: dry-run, no final submit',
    '',
    '| Song ID | Status | Package | Upload | Blocking fields | Error |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map(result => `| ${result.song_id} | ${result.status} | ${result.package_built ? 'yes' : 'no'} | ${result.upload_run ? 'yes' : 'no'} | ${result.blocking_fields.join(', ') || '-'} | ${result.error || '-'} |`),
    '',
    'Next: review each DistroKid browser/session manually, submit manually, then run mark-submitted.',
    '',
  ].join('\n'));
  console.log(`\nReport: ${relativeToRepo(join(batchRunDir, 'batch-report.md'))}`);
}
