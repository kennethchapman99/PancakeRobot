#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

import { getDb, getDbPath } from '../src/shared/db.js';
import { purgeReleaseCockpitTestData } from '../src/shared/release-cockpit-test-data-cleanup.js';

const apply = process.argv.includes('--apply') || process.argv.includes('--yes');
const dbPath = getDbPath();
const db = getDb();

if (!fs.existsSync(dbPath)) {
  console.error(`[release-cockpit-cleanup] Database not found: ${dbPath}`);
  process.exit(1);
}

try {
  db.pragma('wal_checkpoint(FULL)');
} catch {
  // Non-fatal: older/local SQLite states may not need a WAL checkpoint.
}

let backupPath = null;
if (apply) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  backupPath = `${dbPath}.backup-release-cockpit-tests-${timestamp}`;
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(dbPath, backupPath);

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, `${backupPath}${suffix}`);
    }
  }
}

const summary = purgeReleaseCockpitTestData(db, { dryRun: !apply });

console.log(JSON.stringify({
  database: dbPath,
  backup_path: backupPath,
  apply_with: apply ? null : './bin/pancakerobot release-cockpit:cleanup-tests --apply',
  ...summary,
}, null, 2));
