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

test('song catalog excludes test songs by default but can include them explicitly', { skip: sqliteSkipReason }, () => {
  const slug = `song-catalog-test-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { getDb, upsertSong, getAllSongs, getSong } from './src/shared/db.js';

      getDb();

      upsertSong({
        id: 'SONG_REAL',
        title: 'Real Song',
        topic: 'Real topic',
        status: 'draft',
      });

      upsertSong({
        id: 'SONG_RELEASE_MARKETING_TEST_FIXTURE',
        title: 'Release Marketing Dry Run',
        topic: 'Test release flow',
        status: 'submitted to DistroKid',
        is_test: true,
        notes: 'Created by test-release-marketing-flow.js',
      });

      const visible = getAllSongs();
      const all = getAllSongs({ includeTests: true });

      assert.equal(visible.length, 1);
      assert.equal(visible[0].id, 'SONG_REAL');
      assert.equal(all.length, 2);
      assert.equal(getSong('SONG_RELEASE_MARKETING_TEST_FIXTURE').is_test, true);
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
