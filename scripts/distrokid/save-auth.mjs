#!/usr/bin/env node
/**
 * Save DistroKid login state for Playwright automation.
 *
 * Playwright's normal launch injects --enable-automation into Chrome, which
 * Google detects and blocks OAuth with "Couldn't sign you in". This script
 * strips that flag and hides navigator.webdriver so Google sign-in works.
 *
 * Run once:
 *   bash scripts/pancake.sh distrokid:save-auth
 *
 * Then log in to DistroKid in the Chrome window that opens.
 * Wait for the DistroKid dashboard or upload page.
 * Auth is saved to .auth/distrokid.json while the session is live.
 */

import {
  AUTH_DIR,
  DISTROKID_AUTH_PATH,
  ensureDir,
  getCookieDomains,
  hasDistrokidCookies,
  isDistrokidNonSigninUrl,
  readJson,
} from './lib.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('FAIL: Playwright is not installed.');
  console.error('Run: bash scripts/pancake.sh doctor');
  process.exit(1);
}

ensureDir(AUTH_DIR);

console.log('Launching Chrome for DistroKid login.');
console.log('');
console.log('1. Log in to DistroKid.');
console.log('2. Wait until the DistroKid dashboard or upload page loads.');
console.log('3. Close Chrome after this script says auth was saved.');
console.log('');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
  ],
});

const context = await browser.newContext();
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});

const page = await context.newPage();
let reachedDistroKidSession = false;
let saveCount = 0;
let lastSaveAt = null;
let closed = false;

async function saveStorage(trigger) {
  if (closed) return false;
  try {
    const url = page.url();
    if (!isDistrokidNonSigninUrl(url)) return false;
    await context.storageState({ path: DISTROKID_AUTH_PATH });
    reachedDistroKidSession = true;
    saveCount += 1;
    lastSaveAt = new Date().toISOString();
    console.log(`[auth] Saved DistroKid session (${trigger}) at ${lastSaveAt}`);
    return true;
  } catch {
    return false;
  }
}

for (const eventName of ['load', 'domcontentloaded', 'framenavigated']) {
  page.on(eventName, () => {
    saveStorage(eventName).catch(() => {});
  });
}

const interval = setInterval(() => {
  saveStorage('interval').catch(() => {});
}, 5000);

const warnTimer = setTimeout(() => {
  if (!reachedDistroKidSession) {
    console.warn('Warning: no logged-in DistroKid page has been reached after 2 minutes. Keep logging in; this script will keep waiting.');
  }
}, 120000);

async function shutdownFromSignal(signal) {
  console.log(`\nReceived ${signal}; trying one last auth save before exit.`);
  await saveStorage(signal);
  await browser.close().catch(() => {});
}

process.once('SIGINT', () => shutdownFromSignal('SIGINT').catch(() => process.exit(130)));
process.once('SIGTERM', () => shutdownFromSignal('SIGTERM').catch(() => process.exit(143)));

try {
  await page.goto('https://distrokid.com/signin/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
} catch (error) {
  console.warn(`Warning: initial DistroKid signin load failed: ${error.message}`);
  console.warn('If Chrome is open, continue manually; the script will still watch for a logged-in DistroKid page.');
}

await new Promise(resolve => {
  browser.on('disconnected', resolve);
});

closed = true;
clearInterval(interval);
clearTimeout(warnTimer);

// Best effort only. The race-safe saves above are the primary path.
try {
  await context.storageState({ path: DISTROKID_AUTH_PATH });
} catch {}

if (!reachedDistroKidSession && saveCount === 0) {
  console.error('FAIL: no non-signin DistroKid page was captured before Chrome closed.');
  console.error('Try again and wait for the DistroKid dashboard or upload page before closing Chrome.');
  process.exit(1);
}

let saved;
try {
  saved = readJson(DISTROKID_AUTH_PATH);
} catch {
  console.error('FAIL: auth file was not saved at .auth/distrokid.json.');
  process.exit(1);
}

const cookieDomains = getCookieDomains(saved);
console.log(`Cookie domains saved: ${cookieDomains.join(', ') || '(none)'}`);

if (!Array.isArray(saved.cookies) || saved.cookies.length === 0) {
  console.error('FAIL: auth file has no cookies.');
  process.exit(1);
}

if (!hasDistrokidCookies(saved)) {
  console.error('FAIL: auth file has cookies, but none for distrokid.com.');
  console.error('If only Google cookies were saved, run this again and wait until a DistroKid dashboard/upload page is visible.');
  process.exit(1);
}

console.log('PASS: DistroKid auth saved to .auth/distrokid.json.');
console.log('Next: bash scripts/pancake.sh distrokid:check-auth');
