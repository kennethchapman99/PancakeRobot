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

function parseLastNumberFromOutput(output) {
  const cleaned = String(output ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const matches = cleaned.match(/(?:^|[^0-9])([0-9]+)(?=[^0-9]*$)/m);
  if (matches?.[1]) return Number(matches[1]);

  const fallbackMatches = cleaned.match(/[0-9]+/g) || [];
  return fallbackMatches.length ? Number(fallbackMatches.at(-1)) : NaN;
}

test('parseLastNumberFromOutput handles invisible terminal characters', () => {
  assert.equal(parseLastNumberFromOutput('\u001b[32m50\u001b[0m\n'), 50);
  assert.equal(parseLastNumberFromOutput('\uFEFF50\n'), 50);
  assert.equal(parseLastNumberFromOutput('setup log\n50\u200B\n'), 50);
});

test('isTestOrDemoTarget flags obvious test/demo rows', () => {
  assert.equal(isTestOrDemoTarget({
    name: 'Family Playlist Test',
    contact_email: 'editor@familyplaylist.example',
    source_url: 'https://familyplaylist.example',
  }), true);

  assert.equal(isTestOrDemoTarget({
    name: 'Kenneth D2L Test Outlet',
    contact_email: 'kenneth@d2l.com',
    source_url: 'https://d2l.com/',
    raw_json: { isTestOutlet: true, internal_test: true },
  }), false);

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
    execFileSync(nodeBin, ['src/scripts/seed-marketing-outlets-to-targets.js', '--brand', 'default'], {
      cwd: repoRoot,
      env,
      stdio: 'pipe',
    });

    const count = Number(execFileSync('sqlite3', [dbPath, "select count(*) from marketing_targets where brand_profile_id = 'default';"], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim());
    assert.ok(count >= 30, `expected at least 30 active-brand outlets, got ${count}`);

    const testRows = Number(execFileSync('sqlite3', [dbPath, "select count(*) from marketing_targets where ((lower(name) like '%test%' and id != 'test_kenneth_d2l') or lower(contact_email) like '%.example%' or lower(source_url) like '%example%');"], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim());
    assert.equal(testRows, 0);

    const kennethRow = Number(execFileSync('sqlite3', [dbPath, "select count(*) from marketing_targets where id = 'test_kenneth_d2l' and contact_email = 'kenneth@d2l.com';"], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim());
    assert.equal(kennethRow, 1);

    execFileSync(nodeBin, [
      '--input-type=module',
      '-e',
      "import { getMarketingOutletsDiagnostics } from './src/shared/marketing-outlet-health.js'; const diagnostics = getMarketingOutletsDiagnostics({ brandProfileId: 'default' }); if (!diagnostics.ok) { console.error(JSON.stringify(diagnostics, null, 2)); process.exit(1); }",
    ], {
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

test('active brand falls back to canonical outlet rows when only QA data exists', () => {
  const slug = `marketing-outlets-fallback-${Date.now()}`;
  const dbPath = path.join(repoRoot, `${slug}.db`);
  const env = { ...process.env, PIPELINE_APP_SLUG: slug };

  try {
    execFileSync(nodeBin, ['src/scripts/seed-marketing-outlets-to-targets.js'], {
      cwd: repoRoot,
      env,
      stdio: 'pipe',
    });

    const output = execFileSync(nodeBin, [
      '--input-type=module',
      '-e',
      "import { getActiveBrandOutlets } from './src/shared/marketing-outlet-health.js'; console.log(getActiveBrandOutlets({ brandProfileId: 'gravl-brand-profile' }).length);",
    ], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    const count = parseLastNumberFromOutput(output);

    assert.ok(Number.isFinite(count), `expected numeric outlet count, got output: ${JSON.stringify(output)}`);
    assert.ok(count >= 30, `expected canonical fallback outlets for gravl-brand-profile, got ${count}`);
  } finally {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
    try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
  }
});
