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

test('bulk delete route and UI are wired to permanent idea deletion', () => {
  const dbSource = fs.readFileSync(path.join(repoRoot, 'src/shared/db.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(repoRoot, 'src/web/server.js'), 'utf8');
  const viewSource = fs.readFileSync(path.join(repoRoot, 'src/web/views/ideas/index.ejs'), 'utf8');

  assert.match(dbSource, /export function deleteIdeas\(ids\)/);
  assert.match(dbSource, /DELETE FROM ideas WHERE id = \?/);
  assert.match(serverSource, /app\.post\('\/api\/ideas\/bulk-delete'/);
  assert.match(serverSource, /deleteIdeas\(ids\)/);
  assert.match(viewSource, /Delete selected/);
  assert.match(viewSource, /\/api\/ideas\/bulk-delete/);
});

test('bulk idea deletion permanently removes selected ideas only', { skip: sqliteSkipReason }, () => {
  const slug = `idea-bulk-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createIdea, deleteIdeas, getAllIdeas, getIdea } from './src/shared/db.js';

      const first = createIdea({ title: 'Delete Me One' });
      const second = createIdea({ title: 'Delete Me Two' });
      const survivor = createIdea({ title: 'Keep Me' });

      assert.equal(getAllIdeas().length, 3);
      const deleted = deleteIdeas([first, second, first, '']);

      assert.equal(deleted, 2);
      assert.equal(getIdea(first), null);
      assert.equal(getIdea(second), null);
      assert.equal(getIdea(survivor).title, 'Keep Me');
      const remaining = getAllIdeas();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, survivor);
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
