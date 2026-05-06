import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isTestOrDemoTarget } from './marketing-outlet-health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const nodeBin = process.execPath;

test('isTestOrDemoTarget flags obvious test/demo rows', () => {
  assert.equal(isTestOrDemoTarget({
    name: 'Family Playlist Test',
    contact_email: 'editor@familyplaylist.example',
    source_url: 'https://familyplaylist.example',
  }), true);

  assert.equal(isTestOrDemoTarget({
    name: 'Spare the Rock, Spoil the Child',
    contact_email: 'show@sparetherock.com',
    source_url: 'https://sparetherock.com/wordpress/',
  }), false);
});

test('seed imports the outlet source into a temp DB and doctor passes', () => {
  const slug = `marketing-outlets-test-${Date.now()}`;
  const dbPath = path.join(repoRoot, `${slug}.db`);
  const env = { ...process.env, PIPELINE_APP_SLUG: slug };

  try {
    execFileSync(nodeBin, ['src/scripts/seed-marketing-outlets-to-targets.js'], {
      cwd: repoRoot,
      env,
      stdio: 'pipe',
    });

    const count = Number(execFileSync('sqlite3', [dbPath, "select count(*) from marketing_targets where brand_profile_id = 'default';"], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim());
    assert.ok(count >= 30, `expected at least 30 active-brand outlets, got ${count}`);

    const testRows = Number(execFileSync('sqlite3', [dbPath, "select count(*) from marketing_targets where lower(name) like '%test%' or lower(contact_email) like '%.example%' or lower(source_url) like '%example%';"], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim());
    assert.equal(testRows, 0);

    execFileSync(nodeBin, ['src/scripts/doctor-marketing-outlets.js'], {
      cwd: repoRoot,
      env,
      stdio: 'pipe',
    });
  } finally {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
    try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
  }
});
