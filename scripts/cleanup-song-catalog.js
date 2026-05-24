#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { getDb, getDbPath } from '../src/shared/db.js';
import { applySongCatalogCleanup, buildSongCatalogCleanupPlan } from '../src/shared/song-catalog-cleanup.js';

const dbPath = getDbPath();
const apply = process.argv.includes('--apply');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${dbPath}.backup-${timestamp}`;

if (!fs.existsSync(dbPath)) {
  console.error(`[song-catalog-cleanup] Database not found: ${dbPath}`);
  process.exit(1);
}

const db = getDb();
const rows = db.prepare('SELECT * FROM songs ORDER BY created_at DESC').all();
const plan = buildSongCatalogCleanupPlan(rows);

if (!apply) {
  console.log(JSON.stringify({
    ok: true,
    mode: 'dry-run',
    database: dbPath,
    would_remove_or_quarantine: plan.invalid.map(row => ({
      id: row.id,
      title: row.title || null,
      topic: row.topic || null,
      status: row.status || null,
      is_test: Number(row.is_test || 0) === 1,
      pipeline_stage: row.pipeline_stage || null,
    })),
    would_normalize_statuses: plan.statusNormalizations,
    would_update_latest_activity: plan.latestActivityUpdates,
    rows_before: plan.before,
    valid_song_rows_after: plan.after,
    invalid_rows_found: plan.invalid.length,
    apply_with: './bin/pancakerobot cleanup --apply',
  }, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(backupPath), { recursive: true });
fs.copyFileSync(dbPath, backupPath);

const summary = applySongCatalogCleanup(db);

console.log(JSON.stringify({
  ok: true,
  mode: 'apply',
  database: dbPath,
  backup_path: backupPath,
  ...summary,
}, null, 2));
