import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  getSong,
  updateSongStatus,
  upsertReleaseLink,
  upsertSong,
  updateChecklistItem,
} from './db.js';
import { DISTROKID_JOB_STATUSES, markDistroKidJobStatus } from './distrokid-jobs.js';
import { SONG_STATUSES } from './song-status.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function markSongSubmittedToDistroKid(songId, options = {}) {
  const song = getSong(songId);
  if (!song) {
    throw new Error(`Song not found: ${songId}`);
  }

  const nowIso = new Date().toISOString();
  const submittedAt = options.submitted_at || options.submittedAt || nowIso;
  const submittedDate = new Date(submittedAt).toISOString().slice(0, 10);
  const distrokidUrl = String(options.distrokid_url || options.distrokidUrl || '').trim();
  const notes = String(options.notes || '').trim();

  updateSongStatus(songId, SONG_STATUSES.SUBMITTED_TO_DISTROKID);
  upsertSong({
    id: songId,
    distributor: 'DistroKid',
    distributor_submission_date: submittedDate,
    distribution_status: 'submitted',
    ...(notes ? { notes: song.notes ? `${song.notes}\n${notes}` : notes } : {}),
  });

  if (distrokidUrl) {
    upsertReleaseLink(songId, 'DistroKid', distrokidUrl);
  }

  markDistroKidJobStatus(songId, DISTROKID_JOB_STATUSES.SUBMITTED, {
    submitted_at: submittedAt,
    distrokid_url: distrokidUrl || null,
    notes: notes || null,
  });

  try {
    updateChecklistItem(songId, 'uploaded_distributor', {
      status: 'done',
      note: `Submitted to DistroKid${distrokidUrl ? `: ${distrokidUrl}` : ''}`,
    });
  } catch {
    // Older databases may not have initialized checklist rows yet.
  }

  const log = {
    song_id: songId,
    title: song.title || null,
    status: SONG_STATUSES.SUBMITTED_TO_DISTROKID,
    distributor: 'DistroKid',
    distribution_status: 'submitted',
    distributor_submission_date: submittedDate,
    distrokid_url: distrokidUrl || null,
    notes: notes || null,
    marked_at: nowIso,
  };

  const logDir = join(REPO_ROOT, 'output', 'release-packages', songId);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'distrokid-submission.json'), `${JSON.stringify(log, null, 2)}\n`, 'utf8');

  return log;
}
