#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { getDb, getDbPath } from '../src/shared/db.js';
import { applySongCatalogCleanup } from '../src/shared/song-catalog-cleanup.js';

const dbPath = getDbPath();
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${dbPath}.backup-${timestamp}`;

if (!fs.existsSync(dbPath)) {
  console.error(`[song-catalog-cleanup] Database not found: ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(backupPath), { recursive: true });
fs.copyFileSync(dbPath, backupPath);

const db = getDb();
const summary = applySongCatalogCleanup(db);

console.log(JSON.stringify({
  ok: true,
  database: dbPath,
  backup_path: backupPath,
  ...summary,
}, null, 2));
