import { cleanupTestOutputArtifacts } from './test-db-artifacts.js';

const TEST_SONG_ID_LIKE = [
  'COCKPIT_SONG_%',
  'LIGHT_COCKPIT_SONG_%',
];

const TEST_ALBUM_ID_LIKE = [
  'COCKPIT_ALBUM_%',
  'LIGHT_COCKPIT_ALBUM_%',
];

const TEST_MARKETING_TARGET_ID_LIKE = [
  'COCKPIT_OUTLET_%',
];

const TEST_RELEASE_TITLE_LIKE = [
  '%Cockpit%',
];

export function buildReleaseCockpitTestDataCleanupPlan(db) {
  const albumIds = unique([
    ...selectIds(db, 'albums', 'id', releaseTestWhere('id', 'album_title', TEST_ALBUM_ID_LIKE)),
  ]);

  const songIds = unique([
    ...selectIds(db, 'songs', 'id', releaseTestWhere('id', 'title', TEST_SONG_ID_LIKE)),
    ...selectIdsWhereIn(db, 'songs', 'id', 'album_id', albumIds),
  ]);

  const marketingTargetIds = unique([
    ...selectIds(db, 'marketing_targets', 'id', [
      likeAny('id', TEST_MARKETING_TARGET_ID_LIKE),
      titleLikeWhere('name'),
    ].join(' OR ')),
  ]);

  const dailySocialCampaignIds = unique([
    ...selectIdsWhereIn(db, 'daily_social_campaigns', 'id', 'selected_song_id', songIds),
  ]);

  const marketingCampaignIds = unique([
    ...selectIdsWhereIn(db, 'marketing_campaigns', 'id', 'focus_song_id', songIds),
    ...selectIds(db, 'marketing_campaigns', 'id', titleLikeWhere('name')),
  ]);

  return {
    albumIds,
    songIds,
    marketingTargetIds,
    dailySocialCampaignIds,
    marketingCampaignIds,
    releaseIds: unique([...albumIds, ...songIds]),
  };
}

export function purgeReleaseCockpitTestData(db, options = {}) {
  const dryRun = options.dryRun !== false;
  const removeOutput = options.removeOutput !== false;
  const plan = buildReleaseCockpitTestDataCleanupPlan(db);

  if (dryRun) {
    return {
      ok: true,
      mode: 'dry-run',
      ...plan,
      dbRowsDeleted: {},
      outputArtifactsDeleted: 0,
    };
  }

  const dbRowsDeleted = db.transaction(() => deleteReleaseCockpitTestData(db, plan))();
  const output = removeOutput
    ? cleanupTestOutputArtifacts({
        songIds: plan.songIds,
        albumIds: plan.albumIds,
        packageIds: plan.releaseIds,
        marketingIds: plan.marketingTargetIds,
      })
    : { deleted: 0 };

  return {
    ok: true,
    mode: 'apply',
    ...plan,
    dbRowsDeleted,
    outputArtifactsDeleted: output.deleted,
  };
}

