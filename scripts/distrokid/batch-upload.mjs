#!/usr/bin/env node
/**
 * Batch DistroKid dry-run uploader.
 *
 * Builds release packages for multiple songs, then runs dry-run uploads
 * one at a time. Stops before final submit for each song. Produces a
 * batch report.
 *
 * Usage:
 *   node scripts/distrokid/batch-upload.mjs --song-ids SONG_1,SONG_2,SONG_3 --dry-run
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs';
import { parseArgs } from 'util';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../');

// ── SAFETY — dry-run is always on ────────────────────────────────
const DRY_RUN_ALWAYS = true;

// ── CLI args ────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'song-ids':     { type: 'string' },
    'dry-run':      { type: 'boolean', default: true },
    'skip-package': { type: 'boolean', default: false },
  },
  strict: false,
});

const rawIds = args['song-ids']
  ? args['song-ids'].split(',').map(s => s.trim()).filter(Boolean)
  : [];

if (rawIds.length === 0) {
  console.error('Error: --song-ids is required');
  console.error('Usage: node scripts/distrokid/batch-upload.mjs --song-ids SONG_1,SONG_2 --dry-run');
  process.exit(1);
}

// ── Run ─────────────────────────────────────────────────────────

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const batchRunDir = join(REPO_ROOT, 'output/release-packages/batch-runs', timestamp);
fs.mkdirSync(batchRunDir, { recursive: true });

console.log(`\n${'═'.repeat(60)}`);
console.log(`DistroKid batch dry-run — ${rawIds.length} song(s)`);
console.log(`[safety] DRY RUN — will NOT submit any song`);
console.log(`Batch report: output/release-packages/batch-runs/${timestamp}/`);
console.log('═'.repeat(60));

const batchResults = [];
const startedAt = new Date().toISOString();

for (let i = 0; i < rawIds.length; i++) {
  const songId = rawIds[i];
  console.log(`\n[${i + 1}/${rawIds.length}] ${songId}`);
  console.log('─'.repeat(40));

  const result = {
    song_id:        songId,
    index:          i + 1,
    package_built:  false,
    upload_run:     false,
    manifest_path:  null,
    ready:          false,
    blocking_fields: [],
    error:          null,
    skipped:        false,
  };

  try {
    // Step 1: build package (unless --skip-package and manifest exists)
    const manifestPath = join(REPO_ROOT, 'output/release-packages', songId, 'manifest.json');
    const packageExists = fs.existsSync(manifestPath);

    if (!packageExists && !args['skip-package']) {
      console.log('  Building release package...');
      execFileSync(process.execPath, [
        join(REPO_ROOT, 'scripts/distrokid/build-release-package.mjs'),
        '--song-id', songId,
      ], { stdio: 'inherit', cwd: REPO_ROOT });
      result.package_built = true;
    } else {
      console.log(packageExists ? '  Package already exists - skipping build' : '  Package missing and --skip-package was set');
      result.package_built = false;
    }

    // Step 2: read manifest
    if (!fs.existsSync(manifestPath)) {
      result.error = 'manifest not found after build';
      batchResults.push(result);
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    result.manifest_path = manifestPath;
    result.ready = manifest.readiness?.ready_for_distrokid_dry_run ?? false;
    result.blocking_fields = manifest.readiness?.blocking_missing_fields ?? [];

    if (!result.ready) {
      console.log(`  ⚠️  Not ready for upload — blocking fields: ${result.blocking_fields.join(', ')}`);
      result.skipped = true;
      batchResults.push(result);
      continue;
    }

    // Step 3: run upload dry-run
    console.log('  Running dry-run upload...');
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'scripts/distrokid/upload-release.mjs'),
      '--manifest', manifestPath,
      '--dry-run',
    ], { stdio: 'inherit', cwd: REPO_ROOT });
    result.upload_run = true;

  } catch (err) {
    result.error = err.message;
    console.error(`  [error] ${err.message}`);
  }

  batchResults.push(result);
}

// ── Write batch report ────────────────────────────────────────────

const finishedAt = new Date().toISOString();

const report = {
  batch_id:    timestamp,
  started_at:  startedAt,
  finished_at: finishedAt,
  dry_run:     DRY_RUN_ALWAYS,
  total:       rawIds.length,
  built:       batchResults.filter(r => r.package_built).length,
  uploaded:    batchResults.filter(r => r.upload_run).length,
  skipped:     batchResults.filter(r => r.skipped).length,
  errors:      batchResults.filter(r => r.error).length,
  results:     batchResults,
};

fs.writeFileSync(
  join(batchRunDir, 'batch-report.json'),
  JSON.stringify(report, null, 2),
  'utf8'
);

// Markdown report
const mdLines = [
  `# DistroKid Batch Run Report`,
  ``,
  `**Batch ID:** ${timestamp}`,
  `**Started:** ${startedAt}`,
  `**Finished:** ${finishedAt}`,
  `**Mode:** DRY RUN (no submissions)`,
  ``,
  `## Summary`,
  ``,
  `| Stat | Count |`,
  `| ---- | ----- |`,
  `| Total songs | ${report.total} |`,
  `| Packages built | ${report.built} |`,
  `| Uploads run | ${report.uploaded} |`,
  `| Skipped (not ready) | ${report.skipped} |`,
  `| Errors | ${report.errors} |`,
  ``,
  `## Per-song results`,
  ``,
  `| # | Song ID | Ready | Upload Run | Skipped | Error |`,
  `| - | ------- | ----- | ---------- | ------- | ----- |`,
  ...batchResults.map(r =>
    `| ${r.index} | ${r.song_id} | ${r.ready ? '✅' : '❌'} | ${r.upload_run ? '✅' : '—'} | ${r.skipped ? '⚠️' : '—'} | ${r.error || '—'} |`
  ),
  ``,
  `## Next steps`,
  ``,
  `For each song that ran successfully:`,
  `1. Review the browser window for that song`,
  `2. Fix any skipped fields manually in DistroKid`,
  `3. Click Submit/Release manually after review`,
  `4. Mark each song as submitted:`,
];

for (const r of batchResults.filter(r => r.upload_run)) {
  mdLines.push(`   \`npm run distrokid:mark-submitted -- --song-id ${r.song_id} --distrokid-url URL\``);
}

mdLines.push('');

fs.writeFileSync(join(batchRunDir, 'batch-report.md'), mdLines.join('\n'), 'utf8');

// ── Print summary ─────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log('Batch run complete');
console.log('═'.repeat(60));
console.log(`  Songs:    ${report.total}`);
console.log(`  Uploaded: ${report.uploaded}`);
console.log(`  Skipped:  ${report.skipped}`);
console.log(`  Errors:   ${report.errors}`);
console.log(`  Report:   output/release-packages/batch-runs/${timestamp}/batch-report.md`);
console.log('');

if (report.errors > 0) process.exit(1);
