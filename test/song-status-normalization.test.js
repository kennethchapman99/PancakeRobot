import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let sqliteSkipReason = false;
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
} catch (err) {
  sqliteSkipReason = `better-sqlite3 could not load in this Node runtime: ${err.message.split('\n')[0]}`;
}

test('song status helper normalizes legacy values into the approved canonical set', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/shared/song-status.js'), 'utf8');
  assert.match(source, /submitted to DistroKid/);
  assert.match(source, /outreach complete/);
  assert.match(source, /normalizeSongStatus/);
});

test('database layer migrates legacy song statuses safely on startup', { skip: sqliteSkipReason }, () => {
  const slug = `song-status-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const Database = require('better-sqlite3');
      const legacyDb = new Database('${slug}.db');
      legacyDb.exec("CREATE TABLE songs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT, status TEXT)");
      const insert = legacyDb.prepare('INSERT INTO songs (id, created_at, title, status) VALUES (?, ?, ?, ?)');
      insert.run('LEGACY_SUBMITTED', new Date().toISOString(), 'Legacy Submitted', 'submitted_to_distributor');
      insert.run('LEGACY_APPROVED', new Date().toISOString(), 'Legacy Approved', 'approved');
      insert.run('LEGACY_PUBLISHED', new Date().toISOString(), 'Legacy Published', 'published');
      legacyDb.close();

      const { getDb, getSong, getAllSongs } = await import('./src/shared/db.js');
      const db = getDb();

      const submitted = getSong('LEGACY_SUBMITTED');
      const approved = getSong('LEGACY_APPROVED');
      const published = getSong('LEGACY_PUBLISHED');

      assert.equal(submitted.status, 'submitted to DistroKid');
      assert.equal(approved.status, 'draft');
      assert.equal(published.status, 'draft');

      const allowed = new Set(['draft', 'editing', 'archived', 'submitted to DistroKid', 'outreach complete']);
      for (const song of getAllSongs({ includeTests: true })) {
        assert.ok(allowed.has(song.status), 'Unexpected status: ' + song.status);
      }

      console.log('OK');
    `], {
      cwd: repoRoot,
      env: { ...process.env, PIPELINE_APP_SLUG: slug },
      encoding: 'utf8',
    });

    assert.match(output, /OK/);
  } finally {
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      fs.rmSync(path.join(repoRoot, `${slug}${suffix}`), { force: true });
    }
  }
});

test('fresh song writes normalize invalid statuses into the canonical set', { skip: sqliteSkipReason }, () => {
  const slug = `song-status-writes-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { getSong, upsertSong } from './src/shared/db.js';

      upsertSong({ id: 'MANUAL_EDIT', title: 'Editing Song', status: 'editing' });
      upsertSong({ id: 'MANUAL_BAD', title: 'Bad Song', status: 'totally_invalid' });
      upsertSong({ id: 'MANUAL_SUBMITTED', title: 'Submitted Song', status: 'submitted_to_distributor' });
      upsertSong({ id: 'MANUAL_TUNECORE', title: 'Legacy TuneCore Song', status: 'submitted_to_tunecore' });

      assert.equal(getSong('MANUAL_EDIT').status, 'editing');
      assert.equal(getSong('MANUAL_BAD').status, 'draft');
      assert.equal(getSong('MANUAL_SUBMITTED').status, 'submitted to DistroKid');
      assert.equal(getSong('MANUAL_TUNECORE').status, 'submitted to DistroKid');
      console.log('OK');
    `], {
      cwd: repoRoot,
      env: { ...process.env, PIPELINE_APP_SLUG: slug },
      encoding: 'utf8',
    });

    assert.match(output, /OK/);
  } finally {
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      fs.rmSync(path.join(repoRoot, `${slug}${suffix}`), { force: true });
    }
  }
});