function deleteReleaseCockpitTestData(db, plan) {
  const deleted = {};
  const releaseIds = plan.releaseIds;
  const songIds = plan.songIds;
  const albumIds = plan.albumIds;
  const marketingTargetIds = plan.marketingTargetIds;
  const marketingCampaignIds = plan.marketingCampaignIds;
  const dailySocialCampaignIds = plan.dailySocialCampaignIds;

  // Delete child rows before parent rows. Every call is optional so this can run
  // against older local DBs whose marketing/social tables may not exist yet.
  deleted.social_posts_by_song = deleteWhereIn(db, 'social_posts', 'song_id', songIds);
  deleted.social_posts_by_campaign = deleteWhereIn(db, 'social_posts', 'campaign_id', dailySocialCampaignIds);
  deleted.daily_social_campaigns = deleteWhereIn(db, 'daily_social_campaigns', 'id', dailySocialCampaignIds);

  deleted.marketing_campaign_items_by_campaign = deleteWhereIn(db, 'marketing_campaign_items', 'campaign_id', marketingCampaignIds);
  deleted.marketing_campaign_items_by_target = deleteWhereIn(db, 'marketing_campaign_items', 'target_id', marketingTargetIds);
  deleted.marketing_campaigns = deleteWhereIn(db, 'marketing_campaigns', 'id', marketingCampaignIds);
  deleted.marketing_target_release_matches_by_song = deleteWhereIn(db, 'marketing_target_release_matches', 'song_id', songIds);
  deleted.marketing_target_release_matches_by_album = deleteWhereIn(db, 'marketing_target_release_matches', 'album_id', albumIds);
  deleted.marketing_target_release_matches_by_target = deleteWhereIn(db, 'marketing_target_release_matches', 'target_id', marketingTargetIds);
  deleted.marketing_targets = deleteWhereIn(db, 'marketing_targets', 'id', marketingTargetIds);

  deleted.release_marketing = deleteWhereIn(db, 'release_marketing', 'song_id', songIds);
  deleted.distrokid_release_jobs = deleteWhereIn(db, 'distrokid_release_jobs', 'song_id', songIds);
  deleted.publishing_checklist = deleteWhereIn(db, 'publishing_checklist', 'song_id', songIds);
  deleted.assets = deleteWhereIn(db, 'assets', 'song_id', songIds);
  deleted.release_links = deleteWhereIn(db, 'release_links', 'song_id', songIds);
  deleted.performance_snapshots = deleteWhereIn(db, 'performance_snapshots', 'song_id', songIds);

  deleted.release_cockpit_logs = deleteWhereIn(db, 'release_cockpit_logs', 'release_id', releaseIds);

  deleted.songs = deleteWhereIn(db, 'songs', 'id', songIds);
  deleted.albums = deleteWhereIn(db, 'albums', 'id', albumIds);

  return deleted;
}

function releaseTestWhere(idColumn, titleColumn, idPatterns) {
  return [
    likeAny(idColumn, idPatterns),
    `(COALESCE(is_test, 0) = 1 AND ${titleLikeWhere(titleColumn)})`,
  ].filter(Boolean).join(' OR ');
}

function titleLikeWhere(column) {
  return likeAny(column, TEST_RELEASE_TITLE_LIKE);
}

function likeAny(column, patterns) {
  return patterns
    .map(pattern => `${escapeIdentifier(column)} LIKE '${escapeSqlLike(pattern)}'`)
    .join(' OR ');
}

function selectIds(db, table, idColumn, whereSql) {
  if (!tableExists(db, table)) return [];
  if (!columnExists(db, table, idColumn)) return [];
  if (!whereSql) return [];

  try {
    return db.prepare(`SELECT ${escapeIdentifier(idColumn)} AS id FROM ${escapeIdentifier(table)} WHERE ${whereSql}`)
      .all()
      .map(row => row.id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function selectIdsWhereIn(db, table, idColumn, filterColumn, values) {
  if (!values.length || !tableExists(db, table)) return [];
  if (!columnExists(db, table, idColumn) || !columnExists(db, table, filterColumn)) return [];

  const ids = [];
  for (const chunkValues of chunks(values, 250)) {
    const placeholders = chunkValues.map(() => '?').join(',');
    const rows = db.prepare(`SELECT ${escapeIdentifier(idColumn)} AS id FROM ${escapeIdentifier(table)} WHERE ${escapeIdentifier(filterColumn)} IN (${placeholders})`)
      .all(...chunkValues);
    ids.push(...rows.map(row => row.id).filter(Boolean));
  }
  return ids;
}

function deleteWhereIn(db, table, column, values) {
  if (!values.length || !tableExists(db, table)) return 0;
  if (!columnExists(db, table, column)) return 0;

  let deleted = 0;
  for (const chunkValues of chunks(values, 250)) {
    const placeholders = chunkValues.map(() => '?').join(',');
    deleted += db.prepare(`DELETE FROM ${escapeIdentifier(table)} WHERE ${escapeIdentifier(column)} IN (${placeholders})`)
      .run(...chunkValues).changes;
  }
  return deleted;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${escapeIdentifier(table)})`).all().some(row => row.name === column);
}

function escapeIdentifier(value) {
  const identifier = String(value || '').replace(/"/g, '""');
  return `"${identifier}"`;
}

function escapeSqlLike(value) {
  return String(value || '').replace(/'/g, "''");
}

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function chunks(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}
