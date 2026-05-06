export const SONG_STATUSES = Object.freeze({
  DRAFT: 'draft',
  EDITING: 'editing',
  ARCHIVED: 'archived',
  SUBMITTED_TO_DISTROKID: 'submitted to DistroKid',
  OUTREACH_COMPLETE: 'outreach complete',
});

export const SONG_STATUS_OPTIONS = Object.freeze([
  { value: SONG_STATUSES.DRAFT, label: 'Draft' },
  { value: SONG_STATUSES.EDITING, label: 'Editing' },
  { value: SONG_STATUSES.ARCHIVED, label: 'Archived' },
  { value: SONG_STATUSES.SUBMITTED_TO_DISTROKID, label: 'Submitted to DistroKid' },
  { value: SONG_STATUSES.OUTREACH_COMPLETE, label: 'Outreach Complete' },
]);

const STATUS_ALIAS_MAP = new Map([
  [SONG_STATUSES.DRAFT, SONG_STATUSES.DRAFT],
  ['editing', SONG_STATUSES.EDITING],
  ['archived', SONG_STATUSES.ARCHIVED],
  [SONG_STATUSES.OUTREACH_COMPLETE, SONG_STATUSES.OUTREACH_COMPLETE],
  ['outreach_complete', SONG_STATUSES.OUTREACH_COMPLETE],
  ['submitted to distrokid', SONG_STATUSES.SUBMITTED_TO_DISTROKID],
  ['submitted_to_distrokid', SONG_STATUSES.SUBMITTED_TO_DISTROKID],
  ['submitted to tunecore', SONG_STATUSES.SUBMITTED_TO_DISTROKID],
  ['submitted_to_tunecore', SONG_STATUSES.SUBMITTED_TO_DISTROKID],
  ['submitted to distributor', SONG_STATUSES.SUBMITTED_TO_DISTROKID],
  ['submitted_to_distributor', SONG_STATUSES.SUBMITTED_TO_DISTROKID],
]);

export function normalizeSongStatus(status) {
  const normalizedKey = String(status || '').trim().toLowerCase();
  if (!normalizedKey) return SONG_STATUSES.DRAFT;
  return STATUS_ALIAS_MAP.get(normalizedKey) || SONG_STATUSES.DRAFT;
}

export function isRecognizedSongStatusInput(status) {
  const normalizedKey = String(status || '').trim().toLowerCase();
  return STATUS_ALIAS_MAP.has(normalizedKey);
}

export function isValidSongStatus(status) {
  return SONG_STATUS_OPTIONS.some(option => option.value === status);
}

export function getSongStatusLabel(status) {
  return SONG_STATUS_OPTIONS.find(option => option.value === status)?.label || 'Draft';
}

export function getSongStatusBadgeClass(status) {
  switch (normalizeSongStatus(status)) {
    case SONG_STATUSES.EDITING:
      return 'bg-sky-100 text-sky-700 border border-sky-200';
    case SONG_STATUSES.ARCHIVED:
      return 'bg-zinc-100 text-zinc-500 border border-zinc-200';
    case SONG_STATUSES.SUBMITTED_TO_DISTROKID:
      return 'bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200';
    case SONG_STATUSES.OUTREACH_COMPLETE:
      return 'bg-emerald-100 text-emerald-700 border border-emerald-200';
    case SONG_STATUSES.DRAFT:
    default:
      return 'bg-zinc-100 text-zinc-700 border border-zinc-200';
  }
}

export function isSubmittedSongStatus(status) {
  return normalizeSongStatus(status) === SONG_STATUSES.SUBMITTED_TO_DISTROKID;
}

export function isOutreachCompleteSongStatus(status) {
  return normalizeSongStatus(status) === SONG_STATUSES.OUTREACH_COMPLETE;
}
