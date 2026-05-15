import { SONG_STATUSES, normalizeSongStatus } from './song-status.js';

export const SONG_CATALOG_ENTITY_PREFIX = 'SONG_';

const INVALID_ID_PREFIXES = [
  'REL_',
  'RELEASE_',
  'PACK_',
  'MARKETING_',
  'ASSET_',
  'ALBUM_',
  'BRAND_',
  'PROFILE_',
  'JOB_',
  'RUN_',
  'TASK_',
  'IDEA_',
  'TEST_',
];

const INVALID_ENTITY_TERMS = [
  'release kit',
  'release-kit',
  'marketing pack',
  'marketing-pack',
  'outreach draft',
  'outreach-draft',
  'brand profile',
  'brand-profile',
  'test artifact',
  'failed generation placeholder',
  'empty idea record',
];

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function validIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function maxIso(values) {
  const valid = values.map(validIso).filter(Boolean);
  if (valid.length === 0) return null;
  valid.sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  return valid[0];
}

export function getSongLatestActivityAt(song = {}) {
  const lastOutreach = parseJsonObject(song.last_outreach_json || song.last_outreach);
  const releaseRecommendation = parseJsonObject(song.release_recommendation_json || song.release_recommendation);
  const marketingReadiness = parseJsonObject(song.marketing_readiness_json || song.marketing_readiness);
  const marketingAssets = parseJsonObject(song.marketing_assets_json || song.marketing_assets);

  return maxIso([
    song.latest_activity_at,
    song.updated_at,
    song.published_at,
    song.distributor_submission_date,
    song.release_date,
    lastOutreach.contacted_at,
    lastOutreach.updated_at,
    releaseRecommendation.analyzed_at,
    releaseRecommendation.updated_at,
    marketingReadiness.updated_at,
    marketingAssets.updated_at,
    song.created_at,
  ]);
}

export function isRealSongCatalogRow(song = {}) {
  const id = String(song.id || '').trim();
  if (!id) return false;
  if (!id.startsWith(SONG_CATALOG_ENTITY_PREFIX)) return false;
  if (INVALID_ID_PREFIXES.some(prefix => id.startsWith(prefix))) return false;
  if (Number(song.is_test || 0) === 1) return false;

  const identityText = [song.title, song.topic, song.concept]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!identityText) return false;

  const searchable = [song.id, song.title, song.topic, song.concept, song.notes, song.pipeline_stage]
    .map(value => String(value || '').toLowerCase())
    .join(' | ');

  if (INVALID_ENTITY_TERMS.some(term => searchable.includes(term))) return false;

  return true;
}

export function normalizeSongCatalogRow(song = {}) {
  return {
    ...song,
    status: normalizeSongStatus(song.status || SONG_STATUSES.DRAFT),
    latest_activity_at: getSongLatestActivityAt(song),
  };
}

export function buildSongCatalogCleanupPlan(rows = []) {
  const plan = {
    before: rows.length,
    valid: [],
    invalid: [],
    statusNormalizations: [],
    latestActivityUpdates: [],
  };

  for (const row of rows) {
    if (!isRealSongCatalogRow(row)) {
      plan.invalid.push(row);
      continue;
    }

    const normalized = normalizeSongCatalogRow(row);
    plan.valid.push(normalized);

    if (normalized.status !== row.status) {
      plan.statusNormalizations.push({ id: row.id, from: row.status, to: normalized.status });
    }

    if (normalized.latest_activity_at && normalized.latest_activity_at !== row.latest_activity_at) {
      plan.latestActivityUpdates.push({ id: row.id, latest_activity_at: normalized.latest_activity_at });
    }
  }

  return {
    ...plan,
    after: plan.valid.length,
    removed: plan.invalid.length,
  };
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function optionalDeleteStatement(db, table, sql) {
  return tableExists(db, table) ? db.prepare(sql) : null;
}

function invalidPrefixTriggerCondition() {
  return INVALID_ID_PREFIXES
    .map(prefix => `NEW.id LIKE '${prefix.replaceAll("'", "''")}%'`)
    .join(' OR ');
}

export function ensureSongCatalogCleanupSchema(db) {
  if (!columnExists(db, 'songs', 'latest_activity_at')) {
    db.exec('ALTER TABLE songs ADD COLUMN latest_activity_at TEXT');
  }

  db.exec('DROP TRIGGER IF EXISTS prevent_non_song_catalog_insert');
  db.exec(`
    CREATE TRIGGER prevent_non_song_catalog_insert
    BEFORE INSERT ON songs
    WHEN NEW.id IS NULL
      OR TRIM(COALESCE(NEW.title, '') || COALESCE(NEW.topic, '') || COALESCE(NEW.concept, '')) = ''
      OR ${invalidPrefixTriggerCondition()}
    BEGIN
      SELECT RAISE(ABORT, 'Invalid song catalog row: songs table cannot receive empty rows or known non-song entity prefixes');
    END;
  `);
}

export function applySongCatalogCleanup(db) {
  ensureSongCatalogCleanupSchema(db);

  const rows = db.prepare('SELECT * FROM songs').all();
  const plan = buildSongCatalogCleanupPlan(rows);

  const dependentDeletes = [
    optionalDeleteStatement(db, 'social_posts', 'DELETE FROM social_posts WHERE song_id = ?'),
    optionalDeleteStatement(db, 'social_posts', 'DELETE FROM social_posts WHERE campaign_id IN (SELECT id FROM daily_social_campaigns WHERE selected_song_id = ?)'),
    optionalDeleteStatement(db, 'daily_social_campaigns', 'DELETE FROM daily_social_campaigns WHERE selected_song_id = ?'),
    optionalDeleteStatement(db, 'workflow_runs', 'UPDATE workflow_runs SET song_id = NULL WHERE song_id = ?'),
    optionalDeleteStatement(db, 'marketing_target_release_matches', 'DELETE FROM marketing_target_release_matches WHERE song_id = ?'),
    optionalDeleteStatement(db, 'marketing_campaigns', 'UPDATE marketing_campaigns SET focus_song_id = NULL WHERE focus_song_id = ?'),
    optionalDeleteStatement(db, 'release_marketing', 'DELETE FROM release_marketing WHERE song_id = ?'),
    optionalDeleteStatement(db, 'publishing_checklist', 'DELETE FROM publishing_checklist WHERE song_id = ?'),
    optionalDeleteStatement(db, 'assets', 'DELETE FROM assets WHERE song_id = ?'),
    optionalDeleteStatement(db, 'release_links', 'DELETE FROM release_links WHERE song_id = ?'),
    optionalDeleteStatement(db, 'performance_snapshots', 'DELETE FROM performance_snapshots WHERE song_id = ?'),
  ].filter(Boolean);

  const deleteInvalid = db.prepare('DELETE FROM songs WHERE id = ?');
  const updateValid = db.prepare('UPDATE songs SET status = ?, latest_activity_at = ?, updated_at = COALESCE(updated_at, ?) WHERE id = ?');

  const run = db.transaction(() => {
    for (const row of plan.invalid) {
      for (const deleteChild of dependentDeletes) deleteChild.run(row.id);
      deleteInvalid.run(row.id);
    }
    for (const row of plan.valid) updateValid.run(row.status, row.latest_activity_at, row.latest_activity_at, row.id);
  });

  run();

  return {
    rows_before: plan.before,
    valid_song_rows_after: plan.after,
    invalid_rows_removed: plan.removed,
    statuses_normalized: plan.statusNormalizations.length,
    latest_activity_updates: plan.latestActivityUpdates.length,
    removed_ids: plan.invalid.map(row => row.id),
  };
}
