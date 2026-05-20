#!/usr/bin/env node

import fs from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { DANGEROUS_BUTTON_NAMES, REPO_ROOT } from './lib.mjs';

let passed = 0;
let failed = 0;

checkFile('scripts/distrokid/lib.mjs');
checkFile('scripts/distrokid/save-auth.mjs');
checkFile('scripts/distrokid/check-auth.mjs');
checkFile('scripts/distrokid/build-release-package.mjs');
checkFile('scripts/distrokid/upload-release.mjs');
checkFile('scripts/distrokid/batch-upload.mjs');
checkFile('scripts/distrokid/mark-submitted.mjs');
checkFile('config/distrokid/field-map.example.json');
checkFile('docs/distrokid-uploader.md');
checkFile('docs/distrokid-selector-capture.md');

const pkg = readJson('package.json');
for (const script of [
  'distrokid:save-auth',
  'distrokid:check-auth',
  'distrokid:package',
  'distrokid:upload',
  'distrokid:batch',
  'distrokid:mark-submitted',
  'distrokid:smoke',
]) {
  assert(Boolean(pkg.scripts?.[script]), `package.json script ${script}`);
}
assert(Boolean(pkg.devDependencies?.playwright || pkg.dependencies?.playwright), 'Playwright dependency present');

const gitignore = readText('.gitignore');
for (const entry of [
  '.auth/',
  '.browser-profiles/',
  'config/distrokid/field-map.local.json',
  'playwright-report/',
  'test-results/',
]) {
  assert(gitignore.includes(entry), `.gitignore includes ${entry}`);
}

const fieldMap = readJson('config/distrokid/field-map.example.json');
assert(fieldMap.stop_before_submit === true, 'field map stops before submit');
for (const button of DANGEROUS_BUTTON_NAMES) {
  assert(fieldMap.dangerous_buttons_never_click?.includes(button), `field map dangerous button ${button}`);
}
for (const key of ['artist', 'release_title', 'track_title', 'audio_file', 'cover_art', 'primary_genre', 'lyrics', 'made_for_kids', 'ai_generated']) {
  assert(Boolean(fieldMap.fields?.[key]?.manifest_key), `field map field ${key}`);
}

const uploadSrc = readText('scripts/distrokid/upload-release.mjs');
assert(uploadSrc.includes('const DRY_RUN_ALWAYS = true'), 'upload dry-run forced true');
assert(uploadSrc.includes('isDangerousAction'), 'upload has dangerous action helper');
assert(uploadSrc.includes('installSafetyGuard'), 'upload installs safety guard');
assert(!/getByRole\([^)]*Submit[^)]*\)\.click/.test(uploadSrc), 'upload has no submit click');

const saveAuthSrc = readText('scripts/distrokid/save-auth.mjs');
assert(saveAuthSrc.includes("ignoreDefaultArgs: ['--enable-automation']"), 'save-auth strips --enable-automation');
assert(saveAuthSrc.includes('--disable-blink-features=AutomationControlled'), 'save-auth disables AutomationControlled');
assert(saveAuthSrc.includes("Object.defineProperty(navigator, 'webdriver'"), 'save-auth hides navigator.webdriver');
assert(saveAuthSrc.includes("'domcontentloaded'") && saveAuthSrc.includes("'framenavigated'") && saveAuthSrc.includes('setInterval'), 'save-auth saves before browser close');

const checkAuthSrc = readText('scripts/distrokid/check-auth.mjs');
assert(checkAuthSrc.includes('auth-check.png'), 'check-auth saves screenshot');
assert(checkAuthSrc.includes('auth-check-page-text.txt'), 'check-auth saves text snapshot');

assertCommandFailsClearly(['scripts/distrokid/build-release-package.mjs'], 'build-release-package missing args fails clearly');
assertCommandFailsClearly(['scripts/distrokid/mark-submitted.mjs'], 'mark-submitted missing args fails clearly');

console.log('');
console.log(`Smoke results: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

function checkFile(path) {
  assert(fs.existsSync(join(REPO_ROOT, path)), `${path} exists`);
}

function assert(value, name) {
  if (value) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}`);
  }
}

function readText(path) {
  return fs.readFileSync(join(REPO_ROOT, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function assertCommandFailsClearly(args, name) {
  try {
    execFileSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    assert(false, name);
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    assert(/Usage:|Error:|FAIL:/i.test(output), name);
  }
}
