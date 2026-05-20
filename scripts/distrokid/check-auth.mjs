#!/usr/bin/env node

import {
  DISTROKID_AUTH_PATH,
  RELEASE_PACKAGES_DIR,
  ensureDir,
  exists,
  getCookieDomains,
  hasDistrokidCookies,
  readJson,
  writeText,
} from './lib.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('FAIL: Playwright is not installed.');
  console.error('Run: npm install && npx playwright install chromium');
  process.exit(1);
}

if (!exists(DISTROKID_AUTH_PATH)) {
  console.error('FAIL: .auth/distrokid.json is missing.');
  console.error('Run: npm run distrokid:save-auth');
  process.exit(1);
}

const storage = readJson(DISTROKID_AUTH_PATH);
console.log(`Cookie domains: ${getCookieDomains(storage).join(', ') || '(none)'}`);
if (!hasDistrokidCookies(storage)) {
  console.error('FAIL: .auth/distrokid.json has no DistroKid cookies.');
  console.error('Run: npm run distrokid:save-auth');
  process.exit(1);
}

ensureDir(RELEASE_PACKAGES_DIR);

let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
} catch {
  browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

const context = await browser.newContext({ storageState: DISTROKID_AUTH_PATH });
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});

const page = await context.newPage();
let ok = false;
let reason = '';

try {
  await page.goto('https://distrokid.com/new/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const url = page.url();
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const html = await page.content().catch(() => '');

  await page.screenshot({ path: `${RELEASE_PACKAGES_DIR}/auth-check.png`, fullPage: true }).catch(() => {});
  writeText(`${RELEASE_PACKAGES_DIR}/auth-check-page-text.txt`, text);

  const lowerUrl = url.toLowerCase();
  const lowerText = text.toLowerCase();
  const loggedOut = lowerUrl.includes('/signin')
    || lowerUrl.includes('accounts.google.com')
    || lowerText.includes("couldn't sign you in")
    || lowerText.includes('sign in with google')
    || lowerText.includes('login');

  const loggedIn = lowerUrl.includes('distrokid.com/new')
    || lowerText.includes('upload')
    || lowerText.includes('distrokid')
    || html.toLowerCase().includes('distrokid');

  ok = loggedIn && !loggedOut;
  reason = ok ? `Reached ${url}` : `Looks logged out or rejected at ${url}`;
} catch (error) {
  reason = error.message;
} finally {
  await browser.close().catch(() => {});
}

if (!ok) {
  console.error(`FAIL: ${reason}`);
  console.error('Artifacts: output/release-packages/auth-check.png and auth-check-page-text.txt');
  console.error('Run: npm run distrokid:save-auth');
  process.exit(1);
}

console.log(`PASS: saved auth reaches DistroKid. ${reason}`);
console.log('Artifacts: output/release-packages/auth-check.png and auth-check-page-text.txt');
