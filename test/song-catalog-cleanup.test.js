import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  applySongCatalogCleanup,
  buildSongCatalogCleanupPlan,
  getSongLatestActivityAt,
  isRealSongCatalogRow,
} from '../src/shared/song-catalog-cleanup.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE songs (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      updated_at TEXT,
      title TEXT,
      topic TEXT,
      concept TEXT,
      status TEXT,
      is_test INTEGER DEFAULT 0,
      published_at TEXT,
      distributor_submission_date TEXT,
      release_date TEXT,
      pipeline_stage TEXT,
      notes TEXT,
      last_outreach_json TEXT,
      release_recommendation_json TEXT,
      marketing_readiness_json TEXT,
      marketing_assets_json TEXT
    );
  `);
  return db;
}

test('identifies only real song catalog rows', () => {
  assert.equal(isRealSongCatalogRow({ id: 'SONG_123', title: 'Real Song' }), true);
  assert.equal(isRealSongCatalogRow({ id: 'REL_123', title: 'Release Kit' }), false);
  assert.equal(isRealSongCatalogRow({ id: 'SONG_TEST', title: '' }), false);
  assert.equal(isRealSongCatalogRow({ id: 'SONG_BAD', title: 'Marketing Pack for Song' }), false);
  assert.equal(isRealSongCatalogRow({ id: 'SONG_TEST_ROW', title: 'Test Song', is_test: 1 }), false);
});

test('derives latest activity from song-related fields', () => {
  const latest = getSongLatestActivityAt({
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    last_outreach_json: JSON.stringify({ contacted_at: '2026-01-05T00:00:00.000Z' }),
  });
  assert.equal(latest, '2026-01-05T00:00:00.000Z');
});

test('cleanup plan removes invalid rows and normalizes statuses', () => {
  const plan = buildSongCatalogCleanupPlan([
    { id: 'SONG_GOOD', title: 'Good', status: 'submitted_to_distrokid', created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'ASSET_BAD', title: 'Artwork', status: 'draft' },
    { id: 'SONG_BAD', title: 'Release Kit', status: 'done' },
  ]);

  assert.equal(plan.before, 3);
  assert.equal(plan.after, 1);
  assert.equal(plan.removed, 2);
  assert.deepEqual(plan.statusNormalizations, [{ id: 'SONG_GOOD', from: 'submitted_to_distrokid', to: 'submitted to DistroKid' }]);
});

test('apply cleanup deletes invalid rows, sets latest activity, and installs recurrence guard', () => {
  const db = makeDb();
  const insert = db.prepare(`
    INSERT INTO songs (id, created_at, updated_at, title, status, is_test, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('SONG_KEEP', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 'Keep Me', 'submitted_to_distributor', 0, null);
  insert.run('REL_DROP', '2026-01-01T00:00:00.000Z', null, 'Release Kit', 'draft', 0, null);
  insert.run('SONG_TEST_DROP', '2026-01-01T00:00:00.000Z', null, 'Test Song', 'draft', 1, null);

  const summary = applySongCatalogCleanup(db);

  assert.equal(summary.rows_before, 3);
  assert.equal(summary.valid_song_rows_after, 1);
  assert.equal(summary.invalid_rows_removed, 2);
  assert.equal(summary.statuses_normalized, 1);

  const rows = db.prepare('SELECT id, status, latest_activity_at FROM songs ORDER BY id').all();
  assert.deepEqual(rows, [{
    id: 'SONG_KEEP',
    status: 'submitted to DistroKid',
    latest_activity_at: '2026-01-03T00:00:00.000Z',
  }]);

  assert.throws(() => {
    db.prepare('INSERT INTO songs (id, title, created_at) VALUES (?, ?, ?)').run('ASSET_NEW', 'Asset', '2026-01-01T00:00:00.000Z');
  }, /Invalid song catalog row/);
});
