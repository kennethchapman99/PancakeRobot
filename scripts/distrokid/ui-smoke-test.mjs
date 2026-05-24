#!/usr/bin/env node

import fs from 'fs';
import { join } from 'path';
import { REPO_ROOT } from './lib.mjs';

let passed = 0;
let failed = 0;

const pkg = readJson('package.json');
const catalog = readText('src/web/views/songs/index.ejs');
const detail = readText('src/web/views/songs/detail.ejs');
const server = readText('src/web/server.js');
const jobs = readText('src/shared/distrokid-jobs.js');

assert(Boolean(pkg.scripts?.['distrokid:save-auth']), 'save auth script exists');
assert(Boolean(pkg.scripts?.['distrokid:check-auth']), 'check auth script exists');
assert(Boolean(pkg.scripts?.['distrokid:package']), 'package script exists');
assert(Boolean(pkg.scripts?.['distrokid:upload']), 'upload script exists');
assert(Boolean(pkg.scripts?.['distrokid:run-queued']), 'run queued script exists');
assert(Boolean(pkg.scripts?.['distrokid:mark-submitted']), 'mark submitted script exists');
assert(Boolean(pkg.scripts?.['distrokid:ui-smoke']), 'UI smoke package script exists');

assert(catalog.includes('x-data="catalog()"'), 'catalog route view is present');
assert(catalog.includes('data-distrokid-bulk-queue'), 'catalog has DistroKid queue bulk control');
assert(catalog.includes('data-distrokid-bulk-clear'), 'catalog has DistroKid clear bulk control');
assert(catalog.includes('toggleAll($event.target.checked)'), 'catalog has select all visible behavior');
assert(catalog.includes('songIds: [...this.selected]'), 'catalog bulk calls send songIds');
assert(catalog.includes('distrokidJobLabel(song.distrokidJob)'), 'catalog renders DistroKid status pill');

assert(detail.includes('Release Status'), 'detail shows release status');
assert(detail.includes('Open Release Cockpit'), 'detail links to Release Cockpit');
assert(detail.includes('actions are managed in the Release Cockpit'), 'detail directs release execution to Cockpit');
assert(!detail.includes('Run Automation Preview'), 'detail does not expose preview action');
assert(!detail.includes('Run Live Submit'), 'detail does not expose live submit action');
assert(!detail.includes('Fetch HyperFollow Link'), 'detail does not expose HyperFollow capture action');
assert(!detail.includes('Build Package'), 'detail does not expose package action');
assert(!detail.includes('Show Dry-Run Upload Command'), 'detail does not expose dry-run command action');
assert(!detail.includes('./bin/pancakerobot distrokid:save-auth'), 'detail does not expose save-auth command');
assert(!detail.includes('./bin/pancakerobot distrokid:check-auth'), 'detail does not expose check-auth command');
assert(!detail.includes('./bin/pancakerobot distrokid:package --song-id'), 'detail does not expose package command');
assert(!detail.includes('./bin/pancakerobot distrokid:upload --manifest'), 'detail does not expose dry-run upload command');
assert(!detail.includes('./bin/pancakerobot distrokid:run-queued --limit 5 --dry-run'), 'detail does not expose run-queued command');

for (const route of [
  "app.post('/api/distrokid/jobs/queue'",
  "app.post('/api/distrokid/jobs/clear'",
  "app.get('/api/distrokid/jobs/:songId'",
  "app.post('/api/distrokid/jobs/:songId/package'",
  "app.post('/api/distrokid/jobs/:songId/automation-preview'",
  "app.post('/api/distrokid/jobs/:songId/live-submit'",
  "app.post('/api/distrokid/jobs/:songId/hyperfollow'",
]) {
  assert(server.includes(route), `server registers ${route}`);
}
assert(server.includes('runDistroKidSongAutomation'), 'server runs shared DistroKid automation service');
assert(server.includes('captureHyperFollowLink'), 'server captures HyperFollow links');
assert(server.includes('distrokidCommands'), 'server returns DistroKid CLI commands');

for (const status of [
  'not_queued',
  'queued_for_distrokid',
  'package_built',
  'blocked_missing_fields',
  'auth_needed',
  'dry_run_ready',
  'upload_started',
  'awaiting_manual_review',
  'submitted',
  'submitted_pending_hyperfollow',
  'failed',
  'skipped',
]) {
  assert(catalog.includes(status), `catalog maps status ${status}`);
  assert(detail.includes(status) || jobs.includes(status), `detail/backend maps status ${status}`);
}

const uiSource = `${catalog}\n${detail}\n${server}`;
assert(!/DistroKid URL after manual submit/i.test(uiSource), 'UI does not ask for manual DistroKid URL paste');
assert(!/markSubmitted\(\)/.test(detail), 'detail has no manual mark submitted handler');

if (failed) {
  console.error(`FAIL: ${failed} UI smoke check(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`PASS: DistroKid UI smoke checks passed (${passed}).`);

function readText(relativePath) {
  return fs.readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    failed += 1;
    console.error(`not ok - ${label}`);
  }
}
