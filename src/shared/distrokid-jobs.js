import { getDb, getSong, updateSongStatus } from './db.js';
import { SONG_STATUSES, normalizeSongStatus } from './song-status.js';

export const DISTROKID_JOB_STATUSES = Object.freeze({
  NOT_QUEUED: 'not_queued',
  QUEUED: 'queued_for_distrokid',
  PACKAGE_BUILT: 'package_built',
  BLOCKED_MISSING_FIELDS: 'blocked_missing_fields',
  BLOCKED_UPLOAD_VALIDATION: 'blocked_upload_validation',
  AUTH_NEEDED: 'auth_needed',
  DRY_RUN_READY: 'dry_run_ready',
  UPLOAD_STARTED: 'upload_started',
  AWAITING_MANUAL_REVIEW: 'awaiting_manual_review',
  SUBMITTED: 'submitted',
  SUBMITTED_PENDING_HYPERFOLLOW: 'submitted_pending_hyperfollow',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

export const DISTROKID_JOB_STATUS_OPTIONS = Object.freeze(Object.values(DISTROKID_JOB_STATUSES));

const TERMINAL_SONG_STATUSES = new Set([
  SONG_STATUSES.ARCHIVED,
  SONG_STATUSES.SUBMITTED_TO_DISTROKID,
  SONG_STATUSES.OUTREACH_COMPLETE,
]);

export function getDistroKidJob(songId) {
  const row = getDb().prepare('SELECT * FROM distrokid_release_jobs WHERE song_id = ? ORDER BY created_at DESC LIMIT 1').get(songId);
  return parseJob(row);
}

export function upsertDistroKidJob(songId, fields = {}) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);

  const db = getDb();
  const existing = getDistroKidJob(songId);
  const now = new Date().toISOString();
  const normalized = normalizeFields(fields);

  if (existing) {
    const updates = { updated_at: now, ...normalized };
    const clauses = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    db.prepare(`UPDATE distrokid_release_jobs SET ${clauses} WHERE id = ?`).run(...Object.values(updates), existing.id);
    return getDistroKidJob(songId);
  }

  const id = `DKJOB_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(`
    INSERT INTO distrokid_release_jobs
      (id, song_id, status, priority, scheduled_for, package_path, latest_run_log_path,
       latest_error_json, attempt_count, created_at, updated_at, queued_at, last_attempt_at,
       submitted_at, distrokid_url, notes)
    VALUES
      (@id, @song_id, @status, @priority, @scheduled_for, @package_path, @latest_run_log_path,
       @latest_error_json, @attempt_count, @created_at, @updated_at, @queued_at, @last_attempt_at,
       @submitted_at, @distrokid_url, @notes)
  `).run({
    id,
    song_id: songId,
    status: normalized.status || DISTROKID_JOB_STATUSES.NOT_QUEUED,
    priority: normalized.priority ?? 100,
    scheduled_for: normalized.scheduled_for ?? null,
    package_path: normalized.package_path ?? null,
    latest_run_log_path: normalized.latest_run_log_path ?? null,
    latest_error_json: normalized.latest_error_json ?? null,
    attempt_count: normalized.attempt_count ?? 0,
    created_at: now,
    updated_at: now,
    queued_at: normalized.queued_at ?? null,
    last_attempt_at: normalized.last_attempt_at ?? null,
    submitted_at: normalized.submitted_at ?? null,
    distrokid_url: normalized.distrokid_url ?? null,
    notes: normalized.notes ?? null,
  });

  return getDistroKidJob(songId);
}

export function queueSongForDistroKid(songId, fields = {}) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  if (!fields.force && TERMINAL_SONG_STATUSES.has(normalizeSongStatus(song.status))) {
    throw new Error(`Refusing to queue ${songId}; status is ${song.status}. Pass force explicitly to override.`);
  }
  return upsertDistroKidJob(songId, {
    ...fields,
    status: DISTROKID_JOB_STATUSES.QUEUED,
    queued_at: fields.queued_at || new Date().toISOString(),
    latest_error_json: null,
  });
}

export function clearDistroKidQueue(songId, notes = null) {
  return upsertDistroKidJob(songId, {
    status: notes ? DISTROKID_JOB_STATUSES.SKIPPED : DISTROKID_JOB_STATUSES.NOT_QUEUED,
    notes,
    updated_at: new Date().toISOString(),
  });
}

export function listQueuedDistroKidJobs(limit = 10) {
  const max = Math.max(1, Math.min(Number(limit) || 10, 100));
  return getDb().prepare(`
    SELECT j.*, s.title AS song_title, s.status AS song_status, s.release_date AS song_release_date
    FROM distrokid_release_jobs j
    JOIN songs s ON s.id = j.song_id
    WHERE j.status IN (
      'queued_for_distrokid',
      'package_built',
      'blocked_missing_fields',
      'blocked_upload_validation',
      'auth_needed',
      'dry_run_ready',
      'upload_started',
      'awaiting_manual_review',
      'submitted',
      'submitted_pending_hyperfollow',
      'failed'
    )
    ORDER BY COALESCE(j.scheduled_for, j.queued_at, j.updated_at, j.created_at) ASC, j.priority ASC
    LIMIT ?
  `).all(max).map(parseJob);
}

export function listDistroKidJobsBySongIds(songIds = []) {
  const ids = [...new Set(songIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb().prepare(`SELECT * FROM distrokid_release_jobs WHERE song_id IN (${placeholders})`).all(...ids).map(parseJob);
  return new Map(rows.map(job => [job.song_id, job]));
}

export function markDistroKidJobStatus(songId, status, fields = {}) {
  if (!DISTROKID_JOB_STATUS_OPTIONS.includes(status)) {
    throw new Error(`Invalid DistroKid job status: ${status}`);
  }
  if (status === DISTROKID_JOB_STATUSES.SUBMITTED) {
    updateSongStatus(songId, SONG_STATUSES.SUBMITTED_TO_DISTROKID);
  }
  return upsertDistroKidJob(songId, { ...fields, status });
}

function normalizeFields(fields = {}) {
  const allowed = [
    'status',
    'priority',
    'scheduled_for',
    'package_path',
    'latest_run_log_path',
    'latest_error_json',
    'attempt_count',
    'queued_at',
    'last_attempt_at',
    'submitted_at',
    'distrokid_url',
    'notes',
  ];
  const normalized = {};
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    normalized[key] = key === 'latest_error_json' && fields[key] && typeof fields[key] !== 'string'
      ? JSON.stringify(fields[key])
      : fields[key];
  }
  if (normalized.status && !DISTROKID_JOB_STATUS_OPTIONS.includes(normalized.status)) {
    throw new Error(`Invalid DistroKid job status: ${normalized.status}`);
  }
  return normalized;
}

function parseJob(row) {
  if (!row) return null;
  let latest_error = null;
  try {
    latest_error = row.latest_error_json ? JSON.parse(row.latest_error_json) : null;
  } catch {
    latest_error = { message: row.latest_error_json };
  }
  return {
    ...row,
    latest_error,
    attempt_count: Number(row.attempt_count || 0),
    priority: Number(row.priority || 100),
  };
}
