/**
 * SQLite database helpers for the music pipeline
 * Includes: runs, songs, ideas, assets, publishing_checklist,
 *           release_links, performance_snapshots, service_research, errors
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadBrandProfile } from './brand-profile.js';
import { SONG_STATUSES, normalizeSongStatus } from './song-status.js';
import { isRealSongCatalogRow } from './song-catalog-cleanup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SLUG = process.env.PIPELINE_APP_SLUG || 'music-pipeline';
const DB_PATH = join(__dirname, `../../${APP_SLUG}.db`);
const BRAND_PROFILE = loadBrandProfile();
const DEFAULT_AUDIENCE_RANGE = BRAND_PROFILE.audience.age_range;
const DEFAULT_DISTRIBUTOR = BRAND_PROFILE.distribution.default_distributor;

let _db = null;

export function getDbPath() {
  return DB_PATH;
}

export function getDbAppSlug() {
  return APP_SLUG;
}

export function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  initSchema(_db);
  return _db;
}

function initSchema(db) {
  // Core tables that always existed
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      task_summary TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      runtime_seconds REAL DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      session_id TEXT,
      status TEXT DEFAULT 'success'
    );

    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      title TEXT,
      slug TEXT,
      topic TEXT,
      status TEXT DEFAULT 'draft',
      originating_idea_id TEXT,
      concept TEXT,
      target_age_range TEXT,
      genre_tags TEXT,
      mood_tags TEXT,
      keywords TEXT,
      notes TEXT,
      release_date TEXT,
      distributor TEXT,
      distributor_submission_date TEXT,
      publishing_status TEXT DEFAULT 'not_started',
      published_at TEXT,
      lyrics_path TEXT,
      audio_prompt_path TEXT,
      thumbnail_path TEXT,
      metadata_path TEXT,
      music_service TEXT,
      distribution_status TEXT,
      brand_score INTEGER,
      total_cost_usd REAL DEFAULT 0,
      brand_profile_id TEXT,
      is_test INTEGER DEFAULT 0,
      pipeline_stage TEXT,
      release_recommendation_json TEXT,
      release_recommendation_history_json TEXT,
      marketing_inputs_from_ar_json TEXT,
      marketing_links_json TEXT,
      marketing_assets_json TEXT,
      marketing_readiness_json TEXT,
      last_outreach_json TEXT
    );

    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      status TEXT DEFAULT 'new',
      title TEXT NOT NULL,
      concept TEXT,
      hook TEXT,
      target_age_range TEXT,
      category TEXT,
      mood TEXT,
      educational_angle TEXT,
      tags TEXT,
      lyric_seed TEXT,
      thumbnail_seed TEXT,
      notes TEXT,
      source_type TEXT DEFAULT 'manual',
      source_ref TEXT,
      promoted_song_id TEXT,
      brand_profile_id TEXT
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      asset_type TEXT NOT NULL,
      label TEXT,
      version INTEGER DEFAULT 1,
      file_path TEXT,
      mime_type TEXT,
      text_content TEXT,
      is_current INTEGER DEFAULT 1,
      notes TEXT,
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS publishing_checklist (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT DEFAULT 'not_started',
      note TEXT,
      updated_at TEXT,
      FOREIGN KEY (song_id) REFERENCES songs(id),
      UNIQUE(song_id, key)
    );

    CREATE TABLE IF NOT EXISTS release_links (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      url TEXT NOT NULL,
      external_id TEXT,
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS performance_snapshots (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      metrics_json TEXT,
      notes TEXT,
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS service_research (
      id TEXT PRIMARY KEY,
      researched_at TEXT NOT NULL,
      service_name TEXT NOT NULL,
      free_tier TEXT,
      cost_per_song_usd REAL,
      api_available INTEGER DEFAULT 0,
      notes TEXT,
      recommended INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS errors (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_name TEXT,
      error_message TEXT,
      context TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_social_campaigns (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      timezone TEXT NOT NULL,
      brand TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      selected_song_id TEXT NOT NULL,
      selected_release_id TEXT,
      campaign_type TEXT NOT NULL,
      rationale TEXT,
      created_by TEXT DEFAULT 'agent',
      requires_approval INTEGER DEFAULT 1,
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE(date, selected_song_id, campaign_type),
      FOREIGN KEY (selected_song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      brand_profile_id TEXT,
      album_title TEXT,
      album_theme TEXT,
      release_intent TEXT,
      release_date TEXT,
      number_of_songs INTEGER NOT NULL DEFAULT 1,
      cost_mode TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'pending',
      shared_orchestration_json TEXT,
      finance_summary_json TEXT,
      notes TEXT,
      is_test INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      release_id TEXT,
      song_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      asset_type TEXT NOT NULL,
      asset_url TEXT,
      public_asset_url TEXT,
      title TEXT,
      caption TEXT,
      description TEXT,
      hashtags_json TEXT,
      scheduled_at TEXT,
      published_at TEXT,
      platform_post_id TEXT,
      platform_post_url TEXT,
      ai_generated INTEGER DEFAULT 1,
      made_for_kids INTEGER,
      contains_synthetic_media INTEGER DEFAULT 1,
      validation_warnings_json TEXT,
      error_code TEXT,
      error_message TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY (campaign_id) REFERENCES daily_social_campaigns(id),
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS distrokid_release_jobs (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_queued',
      priority INTEGER DEFAULT 100,
      scheduled_for TEXT,
      package_path TEXT,
      latest_run_log_path TEXT,
      latest_error_json TEXT,
      attempt_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      queued_at TEXT,
      last_attempt_at TEXT,
      submitted_at TEXT,
      distrokid_url TEXT,
      notes TEXT,
      FOREIGN KEY (song_id) REFERENCES songs(id)
    );

    CREATE TABLE IF NOT EXISTS release_cockpit_logs (
      id TEXT PRIMARY KEY,
      release_type TEXT NOT NULL,
      release_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS release_campaigns (
      id TEXT PRIMARY KEY,
      release_type TEXT NOT NULL,
      release_id TEXT NOT NULL,
      title TEXT NOT NULL,
      release_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      lifecycle_state TEXT NOT NULL DEFAULT 'planned',
      current_gate TEXT,
      campaign_plan_json TEXT,
      context_json TEXT,
      links_json TEXT,
      asset_selection_json TEXT,
      run_summary_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(release_type, release_id)
    );

    CREATE TABLE IF NOT EXISTS release_campaign_tasks (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      owner TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'pending',
      due_date TEXT,
      offset_days INTEGER,
      depends_on_json TEXT,
      blocking INTEGER NOT NULL DEFAULT 0,
      action_url TEXT,
      result_json TEXT,
      result_path TEXT,
      source_workflow_id TEXT,
      source_run_id TEXT,
      next_follow_up_date TEXT,
      related_item_id TEXT,
      reason TEXT,
      suggested_action TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (campaign_id) REFERENCES release_campaigns(id),
      UNIQUE(campaign_id, task_key)
    );

    CREATE TABLE IF NOT EXISTS release_campaign_runs (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      task_id TEXT,
      workflow_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL,
      package_path TEXT,
      result_path TEXT,
      stdout_path TEXT,
      stderr_path TEXT,
      log_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES release_campaigns(id),
      FOREIGN KEY (task_id) REFERENCES release_campaign_tasks(id)
    );

    CREATE TABLE IF NOT EXISTS visual_library_assets (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      aspect_ratio TEXT,
      duration_seconds REAL,
      character_tags_json TEXT,
      scene_tags_json TEXT,
      mood_tags_json TEXT,
      album_tags_json TEXT,
      song_tags_json TEXT,
      loopable INTEGER DEFAULT 0,
      safe_for_kids INTEGER DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual',
      rights_status TEXT NOT NULL DEFAULT 'owned_generated',
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visual_library_usage (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      release_type TEXT NOT NULL,
      release_id TEXT NOT NULL,
      song_id TEXT,
      platform TEXT,
      usage_context TEXT,
      used_at TEXT NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES visual_library_assets(id)
    );

    CREATE TABLE IF NOT EXISTS release_browsy_recordings (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      task_id TEXT,
      task_key TEXT NOT NULL,
      release_type TEXT,
      release_id TEXT,
      workflow_id TEXT,
      workflow_ref TEXT,
      recording_session_id TEXT,
      recording_status TEXT NOT NULL DEFAULT 'setup_ready',
      wizard_url TEXT,
      recorder_url TEXT,
      browsy_base_url TEXT,
      contract_snapshot_json TEXT,
      contract_completeness_json TEXT,
      imported_workflow_ref TEXT,
      imported_at TEXT,
      started_at TEXT,
      launched_at TEXT,
      stopped_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES release_campaigns(id)
    );
  `);

  // Migrate existing songs table — add new columns if they don't exist yet
  const songCols = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
  const newSongCols = [
    ['updated_at', 'TEXT'],
    ['slug', 'TEXT'],
    ['originating_idea_id', 'TEXT'],
    ['concept', 'TEXT'],
    ['target_age_range', 'TEXT'],
    ['genre_tags', 'TEXT'],
    ['mood_tags', 'TEXT'],
    ['keywords', 'TEXT'],
    ['notes', 'TEXT'],
    ['release_date', 'TEXT'],
    ['distributor', 'TEXT'],
    ['distributor_submission_date', 'TEXT'],
    ['publishing_status', "TEXT DEFAULT 'not_started'"],
    ['published_at', 'TEXT'],
    ['brand_profile_id', 'TEXT'],
    ['is_test', 'INTEGER DEFAULT 0'],
    ['pipeline_stage', 'TEXT'],
    ['release_recommendation_json', 'TEXT'],
    ['release_recommendation_history_json', 'TEXT'],
    ['marketing_inputs_from_ar_json', 'TEXT'],
    ['marketing_links_json', 'TEXT'],
    ['marketing_assets_json', 'TEXT'],
    ['marketing_readiness_json', 'TEXT'],
    ['last_outreach_json', 'TEXT'],
    ['album_id', 'TEXT'],
    ['track_number', 'INTEGER'],
    ['album_role', 'TEXT'],
    ['inherited_album_plan_version', 'TEXT'],
    ['single_priority', 'INTEGER'],
    ['single_visual_asset_id', 'TEXT'],
    ['single_custom_video_requested', 'INTEGER DEFAULT 0'],
    ['starred', 'INTEGER DEFAULT 0'],
  ];
  for (const [col, type] of newSongCols) {
    if (!songCols.includes(col)) {
      db.exec(`ALTER TABLE songs ADD COLUMN ${col} ${type}`);
    }
  }

  // Migrate albums table — add new columns if older schema exists.
  const albumCols = db.prepare("PRAGMA table_info(albums)").all().map(c => c.name);
  const newAlbumCols = [
    ['notes', 'TEXT'],
    ['is_test', 'INTEGER DEFAULT 0'],
    ['release_date', 'TEXT'],
    ['starred', 'INTEGER DEFAULT 0'],
  ];
  for (const [col, type] of newAlbumCols) {
    if (!albumCols.includes(col)) {
      db.exec(`ALTER TABLE albums ADD COLUMN ${col} ${type}`);
    }
  }

  // Migrate ideas table
  const ideaCols = db.prepare("PRAGMA table_info(ideas)").all().map(c => c.name);
  const newIdeaCols = [['brand_profile_id', 'TEXT']];
  for (const [col, type] of newIdeaCols) {
    if (!ideaCols.includes(col)) {
      db.exec(`ALTER TABLE ideas ADD COLUMN ${col} ${type}`);
    }
  }

  const migratedSongCols = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
  if (songCols.includes('tunecore_submission_date') && migratedSongCols.includes('distributor_submission_date')) {
    db.exec(`
      UPDATE songs
      SET distributor_submission_date = COALESCE(distributor_submission_date, tunecore_submission_date)
      WHERE tunecore_submission_date IS NOT NULL
    `);
  }
  db.exec(`
    UPDATE songs
    SET status = '${SONG_STATUSES.SUBMITTED_TO_DISTROKID}'
    WHERE lower(trim(COALESCE(status, ''))) IN (
      'submitted_to_distrokid',
      'submitted to distrokid',
      'submitted_to_distributor',
      'submitted to distributor'
    )
  `);
  db.exec(`
    UPDATE songs
    SET status = '${SONG_STATUSES.EDITING}'
    WHERE lower(trim(COALESCE(status, ''))) = 'editing'
  `);
  db.exec(`
    UPDATE songs
    SET status = '${SONG_STATUSES.ARCHIVED}'
    WHERE lower(trim(COALESCE(status, ''))) = 'archived'
  `);
  db.exec(`
    UPDATE songs
    SET status = '${SONG_STATUSES.OUTREACH_COMPLETE}'
    WHERE lower(trim(COALESCE(status, ''))) IN ('outreach complete', 'outreach_complete')
  `);
  db.exec(`
    UPDATE songs
    SET status = '${SONG_STATUSES.DRAFT}'
    WHERE lower(trim(COALESCE(status, ''))) NOT IN (
      'draft',
      'editing',
      'archived',
      'submitted to distrokid',
      'outreach complete'
    )
  `);

  // Backfill known synthetic/test rows so they stop leaking into catalog views.
  db.exec(`
    UPDATE songs
    SET is_test = 1
    WHERE COALESCE(is_test, 0) = 0
      AND (
        id LIKE 'SONG_RELEASE_MARKETING_TEST%'
        OR notes LIKE '%test-release-marketing-flow%'
      )
  `);
}

// ─────────────────────────────────────────────
// RUN LOGGING
// ─────────────────────────────────────────────

export function logRun({ id, agentName, taskSummary, inputTokens, outputTokens, cacheReadTokens, runtimeSeconds, costUsd, sessionId, status = 'success' }) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO runs
      (id, timestamp, agent_name, task_summary, input_tokens, output_tokens, cache_read_tokens, runtime_seconds, cost_usd, session_id, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    new Date().toISOString(),
    agentName,
    taskSummary ? taskSummary.substring(0, 500) : '',
    inputTokens || 0,
    outputTokens || 0,
    cacheReadTokens || 0,
    runtimeSeconds || 0,
    costUsd || 0,
    sessionId || null,
    status
  );
}

export function logError({ agentName, errorMessage, context }) {
  const db = getDb();
  const id = `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO errors (id, timestamp, agent_name, error_message, context)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, new Date().toISOString(), agentName, errorMessage, JSON.stringify(context || {}));
}

// ─────────────────────────────────────────────
// SONGS
// ─────────────────────────────────────────────

export function upsertSong(song) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM songs WHERE id = ?').get(song.id);
  const normalizedStatus = song.status !== undefined ? normalizeSongStatus(song.status) : undefined;

  if (existing) {
    // PATCH update — only overwrite non-null/undefined values
    const updates = { updated_at: now };
    const patchable = [
      'title', 'slug', 'topic', 'status', 'originating_idea_id', 'concept',
      'target_age_range', 'genre_tags', 'mood_tags', 'keywords', 'notes',
      'release_date', 'distributor', 'distributor_submission_date', 'publishing_status',
      'published_at', 'lyrics_path', 'audio_prompt_path', 'thumbnail_path',
      'metadata_path', 'music_service', 'distribution_status', 'brand_score',
      'total_cost_usd', 'brand_profile_id', 'pipeline_stage', 'release_recommendation_json',
      'release_recommendation_history_json', 'marketing_inputs_from_ar_json', 'marketing_links_json',
      'marketing_assets_json', 'marketing_readiness_json', 'last_outreach_json', 'is_test',
      'album_id', 'track_number', 'album_role', 'inherited_album_plan_version',
      'single_priority', 'single_visual_asset_id', 'single_custom_video_requested', 'starred',
    ];
    for (const key of patchable) {
      if (song[key] !== undefined && song[key] !== null) {
        updates[key] = key === 'status'
          ? normalizedStatus
          : (key === 'is_test' || key === 'single_custom_video_requested' || key === 'starred' ? (song[key] ? 1 : 0) : song[key]);
      }
    }
    if (song.marketing_links !== undefined) updates.marketing_links_json = stringifyOptionalJson(song.marketing_links);
    if (song.marketing_assets !== undefined) updates.marketing_assets_json = stringifyOptionalJson(song.marketing_assets);
    if (song.marketing_readiness !== undefined) updates.marketing_readiness_json = stringifyOptionalJson(song.marketing_readiness);
    if (song.last_outreach !== undefined) updates.last_outreach_json = stringifyOptionalJson(song.last_outreach);
    if (song.release_recommendation !== undefined) updates.release_recommendation_json = stringifyOptionalJson(song.release_recommendation);
    if (song.release_recommendation_history !== undefined) updates.release_recommendation_history_json = stringifyOptionalJson(song.release_recommendation_history);
    if (song.marketing_inputs_from_ar !== undefined) updates.marketing_inputs_from_ar_json = stringifyOptionalJson(song.marketing_inputs_from_ar);
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const vals = [...Object.values(updates), song.id];
    db.prepare(`UPDATE songs SET ${setClauses} WHERE id = ?`).run(...vals);
  } else {
    db.prepare(`
      INSERT INTO songs
        (id, created_at, updated_at, title, slug, topic, status, originating_idea_id,
         concept, target_age_range, genre_tags, mood_tags, keywords, notes,
         release_date, distributor, distributor_submission_date, publishing_status,
         published_at, lyrics_path, audio_prompt_path, thumbnail_path, metadata_path,
         music_service, distribution_status, brand_score, total_cost_usd, brand_profile_id,
         is_test, pipeline_stage, release_recommendation_json, release_recommendation_history_json,
         marketing_inputs_from_ar_json, marketing_links_json, marketing_assets_json, marketing_readiness_json, last_outreach_json,
         album_id, track_number, album_role, inherited_album_plan_version,
         single_priority, single_visual_asset_id, single_custom_video_requested)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      song.id,
      song.created_at || now,
      now,
      song.title || null,
      song.slug || null,
      song.topic || null,
      normalizedStatus || SONG_STATUSES.DRAFT,
      song.originating_idea_id || null,
      song.concept || null,
      song.target_age_range || null,
      song.genre_tags ? JSON.stringify(song.genre_tags) : null,
      song.mood_tags ? JSON.stringify(song.mood_tags) : null,
      song.keywords ? JSON.stringify(song.keywords) : null,
      song.notes || null,
      song.release_date || null,
      song.distributor || DEFAULT_DISTRIBUTOR,
      song.distributor_submission_date || null,
      song.publishing_status || 'not_started',
      song.published_at || null,
      song.lyrics_path || null,
      song.audio_prompt_path || null,
      song.thumbnail_path || null,
      song.metadata_path || null,
      song.music_service || null,
      song.distribution_status || null,
      song.brand_score || null,
      song.total_cost_usd || 0,
      song.brand_profile_id || null,
      song.is_test ? 1 : 0,
      song.pipeline_stage || null,
      stringifyOptionalJson(song.release_recommendation),
      stringifyOptionalJson(song.release_recommendation_history),
      stringifyOptionalJson(song.marketing_inputs_from_ar),
      stringifyOptionalJson(song.marketing_links),
      stringifyOptionalJson(song.marketing_assets),
      stringifyOptionalJson(song.marketing_readiness),
      stringifyOptionalJson(song.last_outreach),
      song.album_id || null,
      song.track_number == null ? null : Number(song.track_number),
      song.album_role || null,
      song.inherited_album_plan_version || null,
      song.single_priority == null ? null : Number(song.single_priority),
      song.single_visual_asset_id || null,
      song.single_custom_video_requested ? 1 : 0,
    );
  }
}

// ─────────────────────────────────────────────
// ALBUMS / BATCHES
// ─────────────────────────────────────────────

export function createAlbum(album) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = album.id || `ALBUM_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(`
    INSERT INTO albums
      (id, created_at, updated_at, brand_profile_id, album_title, album_theme, release_intent,
       release_date, number_of_songs, cost_mode, status, shared_orchestration_json, finance_summary_json, notes, is_test)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, now, now,
    album.brand_profile_id || null,
    album.album_title || null,
    album.album_theme || null,
    album.release_intent || null,
    album.release_date || null,
    Math.max(1, Number(album.number_of_songs) || 1),
    album.cost_mode || 'standard',
    album.status || 'pending',
    stringifyOptionalJson(album.shared_orchestration),
    stringifyOptionalJson(album.finance_summary),
    album.notes || null,
    album.is_test ? 1 : 0,
  );
  return id;
}

export function updateAlbum(id, fields = {}) {
  const db = getDb();
  const updates = { updated_at: new Date().toISOString() };
  const allowed = [
    'album_title', 'album_theme', 'release_intent', 'number_of_songs',
    'cost_mode', 'status', 'notes', 'brand_profile_id', 'release_date', 'starred',
  ];
  for (const key of allowed) {
    if (fields[key] !== undefined && fields[key] !== null) {
      updates[key] = key === 'number_of_songs' ? Number(fields[key]) : (key === 'starred' ? (fields[key] ? 1 : 0) : fields[key]);
    }
  }
  if (fields.shared_orchestration !== undefined) {
    updates.shared_orchestration_json = stringifyOptionalJson(fields.shared_orchestration);
  }
  if (fields.finance_summary !== undefined) {
    updates.finance_summary_json = stringifyOptionalJson(fields.finance_summary);
  }
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE albums SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), id);
}

function parseAlbum(row) {
  if (!row) return null;
  return {
    ...row,
    shared_orchestration: parseJsonObject(row.shared_orchestration_json),
    finance_summary: parseJsonObject(row.finance_summary_json),
    is_test: Boolean(row.is_test),
  };
}

export function getAlbum(id) {
  return parseAlbum(getDb().prepare('SELECT * FROM albums WHERE id = ?').get(id));
}

export function getAllAlbums({ includeTests = false } = {}) {
  const sql = includeTests
    ? 'SELECT * FROM albums ORDER BY created_at DESC'
    : 'SELECT * FROM albums WHERE COALESCE(is_test, 0) = 0 ORDER BY created_at DESC';
  return getDb().prepare(sql).all().map(parseAlbum);
}

export function getSongsForAlbum(albumId) {
  return getDb()
    .prepare('SELECT * FROM songs WHERE album_id = ? ORDER BY COALESCE(track_number, 999), created_at ASC')
    .all(albumId)
    .map(parseSong);
}

export function getSongForAlbumTrack(albumId, trackNumber) {
  return parseSong(getDb()
    .prepare('SELECT * FROM songs WHERE album_id = ? AND track_number = ? ORDER BY created_at ASC LIMIT 1')
    .get(albumId, Number(trackNumber)));
}

export function assignSongsToAlbum(albumId, songIds, { startTrackNumber = 1 } = {}) {
  const db = getDb();
  const album = getAlbum(albumId);
  if (!album) throw new Error(`Album not found: ${albumId}`);
  const uniqueSongIds = [...new Set((songIds || []).map(id => String(id || '').trim()).filter(Boolean))];
  if (!uniqueSongIds.length) throw new Error('At least one song is required.');
  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE songs
    SET album_id = ?, track_number = ?, album_role = COALESCE(album_role, 'track'), updated_at = ?
    WHERE id = ?
  `);
  const tx = db.transaction((ids) => {
    ids.forEach((songId, index) => update.run(albumId, Number(startTrackNumber) + index, now, songId));
  });
  tx(uniqueSongIds);
  updateAlbum(albumId, { number_of_songs: getSongsForAlbum(albumId).length });
  return getSongsForAlbum(albumId);
}

export function assignAlbumSingles(albumId, singles = []) {
  const db = getDb();
  const album = getAlbum(albumId);
  if (!album) throw new Error(`Album not found: ${albumId}`);
  const normalized = (Array.isArray(singles) ? singles : [singles])
    .map((item, index) => {
      if (typeof item === 'string') {
        return {
          songId: item,
          priority: index + 1,
          visualAssetId: null,
          customVideoRequested: false,
        };
      }
      return {
        songId: String(item?.songId || item?.song_id || '').trim(),
        priority: item?.priority == null ? index + 1 : Number(item.priority),
        visualAssetId: item?.visualAssetId || item?.visual_asset_id || null,
        customVideoRequested: Boolean(item?.customVideoRequested || item?.custom_video_requested),
      };
    })
    .filter(item => item.songId);
  const albumSongIds = new Set(getSongsForAlbum(albumId).map(song => song.id));
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE songs
      SET album_role = CASE WHEN COALESCE(album_role, 'track') = 'single' THEN 'track' ELSE COALESCE(album_role, 'track') END,
          single_priority = NULL,
          single_visual_asset_id = NULL,
          single_custom_video_requested = 0,
          updated_at = ?
      WHERE album_id = ?
    `).run(now, albumId);
    const update = db.prepare(`
      UPDATE songs
      SET album_role = 'single',
          single_priority = ?,
          single_visual_asset_id = ?,
          single_custom_video_requested = ?,
          updated_at = ?
      WHERE id = ? AND album_id = ?
    `);
    for (const single of normalized) {
      if (!albumSongIds.has(single.songId)) continue;
      update.run(single.priority, single.visualAssetId, single.customVideoRequested ? 1 : 0, now, single.songId, albumId);
    }
  });
  tx();
  return getSongsForAlbum(albumId);
}

export function reorderAlbumTracks(albumId, orderedSongIds) {
  const db = getDb();
  const album = getAlbum(albumId);
  if (!album) throw new Error(`Album not found: ${albumId}`);
  const existing = new Set(getSongsForAlbum(albumId).map(song => song.id));
  const ids = [...new Set((orderedSongIds || []).map(id => String(id || '').trim()).filter(Boolean))]
    .filter(id => existing.has(id));
  if (!ids.length) throw new Error('At least one album track is required.');
  const now = new Date().toISOString();
  const update = db.prepare('UPDATE songs SET track_number = ?, updated_at = ? WHERE id = ? AND album_id = ?');
  const tx = db.transaction((songIds) => {
    songIds.forEach((songId, index) => update.run(index + 1, now, songId, albumId));
  });
  tx(ids);
  return getSongsForAlbum(albumId);
}

export function deleteAlbum(id, { detachSongs = true } = {}) {
  const db = getDb();
  if (detachSongs) {
    db.prepare('UPDATE songs SET album_id = NULL, track_number = NULL, album_role = NULL WHERE album_id = ?').run(id);
  }
  db.prepare('DELETE FROM albums WHERE id = ?').run(id);
}

export function getSong(id) {
  return parseSong(getDb().prepare('SELECT * FROM songs WHERE id = ?').get(id));
}

export function getAllSongs(options = {}) {
  const includeTests = options.includeTests === true;
  const sql = includeTests
    ? 'SELECT * FROM songs ORDER BY created_at DESC'
    : 'SELECT * FROM songs WHERE COALESCE(is_test, 0) = 0 ORDER BY created_at DESC';
  const songs = getDb().prepare(sql).all().map(parseSong);
  return includeTests ? songs : songs.filter(isRealSongCatalogRow);
}

export function updateSongStatus(id, status) {
  const db = getDb();
  db.prepare(`UPDATE songs SET status = ?, updated_at = ? WHERE id = ?`).run(normalizeSongStatus(status), new Date().toISOString(), id);
}

export function deleteSong(id) {
  const db = getDb();
  db.prepare('DELETE FROM social_posts WHERE song_id = ?').run(id);
  db.prepare('DELETE FROM daily_social_campaigns WHERE selected_song_id = ?').run(id);
  db.prepare('DELETE FROM publishing_checklist WHERE song_id = ?').run(id);
  db.prepare('DELETE FROM assets WHERE song_id = ?').run(id);
  db.prepare('DELETE FROM release_links WHERE song_id = ?').run(id);
  db.prepare('DELETE FROM performance_snapshots WHERE song_id = ?').run(id);
  db.prepare('DELETE FROM songs WHERE id = ?').run(id);
}

function parseSong(s) {
  if (!s) return null;
  const { tunecore_submission_date: legacySubmissionDate, ...song } = s;
  return {
    ...song,
    status: normalizeSongStatus(s.status),
    distributor_submission_date: s.distributor_submission_date || legacySubmissionDate || null,
    genre_tags: parseJsonArray(s.genre_tags),
    mood_tags: parseJsonArray(s.mood_tags),
    keywords: parseJsonArray(s.keywords),
    release_recommendation: parseJsonObject(s.release_recommendation_json),
    release_recommendation_history: parseJsonArray(s.release_recommendation_history_json),
    marketing_inputs_from_ar: parseJsonObject(s.marketing_inputs_from_ar_json),
    marketing_links: parseJsonObject(s.marketing_links_json),
    marketing_assets: parseJsonObject(s.marketing_assets_json),
    marketing_readiness: parseJsonObject(s.marketing_readiness_json),
    last_outreach: parseJsonObject(s.last_outreach_json),
    is_test: Boolean(s.is_test),
    single_priority: s.single_priority == null ? null : Number(s.single_priority),
    single_custom_video_requested: Boolean(s.single_custom_video_requested),
  };
}

// ─────────────────────────────────────────────
// IDEAS
// ─────────────────────────────────────────────

export function createIdea(idea) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = idea.id || `IDEA_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(`
    INSERT INTO ideas
      (id, created_at, updated_at, status, title, concept, hook, target_age_range,
       category, mood, educational_angle, tags, lyric_seed, thumbnail_seed,
       notes, source_type, source_ref, promoted_song_id, brand_profile_id)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, now, now,
    idea.status || 'new',
    idea.title,
    idea.concept || null,
    idea.hook || null,
    idea.target_age_range || DEFAULT_AUDIENCE_RANGE,
    idea.category || null,
    idea.mood || null,
    idea.educational_angle || null,
    idea.tags ? JSON.stringify(idea.tags) : null,
    idea.lyric_seed || null,
    idea.thumbnail_seed || null,
    idea.notes || null,
    idea.source_type || 'manual',
    idea.source_ref || null,
    idea.promoted_song_id || null,
    idea.brand_profile_id || null
  );
  return id;
}

export function updateIdea(id, fields) {
  const db = getDb();
  const now = new Date().toISOString();
  const allowed = [
    'status', 'title', 'concept', 'hook', 'target_age_range', 'category',
    'mood', 'educational_angle', 'tags', 'lyric_seed', 'thumbnail_seed',
    'notes', 'source_type', 'source_ref', 'promoted_song_id', 'brand_profile_id',
  ];
  const updates = { updated_at: now };
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates[key] = key === 'tags' && Array.isArray(fields[key])
        ? JSON.stringify(fields[key])
        : fields[key];
    }
  }
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE ideas SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), id);
}

export function deleteIdea(id) {
  const result = getDb().prepare('DELETE FROM ideas WHERE id = ?').run(id);
  return result.changes;
}

export function deleteIdeas(ids) {
  const uniqueIds = [...new Set((ids || [])
    .map(id => String(id || '').trim())
    .filter(Boolean))];

  const db = getDb();
  const deleteOne = db.prepare('DELETE FROM ideas WHERE id = ?');
  const deleteMany = db.transaction((ideaIds) => {
    let deleted = 0;
    for (const id of ideaIds) deleted += deleteOne.run(id).changes;
    return deleted;
  });

  return deleteMany(uniqueIds);
}

export function getIdea(id) {
  return parseIdea(getDb().prepare('SELECT * FROM ideas WHERE id = ?').get(id));
}

export function getAllIdeas() {
  return getDb().prepare('SELECT * FROM ideas ORDER BY created_at DESC').all().map(parseIdea);
}

function parseIdea(i) {
  if (!i) return null;
  return { ...i, tags: parseJsonArray(i.tags) };
}

function stringifyOptionalJson(value) {
  return value && typeof value === 'object' ? JSON.stringify(value) : null;
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────
// ASSETS
// ─────────────────────────────────────────────

export function createAsset(asset) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = `ASSET_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  // If is_current, mark existing assets of same type as not current
  if (asset.is_current !== false) {
    db.prepare(`UPDATE assets SET is_current = 0 WHERE song_id = ? AND asset_type = ?`).run(asset.song_id, asset.asset_type);
  }

  db.prepare(`
    INSERT INTO assets
      (id, song_id, created_at, updated_at, asset_type, label, version, file_path, mime_type, text_content, is_current, notes)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, asset.song_id, now, now,
    asset.asset_type, asset.label || null,
    asset.version || 1,
    asset.file_path || null,
    asset.mime_type || null,
    asset.text_content || null,
    asset.is_current !== false ? 1 : 0,
    asset.notes || null
  );
  return id;
}

export function getAssetsForSong(songId) {
  return getDb().prepare('SELECT * FROM assets WHERE song_id = ? ORDER BY asset_type, version DESC').all(songId);
}

// ─────────────────────────────────────────────
// PUBLISHING CHECKLIST
// ─────────────────────────────────────────────

const PUBLISHING_CHECKLIST_ITEMS = [
  { key: 'final_title', label: 'Final song title confirmed' },
  { key: 'primary_artist', label: 'Primary artist name set' },
  { key: 'release_type', label: 'Release type selected (Single / EP / Album)' },
  { key: 'audio_master', label: 'Audio master ready (MP3 192kbps+)' },
  { key: 'cover_art', label: 'Cover art ready (3000×3000 JPG/PNG)' },
  { key: 'lyrics_finalized', label: 'Lyrics finalized and proofread' },
  { key: 'metadata_finalized', label: 'Metadata finalized (title, genre, tags)' },
  { key: 'genre_subgenre', label: 'Genre and subgenre assigned' },
  { key: 'release_date', label: 'Release date selected (Friday recommended)' },
  { key: 'youtube_assets', label: 'YouTube thumbnail and description ready' },
  { key: 'spotify_pitch', label: 'Spotify pitch notes written' },
  { key: 'audience_compliance', label: 'Audience and content compliance review complete' },
  { key: 'uploaded_distributor', label: `Uploaded to ${DEFAULT_DISTRIBUTOR || 'distributor'}` },
  { key: 'distributor_date', label: 'Distributor submission date recorded' },
  { key: 'store_links', label: 'Store links captured after going live' },
  { key: 'published_confirmed', label: 'Published confirmed on all platforms' },
];

export function initPublishingChecklist(songId) {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO publishing_checklist (id, song_id, key, label, status, updated_at)
    VALUES (?, ?, ?, ?, 'not_started', ?)
  `);
  for (const item of PUBLISHING_CHECKLIST_ITEMS) {
    const id = `CL_${songId}_${item.key}`;
    insert.run(id, songId, item.key, item.label, now);
  }
}

export function getPublishingChecklist(songId) {
  const db = getDb();
  // Auto-init if missing
  const existing = db.prepare('SELECT COUNT(*) as c FROM publishing_checklist WHERE song_id = ?').get(songId);
  if (!existing || existing.c === 0) {
    initPublishingChecklist(songId);
  }
  return db.prepare('SELECT * FROM publishing_checklist WHERE song_id = ? ORDER BY rowid').all(songId);
}

export function updateChecklistItem(songId, key, { status, note }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE publishing_checklist SET status = ?, note = ?, updated_at = ? WHERE song_id = ? AND key = ?
  `).run(status, note || null, now, songId, key);
}

export function getChecklistProgress(songId) {
  const items = getPublishingChecklist(songId);
  const done = items.filter(i => i.status === 'done').length;
  return { total: items.length, done, pct: items.length ? Math.round((done / items.length) * 100) : 0 };
}

// ─────────────────────────────────────────────
// RELEASE LINKS
// ─────────────────────────────────────────────

export function upsertReleaseLink(songId, platform, url, externalId = null) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM release_links WHERE song_id = ? AND platform = ?').get(songId, platform);
  if (existing) {
    db.prepare('UPDATE release_links SET url = ?, external_id = ? WHERE id = ?').run(url, externalId, existing.id);
  } else {
    const id = `RL_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    db.prepare('INSERT INTO release_links (id, song_id, platform, url, external_id) VALUES (?, ?, ?, ?, ?)').run(id, songId, platform, url, externalId);
  }
}

export function getReleaseLinks(songId) {
  return getDb().prepare('SELECT * FROM release_links WHERE song_id = ? ORDER BY platform').all(songId);
}

// ─────────────────────────────────────────────
// RELEASE COCKPIT LOGS
// ─────────────────────────────────────────────

export function addReleaseCockpitLog({ releaseType, releaseId, action, status = 'info', message = '', payload = null }) {
  const db = getDb();
  const id = `RLOG_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(`
    INSERT INTO release_cockpit_logs
      (id, release_type, release_id, action, status, message, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normalizeReleaseCockpitType(releaseType),
    String(releaseId || ''),
    String(action || 'event'),
    String(status || 'info'),
    String(message || ''),
    stringifyOptionalJson(payload),
    new Date().toISOString(),
  );
  return getReleaseCockpitLogs(releaseType, releaseId, { limit: 1 })[0] || null;
}

export function getReleaseCockpitLogs(releaseType, releaseId, { limit = 50 } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 50, 200));
  return getDb().prepare(`
    SELECT * FROM release_cockpit_logs
    WHERE release_type = ? AND release_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(normalizeReleaseCockpitType(releaseType), String(releaseId || ''), max).map(row => ({
    ...row,
    payload: parseJsonObject(row.payload_json),
  }));
}

// ─────────────────────────────────────────────
// RELEASE CAMPAIGNS
// ─────────────────────────────────────────────

export function upsertReleaseCampaign(input = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = input.id
    ? getReleaseCampaignById(input.id)
    : getReleaseCampaignByRelease(input.release_type, input.release_id);
  const record = {
    id: existing?.id || input.id || `RCAMP_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    release_type: normalizeReleaseCockpitType(input.release_type),
    release_id: String(input.release_id || existing?.release_id || ''),
    title: input.title || existing?.title || input.release_id || 'Release campaign',
    release_date: input.release_date ?? existing?.release_date ?? null,
    status: input.status || existing?.status || 'draft',
    lifecycle_state: input.lifecycle_state || existing?.lifecycle_state || 'planned',
    current_gate: input.current_gate ?? existing?.current_gate ?? null,
    campaign_plan_json: stringifyOptionalJson(input.campaign_plan ?? existing?.campaign_plan ?? {}),
    context_json: stringifyOptionalJson(input.context ?? existing?.context ?? {}),
    links_json: stringifyOptionalJson(input.links ?? existing?.links ?? {}),
    asset_selection_json: stringifyOptionalJson(input.asset_selection ?? existing?.asset_selection ?? {}),
    run_summary_json: stringifyOptionalJson(input.run_summary ?? existing?.run_summary ?? {}),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO release_campaigns
      (id, release_type, release_id, title, release_date, status, lifecycle_state, current_gate,
       campaign_plan_json, context_json, links_json, asset_selection_json, run_summary_json, created_at, updated_at)
    VALUES
      (@id, @release_type, @release_id, @title, @release_date, @status, @lifecycle_state, @current_gate,
       @campaign_plan_json, @context_json, @links_json, @asset_selection_json, @run_summary_json, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      release_date = excluded.release_date,
      status = excluded.status,
      lifecycle_state = excluded.lifecycle_state,
      current_gate = excluded.current_gate,
      campaign_plan_json = excluded.campaign_plan_json,
      context_json = excluded.context_json,
      links_json = excluded.links_json,
      asset_selection_json = excluded.asset_selection_json,
      run_summary_json = excluded.run_summary_json,
      updated_at = excluded.updated_at
  `).run(record);
  return getReleaseCampaignById(record.id);
}

export function getReleaseCampaignById(id) {
  return parseReleaseCampaign(getDb().prepare('SELECT * FROM release_campaigns WHERE id = ?').get(id));
}

export function getReleaseCampaignByRelease(releaseType, releaseId) {
  return parseReleaseCampaign(getDb().prepare('SELECT * FROM release_campaigns WHERE release_type = ? AND release_id = ?').get(
    normalizeReleaseCockpitType(releaseType),
    String(releaseId || ''),
  ));
}

export function listReleaseCampaigns() {
  return getDb().prepare('SELECT * FROM release_campaigns ORDER BY updated_at DESC, created_at DESC').all().map(parseReleaseCampaign);
}

export function upsertReleaseCampaignTask(input = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = input.id
    ? getReleaseCampaignTaskById(input.id)
    : getReleaseCampaignTaskByKey(input.campaign_id, input.task_key);
  const status = input.status || existing?.status || 'pending';
  const record = {
    id: existing?.id || input.id || `RCTASK_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    campaign_id: String(input.campaign_id || existing?.campaign_id || ''),
    task_key: String(input.task_key || existing?.task_key || ''),
    title: input.title || existing?.title || input.task_key || 'Release task',
    description: input.description ?? existing?.description ?? null,
    owner: input.owner || existing?.owner || 'agent',
    status,
    due_date: input.due_date ?? existing?.due_date ?? null,
    offset_days: input.offset_days == null ? (existing?.offset_days ?? null) : Number(input.offset_days),
    depends_on_json: JSON.stringify(input.depends_on ?? existing?.depends_on ?? []),
    blocking: input.blocking == null ? (existing?.blocking ? 1 : 0) : (input.blocking ? 1 : 0),
    action_url: input.action_url ?? existing?.action_url ?? null,
    result_json: stringifyOptionalJson(input.result ?? existing?.result ?? {}),
    result_path: input.result_path ?? existing?.result_path ?? null,
    source_workflow_id: input.source_workflow_id ?? existing?.source_workflow_id ?? null,
    source_run_id: input.source_run_id ?? existing?.source_run_id ?? null,
    next_follow_up_date: input.next_follow_up_date ?? existing?.next_follow_up_date ?? null,
    related_item_id: input.related_item_id ?? existing?.related_item_id ?? null,
    reason: input.reason ?? existing?.reason ?? null,
    suggested_action: input.suggested_action ?? existing?.suggested_action ?? null,
    created_at: existing?.created_at || now,
    updated_at: now,
    completed_at: input.completed_at ?? (status === 'complete' ? (existing?.completed_at || now) : null),
  };
  db.prepare(`
    INSERT INTO release_campaign_tasks
      (id, campaign_id, task_key, title, description, owner, status, due_date, offset_days, depends_on_json,
       blocking, action_url, result_json, result_path, source_workflow_id, source_run_id, next_follow_up_date,
       related_item_id, reason, suggested_action, created_at, updated_at, completed_at)
    VALUES
      (@id, @campaign_id, @task_key, @title, @description, @owner, @status, @due_date, @offset_days, @depends_on_json,
       @blocking, @action_url, @result_json, @result_path, @source_workflow_id, @source_run_id, @next_follow_up_date,
       @related_item_id, @reason, @suggested_action, @created_at, @updated_at, @completed_at)
    ON CONFLICT(campaign_id, task_key) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      owner = excluded.owner,
      status = excluded.status,
      due_date = excluded.due_date,
      offset_days = excluded.offset_days,
      depends_on_json = excluded.depends_on_json,
      blocking = excluded.blocking,
      action_url = excluded.action_url,
      result_json = excluded.result_json,
      result_path = excluded.result_path,
      source_workflow_id = excluded.source_workflow_id,
      source_run_id = excluded.source_run_id,
      next_follow_up_date = excluded.next_follow_up_date,
      related_item_id = excluded.related_item_id,
      reason = excluded.reason,
      suggested_action = excluded.suggested_action,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at
  `).run(record);
  return getReleaseCampaignTaskById(record.id);
}

export function getReleaseCampaignTaskById(id) {
  return parseReleaseCampaignTask(getDb().prepare('SELECT * FROM release_campaign_tasks WHERE id = ?').get(id));
}

export function getReleaseCampaignTaskByKey(campaignId, taskKey) {
  return parseReleaseCampaignTask(getDb().prepare('SELECT * FROM release_campaign_tasks WHERE campaign_id = ? AND task_key = ?').get(
    String(campaignId || ''),
    String(taskKey || ''),
  ));
}

export function listReleaseCampaignTasks(campaignId) {
  return getDb()
    .prepare('SELECT * FROM release_campaign_tasks WHERE campaign_id = ? ORDER BY COALESCE(due_date, created_at) ASC, created_at ASC')
    .all(String(campaignId || ''))
    .map(parseReleaseCampaignTask);
}

export function getReadyReleaseCampaignTasks({ nowIso = new Date().toISOString() } = {}) {
  return getDb()
    .prepare(`
      SELECT * FROM release_campaign_tasks
      WHERE status IN ('ready', 'needs_ken')
         OR (status = 'pending' AND (due_date IS NULL OR due_date <= ?))
      ORDER BY COALESCE(due_date, created_at) ASC, created_at ASC
    `)
    .all(nowIso)
    .map(parseReleaseCampaignTask);
}

export function addReleaseCampaignRun(input = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id || `RCRUN_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(`
    INSERT INTO release_campaign_runs
      (id, campaign_id, task_id, workflow_id, run_id, status, package_path, result_path, stdout_path, stderr_path, log_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(input.campaign_id || ''),
    input.task_id || null,
    input.workflow_id || null,
    input.run_id || null,
    input.status || 'running',
    input.package_path || null,
    input.result_path || null,
    input.stdout_path || null,
    input.stderr_path || null,
    stringifyOptionalJson(input.log || {}),
    now,
    now,
  );
  return getReleaseCampaignRunById(id);
}

export function updateReleaseCampaignRun(id, patch = {}) {
  const existing = getReleaseCampaignRunById(id);
  if (!existing) throw new Error(`Release campaign run not found: ${id}`);
  getDb().prepare(`
    UPDATE release_campaign_runs
    SET workflow_id = ?, run_id = ?, status = ?, package_path = ?, result_path = ?, stdout_path = ?, stderr_path = ?, log_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.workflow_id ?? existing.workflow_id,
    patch.run_id ?? existing.run_id,
    patch.status ?? existing.status,
    patch.package_path ?? existing.package_path,
    patch.result_path ?? existing.result_path,
    patch.stdout_path ?? existing.stdout_path,
    patch.stderr_path ?? existing.stderr_path,
    stringifyOptionalJson(patch.log ?? existing.log ?? {}),
    new Date().toISOString(),
    id,
  );
  return getReleaseCampaignRunById(id);
}

export function getReleaseCampaignRunById(id) {
  return parseReleaseCampaignRun(getDb().prepare('SELECT * FROM release_campaign_runs WHERE id = ?').get(id));
}

export function listReleaseCampaignRuns(campaignId) {
  return getDb()
    .prepare('SELECT * FROM release_campaign_runs WHERE campaign_id = ? ORDER BY created_at DESC')
    .all(String(campaignId || ''))
    .map(parseReleaseCampaignRun);
}

// ─────────────────────────────────────────────
// RELEASE BROWSY RECORDINGS
// ─────────────────────────────────────────────

export function createReleaseBrowsyRecording(input = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id || `RBREC_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(`
    INSERT INTO release_browsy_recordings
      (id, campaign_id, task_id, task_key, release_type, release_id, workflow_id, workflow_ref,
       recording_session_id, recording_status, wizard_url, recorder_url, browsy_base_url,
       contract_snapshot_json, contract_completeness_json, imported_workflow_ref, imported_at,
       started_at, launched_at, stopped_at, last_error, created_at, updated_at)
    VALUES
      (@id, @campaign_id, @task_id, @task_key, @release_type, @release_id, @workflow_id, @workflow_ref,
       @recording_session_id, @recording_status, @wizard_url, @recorder_url, @browsy_base_url,
       @contract_snapshot_json, @contract_completeness_json, @imported_workflow_ref, @imported_at,
       @started_at, @launched_at, @stopped_at, @last_error, @created_at, @updated_at)
  `).run({
    id,
    campaign_id: String(input.campaign_id || ''),
    task_id: input.task_id || null,
    task_key: String(input.task_key || ''),
    release_type: input.release_type || null,
    release_id: input.release_id || null,
    workflow_id: input.workflow_id || null,
    workflow_ref: input.workflow_ref || null,
    recording_session_id: input.recording_session_id || null,
    recording_status: input.recording_status || 'setup_ready',
    wizard_url: input.wizard_url || null,
    recorder_url: input.recorder_url || null,
    browsy_base_url: input.browsy_base_url || null,
    contract_snapshot_json: stringifyOptionalJson(input.contract_snapshot ?? null),
    contract_completeness_json: stringifyOptionalJson(input.contract_completeness ?? null),
    imported_workflow_ref: input.imported_workflow_ref || null,
    imported_at: input.imported_at || null,
    started_at: input.started_at || now,
    launched_at: input.launched_at || null,
    stopped_at: input.stopped_at || null,
    last_error: input.last_error || null,
    created_at: now,
    updated_at: now,
  });
  return getReleaseBrowsyRecording(id);
}

export function updateReleaseBrowsyRecording(id, patch = {}) {
  const existing = getReleaseBrowsyRecording(id);
  if (!existing) throw new Error(`Release Browsy recording not found: ${id}`);
  const merged = {
    recording_status: patch.recording_status ?? existing.recording_status,
    workflow_id: patch.workflow_id ?? existing.workflow_id,
    workflow_ref: patch.workflow_ref ?? existing.workflow_ref,
    recording_session_id: patch.recording_session_id ?? existing.recording_session_id,
    wizard_url: patch.wizard_url ?? existing.wizard_url,
    recorder_url: patch.recorder_url ?? existing.recorder_url,
    browsy_base_url: patch.browsy_base_url ?? existing.browsy_base_url,
    contract_snapshot_json: patch.contract_snapshot !== undefined
      ? stringifyOptionalJson(patch.contract_snapshot)
      : existing.contract_snapshot_json,
    contract_completeness_json: patch.contract_completeness !== undefined
      ? stringifyOptionalJson(patch.contract_completeness)
      : existing.contract_completeness_json,
    imported_workflow_ref: patch.imported_workflow_ref ?? existing.imported_workflow_ref,
    imported_at: patch.imported_at ?? existing.imported_at,
    started_at: patch.started_at ?? existing.started_at,
    launched_at: patch.launched_at ?? existing.launched_at,
    stopped_at: patch.stopped_at ?? existing.stopped_at,
    last_error: patch.last_error !== undefined ? patch.last_error : existing.last_error,
    updated_at: new Date().toISOString(),
    id,
  };
  getDb().prepare(`
    UPDATE release_browsy_recordings SET
      recording_status = @recording_status,
      workflow_id = @workflow_id,
      workflow_ref = @workflow_ref,
      recording_session_id = @recording_session_id,
      wizard_url = @wizard_url,
      recorder_url = @recorder_url,
      browsy_base_url = @browsy_base_url,
      contract_snapshot_json = @contract_snapshot_json,
      contract_completeness_json = @contract_completeness_json,
      imported_workflow_ref = @imported_workflow_ref,
      imported_at = @imported_at,
      started_at = @started_at,
      launched_at = @launched_at,
      stopped_at = @stopped_at,
      last_error = @last_error,
      updated_at = @updated_at
    WHERE id = @id
  `).run(merged);
  return getReleaseBrowsyRecording(id);
}

export function getReleaseBrowsyRecording(id) {
  return parseReleaseBrowsyRecording(getDb().prepare('SELECT * FROM release_browsy_recordings WHERE id = ?').get(String(id || '')));
}

export function getLatestReleaseBrowsyRecordingForTask(campaignId, taskKey) {
  return parseReleaseBrowsyRecording(getDb().prepare(`
    SELECT * FROM release_browsy_recordings
    WHERE campaign_id = ? AND task_key = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(String(campaignId || ''), String(taskKey || '')));
}

export function listReleaseBrowsyRecordingsForCampaign(campaignId) {
  return getDb()
    .prepare('SELECT * FROM release_browsy_recordings WHERE campaign_id = ? ORDER BY created_at DESC')
    .all(String(campaignId || ''))
    .map(parseReleaseBrowsyRecording);
}

// ─────────────────────────────────────────────
// VISUAL LIBRARY
// ─────────────────────────────────────────────

export function createVisualLibraryAsset(input = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id || `VIS_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  db.prepare(`
    INSERT INTO visual_library_assets
      (id, file_path, asset_type, aspect_ratio, duration_seconds, character_tags_json, scene_tags_json, mood_tags_json,
       album_tags_json, song_tags_json, loopable, safe_for_kids, source, rights_status, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(input.file_path || ''),
    input.asset_type || 'image',
    input.aspect_ratio || null,
    input.duration_seconds == null ? null : Number(input.duration_seconds),
    JSON.stringify(input.character_tags || []),
    JSON.stringify(input.scene_tags || []),
    JSON.stringify(input.mood_tags || []),
    JSON.stringify(input.album_tags || []),
    JSON.stringify(input.song_tags || []),
    input.loopable ? 1 : 0,
    input.safe_for_kids !== false ? 1 : 0,
    input.source || 'manual',
    input.rights_status || 'owned_generated',
    stringifyOptionalJson(input.metadata || {}),
    now,
    now,
  );
  return getVisualLibraryAsset(id);
}

export function getVisualLibraryAsset(id) {
  return parseVisualLibraryAsset(getDb().prepare('SELECT * FROM visual_library_assets WHERE id = ?').get(id));
}

export function listVisualLibraryAssets() {
  return getDb().prepare('SELECT * FROM visual_library_assets ORDER BY created_at DESC').all().map(parseVisualLibraryAsset);
}

export function recordVisualLibraryUsage(input = {}) {
  const id = input.id || `VISUSE_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO visual_library_usage
      (id, asset_id, release_type, release_id, song_id, platform, usage_context, used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(input.asset_id || ''),
    normalizeReleaseCockpitType(input.release_type),
    String(input.release_id || ''),
    input.song_id || null,
    input.platform || null,
    input.usage_context || null,
    input.used_at || new Date().toISOString(),
  );
  return getDb().prepare('SELECT * FROM visual_library_usage WHERE id = ?').get(id);
}

function normalizeReleaseCockpitType(value) {
  return String(value || '').toLowerCase() === 'album' ? 'album' : 'single';
}

// ─────────────────────────────────────────────
// PERFORMANCE SNAPSHOTS
// ─────────────────────────────────────────────

export function addPerformanceSnapshot({ songId, platform, metrics }) {
  const db = getDb();
  const id = `SNAP_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const now = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO performance_snapshots (id, song_id, platform, snapshot_date, metrics_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, songId, platform, now, JSON.stringify(metrics));
}

export function getPerformanceSnapshots(songId) {
  return getDb().prepare('SELECT * FROM performance_snapshots WHERE song_id = ? ORDER BY snapshot_date DESC').all(songId).map(s => ({
    ...s,
    metrics: JSON.parse(s.metrics_json || '{}'),
  }));
}

// ─────────────────────────────────────────────
// EXISTING HELPERS (unchanged)
// ─────────────────────────────────────────────

export function getTotalCosts() {
  const db = getDb();
  const totals = db.prepare(`
    SELECT
      SUM(cost_usd) as total_cost,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_runs,
      SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failed_runs
    FROM runs
  `).get();

  const byAgent = db.prepare(`
    SELECT
      agent_name,
      SUM(cost_usd) as cost,
      COUNT(*) as runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_runs,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens
    FROM runs
    GROUP BY agent_name
    ORDER BY cost DESC
  `).all();

  const dailyCosts = db.prepare(`
    SELECT
      DATE(timestamp) as date,
      SUM(cost_usd) as cost,
      COUNT(*) as runs
    FROM runs
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `).all();

  return { totals, byAgent, dailyCosts };
}

export function getRunHistory(limit = 50) {
  return getDb().prepare('SELECT * FROM runs ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function upsertServiceResearch(service) {
  const db = getDb();
  const id = `svc_${service.service_name.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;
  db.prepare(`
    INSERT OR REPLACE INTO service_research
      (id, researched_at, service_name, free_tier, cost_per_song_usd, api_available, notes, recommended)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    new Date().toISOString(),
    service.service_name,
    service.free_tier || null,
    service.cost_per_song_usd || 0,
    service.api_available ? 1 : 0,
    service.notes || null,
    service.recommended ? 1 : 0
  );
}

export function getServiceResearch() {
  return getDb().prepare('SELECT * FROM service_research ORDER BY researched_at DESC').all();
}

// ─────────────────────────────────────────────
// DASHBOARD STATS
// ─────────────────────────────────────────────

export function getDashboardStats() {
  const db = getDb();
  const ideas = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'shortlisted' THEN 1 ELSE 0 END) as shortlisted,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count
    FROM ideas
  `).get();

  const songs = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('${SONG_STATUSES.DRAFT}','${SONG_STATUSES.EDITING}') THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = '${SONG_STATUSES.SUBMITTED_TO_DISTROKID}' THEN 1 ELSE 0 END) as ready,
      SUM(CASE WHEN status = '${SONG_STATUSES.OUTREACH_COMPLETE}' THEN 1 ELSE 0 END) as published
    FROM songs
  `).get();

  return { ideas, songs };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function parseReleaseCampaign(row) {
  if (!row) return null;
  return {
    ...row,
    campaign_plan: parseJsonObject(row.campaign_plan_json),
    context: parseJsonObject(row.context_json),
    links: parseJsonObject(row.links_json),
    asset_selection: parseJsonObject(row.asset_selection_json),
    run_summary: parseJsonObject(row.run_summary_json),
  };
}

function parseReleaseCampaignTask(row) {
  if (!row) return null;
  return {
    ...row,
    depends_on: parseJsonArray(row.depends_on_json),
    blocking: Boolean(row.blocking),
    result: parseJsonObject(row.result_json),
  };
}

function parseReleaseCampaignRun(row) {
  if (!row) return null;
  return {
    ...row,
    log: parseJsonObject(row.log_json),
  };
}

function parseReleaseBrowsyRecording(row) {
  if (!row) return null;
  return {
    ...row,
    contract_snapshot: parseJsonObject(row.contract_snapshot_json),
    contract_completeness: parseJsonObject(row.contract_completeness_json),
  };
}

function parseVisualLibraryAsset(row) {
  if (!row) return null;
  return {
    ...row,
    duration_seconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    character_tags: parseJsonArray(row.character_tags_json),
    scene_tags: parseJsonArray(row.scene_tags_json),
    mood_tags: parseJsonArray(row.mood_tags_json),
    album_tags: parseJsonArray(row.album_tags_json),
    song_tags: parseJsonArray(row.song_tags_json),
    loopable: Boolean(row.loopable),
    safe_for_kids: Boolean(row.safe_for_kids),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function parseJsonArray(val) {
  if (!val) return [];
  try { return JSON.parse(val); } catch { return []; }
}
