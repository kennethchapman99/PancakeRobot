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
    ['marketing_links_json', 'TEXT'],
    ['marketing_assets_json', 'TEXT'],
    ['marketing_readiness_json', 'TEXT'],
    ['last_outreach_json', 'TEXT'],
  ];
  for (const [col, type] of newSongCols) {
    if (!songCols.includes(col)) {
      db.exec(`ALTER TABLE songs ADD COLUMN ${col} ${type}`);
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
      'total_cost_usd', 'brand_profile_id', 'marketing_links_json', 'marketing_assets_json',
      'marketing_readiness_json', 'last_outreach_json', 'is_test',
    ];
    for (const key of patchable) {
      if (song[key] !== undefined && song[key] !== null) {
        updates[key] = key === 'status' ? normalizedStatus : song[key];
      }
    }
    if (song.marketing_links !== undefined) updates.marketing_links_json = stringifyOptionalJson(song.marketing_links);
    if (song.marketing_assets !== undefined) updates.marketing_assets_json = stringifyOptionalJson(song.marketing_assets);
    if (song.marketing_readiness !== undefined) updates.marketing_readiness_json = stringifyOptionalJson(song.marketing_readiness);
    if (song.last_outreach !== undefined) updates.last_outreach_json = stringifyOptionalJson(song.last_outreach);
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
         is_test, marketing_links_json, marketing_assets_json, marketing_readiness_json, last_outreach_json)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      stringifyOptionalJson(song.marketing_links),
      stringifyOptionalJson(song.marketing_assets),
      stringifyOptionalJson(song.marketing_readiness),
      stringifyOptionalJson(song.last_outreach),
    );
  }
}

export function getSong(id) {
  return parseSong(getDb().prepare('SELECT * FROM songs WHERE id = ?').get(id));
}

export function getAllSongs(options = {}) {
  const includeTests = options.includeTests === true;
  const sql = includeTests
    ? 'SELECT * FROM songs ORDER BY created_at DESC'
    : 'SELECT * FROM songs WHERE COALESCE(is_test, 0) = 0 ORDER BY created_at DESC';
  return getDb().prepare(sql).all().map(parseSong);
}

export function updateSongStatus(id, status) {
  const db = getDb();
  db.prepare(`UPDATE songs SET status = ?, updated_at = ? WHERE id = ?`).run(normalizeSongStatus(status), new Date().toISOString(), id);
}

export function deleteSong(id) {
  const db = getDb();
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
    marketing_links: parseJsonObject(s.marketing_links_json),
    marketing_assets: parseJsonObject(s.marketing_assets_json),
    marketing_readiness: parseJsonObject(s.marketing_readiness_json),
    last_outreach: parseJsonObject(s.last_outreach_json),
    is_test: Boolean(s.is_test),
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

function parseJsonArray(val) {
  if (!val) return [];
  try { return JSON.parse(val); } catch { return []; }
}
