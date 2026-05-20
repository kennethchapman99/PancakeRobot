#!/usr/bin/env node

import fs from 'fs';
import { join } from 'path';
import {
  DANGEROUS_BUTTON_NAMES,
  DISTROKID_AUTH_PATH,
  FIELD_MAP_EXAMPLE_PATH,
  FIELD_MAP_LOCAL_PATH,
  absoluteFromMaybeRelative,
  ensureDir,
  exists,
  getCookieDomains,
  getDistrokidRunDir,
  hasDistrokidCookies,
  isDangerousAction,
  parseArgs,
  readJson,
  relativeToRepo,
  writeJson,
  writeText,
} from './lib.mjs';

const DRY_RUN_ALWAYS = true;

const { values } = parseArgs({
  manifest: { type: 'string' },
  'dry-run': { type: 'boolean', default: true },
  headed: { type: 'string', default: 'true' },
  'slow-mo': { type: 'string', default: '0' },
  'field-map': { type: 'string' },
  'pause-at-end': { type: 'string', default: 'true' },
  'browser-mode': { type: 'string', default: 'storage-state' },
  'discover-fields': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h' },
});

if (values.help || !values.manifest) {
  console.error('Usage: node scripts/distrokid/upload-release.mjs --manifest output/release-packages/SONG_ID/manifest.json --dry-run');
  process.exit(values.help ? 0 : 1);
}

const dryRun = DRY_RUN_ALWAYS;
const headed = parseBool(values.headed, true);
const pauseAtEnd = parseBool(values['pause-at-end'], true);
const discoverFields = values['discover-fields'] === true;
const slowMo = Number(values['slow-mo']) || 0;
const manifestPath = absoluteFromMaybeRelative(values.manifest);

if (!exists(manifestPath)) {
  console.error(`FAIL: manifest not found: ${values.manifest}`);
  process.exit(1);
}

const manifest = readJson(manifestPath);
const songId = manifest.song_id;
if (!songId) {
  console.error('FAIL: manifest is missing song_id.');
  process.exit(1);
}

const runDir = ensureDir(getDistrokidRunDir(songId));
const filledFields = [];
const skippedFields = [];
const errors = [];
const runLog = {
  song_id: songId,
  manifest_path: relativeToRepo(manifestPath),
  dry_run: dryRun,
  browser_mode: values['browser-mode'],
  discover_fields: discoverFields,
  stopped_before_submit: true,
  started_at: new Date().toISOString(),
  finished_at: null,
  diagnostics: {
    skipped_fields: [],
    discovery_files: [],
  },
};

validatePackageFile('audio_file', manifest.audio_file, errors);
validatePackageFile('cover_art', manifest.cover_art, errors);
if (manifest.lyrics_file && !exists(absoluteFromMaybeRelative(manifest.lyrics_file))) {
  skippedFields.push({ field: 'lyrics', reason: `lyrics file not found: ${manifest.lyrics_file}` });
}
if (errors.length) {
  await finish(null, true);
  process.exit(1);
}

if (!exists(DISTROKID_AUTH_PATH)) {
  errors.push({ field: 'auth', error: '.auth/distrokid.json is missing. Run npm run distrokid:save-auth.' });
  await finish(null, true);
  process.exit(1);
}

const auth = readJson(DISTROKID_AUTH_PATH);
console.log(`Cookie domains: ${getCookieDomains(auth).join(', ') || '(none)'}`);
if (!hasDistrokidCookies(auth)) {
  errors.push({ field: 'auth', error: '.auth/distrokid.json has no DistroKid cookies.' });
  await finish(null, true);
  process.exit(1);
}

const fieldMapPath = values['field-map']
  ? absoluteFromMaybeRelative(values['field-map'])
  : exists(FIELD_MAP_LOCAL_PATH) ? FIELD_MAP_LOCAL_PATH : FIELD_MAP_EXAMPLE_PATH;
if (!exists(fieldMapPath)) {
  errors.push({ field: 'field_map', error: `field map not found: ${fieldMapPath}` });
  await finish(null, true);
  process.exit(1);
}

const fieldMap = readJson(fieldMapPath);
runLog.field_map = relativeToRepo(fieldMapPath);
const dangerousNames = fieldMap.dangerous_buttons_never_click || DANGEROUS_BUTTON_NAMES;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  errors.push({ field: 'playwright', error: 'Playwright is not installed. Run npm install && npx playwright install chromium.' });
  await finish(null, true);
  process.exit(1);
}

console.log(`DistroKid upload dry-run: ${songId}`);
console.log('Safety: dry-run is forced true and final submit is blocked.');
console.log(`Field map: ${relativeToRepo(fieldMapPath)}`);

let browser;
let page;
let finishedEarly = false;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: !headed,
    slowMo,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
  });
} catch {
  browser = await chromium.launch({
    headless: !headed,
    slowMo,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
  });
}

try {
  const context = await browser.newContext({ storageState: DISTROKID_AUTH_PATH });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  page = await context.newPage();
  await installSafetyGuard(page, dangerousNames);

  await page.goto(fieldMap.upload_url || 'https://distrokid.com/new/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, 'screenshot-start.png');
  await auditDangerousButtons(page, dangerousNames);

  if (discoverFields) {
    const discovered = await discoverPageFields(page);
    writeJson(join(runDir, 'discovered-fields.json'), discovered);
    writeText(join(runDir, 'discovered-fields.md'), formatDiscoveredFields(discovered));
    runLog.diagnostics.discovery_files.push('discovered-fields.json', 'discovered-fields.md');
    console.log(`Discovery written: ${relativeToRepo(join(runDir, 'discovered-fields.md'))}`);
    await savePageSnapshot(page);
    await saveScreenshot(page, 'screenshot-final-review.png');
    await finish(browser, false);
    finishedEarly = true;
  }

  if (!finishedEarly) {
    for (const [fieldName, fieldDef] of Object.entries(fieldMap.fields || {})) {
      const manifestKey = fieldDef.manifest_key || fieldName;
      const value = getManifestValue(manifest, manifestKey);
      const baseDiagnostic = {
        field: fieldName,
        selector: fieldDef.selector || '',
        strategy: fieldDef.strategy || null,
        manifest_key: manifestKey,
        manifest_value_present: isPresent(value),
      };
      if (!isPresent(value)) {
        addSkipped({ ...baseDiagnostic, reason: `manifest value missing for ${manifestKey}` });
        continue;
      }
      if (!fieldDef.selector) {
        addSkipped({ ...baseDiagnostic, reason: 'selector missing in field map' });
        continue;
      }
      const result = await fillField(page, fieldName, fieldDef, value);
      if (result.ok) filledFields.push({ field: fieldName, strategy: fieldDef.strategy, manifest_key: manifestKey });
      else {
        addSkipped({ ...baseDiagnostic, reason: result.reason, element: result.element || null, candidates: result.candidates || null });
        errors.push({ field: fieldName, error: result.reason, selector: fieldDef.selector, strategy: fieldDef.strategy, manifest_key: manifestKey, element: result.element || null });
      }
    }

    await page.waitForTimeout(1000);
    await saveScreenshot(page, 'screenshot-after-fill.png');
    await auditDangerousButtons(page, dangerousNames);
    await saveScreenshot(page, 'screenshot-final-review.png');
    await savePageSnapshot(page);
  }
} catch (error) {
  errors.push({ field: 'browser', error: error.message });
} finally {
  if (!finishedEarly) await finish(browser, false);
}

async function fillField(page, fieldName, fieldDef, value) {
  try {
    const selector = fieldDef.selector;
    if (isDangerousAction(selector, dangerousNames)) {
      return { ok: false, reason: `selector text looks dangerous: ${selector}` };
    }

    switch (fieldDef.strategy) {
      case 'label': {
        const target = page.getByLabel(selector, { exact: false });
        if (await target.count() === 0) return { ok: false, reason: `label not found: ${selector}` };
        const element = await describeLocator(target);
        if (!isFillableElement(element)) {
          return { ok: false, reason: `selector resolved to non-fillable input type ${element?.type || element?.tagName || 'unknown'}`, element };
        }
        await target.first().fill(String(value));
        return { ok: true };
      }
      case 'inputFile': {
        const filePath = absoluteFromMaybeRelative(value);
        if (!exists(filePath)) return { ok: false, reason: `file not found: ${value}` };
        const target = page.locator(selector);
        const count = await target.count();
        if (count === 0) {
          const candidates = await logFileInputCandidates(page, fieldName);
          return { ok: false, reason: `file input not found: ${selector}`, candidates };
        }
        if (count > 1 && selector === 'input[type=\'file\']') {
          const candidates = await logFileInputCandidates(page, fieldName);
          return { ok: false, reason: 'multiple file inputs found; selector is not reliable enough', candidates };
        }
        const element = await describeLocator(target);
        if (element && element.tagName !== 'INPUT') {
          return { ok: false, reason: `selector resolved to non-file element ${element.tagName}`, element };
        }
        await target.first().setInputFiles(filePath);
        await page.waitForTimeout(1500);
        return { ok: true };
      }
      case 'select': {
        const target = page.locator(selector);
        if (await target.count() === 0) return { ok: false, reason: `select not found: ${selector}` };
        const element = await describeLocator(target);
        if (element?.tagName !== 'SELECT') {
          return { ok: false, reason: `selector resolved to non-select element ${element?.tagName || 'unknown'}`, element };
        }
        await target.first().selectOption({ label: String(value) }).catch(async () => {
          await target.first().selectOption(String(value));
        });
        return { ok: true };
      }
      case 'radioOrCheckbox': {
        const target = page.getByLabel(selector, { exact: false });
        if (await target.count() === 0) return { ok: false, reason: `radio/checkbox not found: ${selector}` };
        const truthy = value === true || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'yes';
        if (truthy) await target.first().check();
        else await target.first().uncheck().catch(() => {});
        return { ok: true };
      }
      case 'textarea':
      case 'date': {
        const target = page.locator(selector);
        if (await target.count() === 0) return { ok: false, reason: `field not found: ${selector}` };
        const element = await describeLocator(target);
        if (!isFillableElement(element)) {
          return { ok: false, reason: `selector resolved to non-fillable input type ${element?.type || element?.tagName || 'unknown'}`, element };
        }
        await target.first().fill(String(value));
        return { ok: true };
      }
      default:
        return { ok: false, reason: `unknown strategy: ${fieldDef.strategy}` };
    }
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function describeLocator(locator) {
  const handle = await locator.first().elementHandle().catch(() => null);
  if (!handle) return null;
  return handle.evaluate(el => ({
    tagName: el.tagName,
    type: el.getAttribute('type'),
    id: el.id || null,
    name: el.getAttribute('name'),
    ariaLabel: el.getAttribute('aria-label'),
    placeholder: el.getAttribute('placeholder'),
    text: el.innerText || el.value || '',
  })).catch(() => null);
}

function isFillableElement(element) {
  if (!element) return false;
  const tag = String(element.tagName || '').toUpperCase();
  const type = String(element.type || '').toLowerCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(type);
}

async function installSafetyGuard(page, dangerousNames) {
  await page.addInitScript((names) => {
    const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const dangerous = text => {
      const normalized = normalize(text);
      return names.some(name => normalized === normalize(name) || normalized.includes(normalize(name)));
    };
    document.addEventListener('click', event => {
      const target = event.target?.closest?.('button,a,input,[role="button"]');
      if (!target) return;
      const text = target.innerText || target.value || target.getAttribute('aria-label') || target.getAttribute('name') || '';
      if (dangerous(text)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        console.warn(`Blocked dangerous DistroKid action: ${text}`);
      }
    }, true);
  }, dangerousNames);
}

async function auditDangerousButtons(page, dangerousNames) {
  const found = [];
  for (const name of dangerousNames) {
    const count = await page.getByRole('button', { name, exact: false }).count().catch(() => 0);
    if (count) found.push({ name, count });
  }
  if (found.length) {
    writeJson(join(runDir, 'dangerous-buttons-found.json'), {
      found,
      note: 'Logged only. Automation never clicks these.',
    });
  }
}

async function logFileInputCandidates(page, fieldName) {
  const candidates = await page.locator('input[type="file"]').evaluateAll(inputs => inputs.map((input, index) => ({
    index,
    id: input.id || null,
    name: input.getAttribute('name') || null,
    accept: input.getAttribute('accept') || null,
    aria_label: input.getAttribute('aria-label') || null,
    labels: (() => {
      const labels = new Set();
      if (input.id) {
        document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).forEach(label => labels.add(label.innerText.trim()));
      }
      input.closest('label')?.innerText && labels.add(input.closest('label').innerText.trim());
      return [...labels].filter(Boolean);
    })(),
    visible: (() => {
      const style = window.getComputedStyle(input);
      const rect = input.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    })(),
    classes: input.className || null,
  }))).catch(() => []);
  writeJson(join(runDir, `${fieldName}-file-input-candidates.json`), candidates);
  return candidates;
}

async function saveScreenshot(page, filename) {
  await page.screenshot({ path: join(runDir, filename), fullPage: true }).catch(() => {});
}

async function savePageSnapshot(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');
  writeText(join(runDir, 'page-text-snapshot.txt'), text);
  writeText(join(runDir, 'html-snapshot.html'), html);
}

async function finish(browser, skipBrowserClose) {
  runLog.finished_at = new Date().toISOString();
  runLog.filled_count = filledFields.length;
  runLog.skipped_count = skippedFields.length;
  runLog.error_count = errors.length;
  writeJson(join(runDir, 'run-log.json'), runLog);
  writeJson(join(runDir, 'filled-fields.json'), filledFields);
  writeJson(join(runDir, 'skipped-fields.json'), skippedFields);
  writeJson(join(runDir, 'errors.json'), errors);

  console.log('');
  console.log(`Filled: ${filledFields.length}`);
  console.log(`Skipped: ${skippedFields.length}`);
  console.log(`Failed: ${errors.length}`);
  console.log(`Package: output/release-packages/${songId}/`);
  console.log(`Screenshots/logs: ${relativeToRepo(runDir)}`);
  if (skippedFields.length) {
    console.log('Skipped fields:');
    for (const item of skippedFields) console.log(`- ${item.field}: ${item.reason}`);
  }
  console.log('Manual next steps: review DistroKid, fill skipped fields, and submit manually only when ready.');
  console.log(`After manual submission: npm run distrokid:mark-submitted -- --song-id ${songId} --distrokid-url URL`);

  if (browser && pauseAtEnd && !skipBrowserClose) {
    console.log('Browser remains open for manual review. Close it when done.');
    await waitForBrowserClose(browser, page);
  } else if (browser) {
    await browser.close().catch(() => {});
  }
}

async function waitForBrowserClose(browser, page) {
  const isBrowserClosed = await Promise.resolve(browser?.isConnected?.() === false).catch(() => true);
  if (!browser || isBrowserClosed) return;
  if (page?.isClosed?.()) return;

  await new Promise(resolve => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    try { browser.on('disconnected', done); } catch {}
    try { page?.on('close', done); } catch {}

    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

function addSkipped(item) {
  skippedFields.push(item);
  runLog.diagnostics.skipped_fields.push(item);
}

async function discoverPageFields(page) {
  return page.evaluate(() => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labelsForElement = el => {
      const labels = new Set();
      if (el.id) {
        document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach(label => labels.add(label.innerText.trim()));
      }
      el.closest('label')?.innerText && labels.add(el.closest('label').innerText.trim());
      el.getAttribute('aria-labelledby')?.split(/\s+/).forEach(id => {
        const labelEl = document.getElementById(id);
        if (labelEl?.innerText) labels.add(labelEl.innerText.trim());
      });
      return [...labels].filter(Boolean);
    };
    const base = (el, index) => ({
      index,
      id: el.id || null,
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      labels: labelsForElement(el),
      visible: visible(el),
    });
    const inputs = [...document.querySelectorAll('input')].map((el, index) => ({
      ...base(el, index),
      type: el.getAttribute('type') || 'text',
      accept: el.getAttribute('accept'),
      value: el.type === 'password' ? null : el.value || null,
    }));
    const textareas = [...document.querySelectorAll('textarea')].map((el, index) => ({
      ...base(el, index),
      rows: el.getAttribute('rows'),
    }));
    const selects = [...document.querySelectorAll('select')].map((el, index) => ({
      ...base(el, index),
      options: [...el.options].slice(0, 50).map(option => ({ value: option.value, text: option.text })),
    }));
    const buttons = [...document.querySelectorAll('button,input[type="button"],input[type="submit"],[role="button"]')].map((el, index) => ({
      index,
      text: (el.innerText || el.value || '').trim(),
      id: el.id || null,
      name: el.getAttribute('name'),
      ariaLabel: el.getAttribute('aria-label'),
      visible: visible(el),
    }));
    const fileInputs = inputs.filter(input => String(input.type).toLowerCase() === 'file');
    return { url: location.href, captured_at: new Date().toISOString(), inputs, textareas, selects, buttons, fileInputs };
  });
}

function formatDiscoveredFields(discovered) {
  return [
    `# DistroKid Field Discovery`,
    ``,
    `URL: ${discovered.url}`,
    `Captured: ${discovered.captured_at}`,
    ``,
    formatDiscoveryTable('Inputs', discovered.inputs, ['index', 'type', 'id', 'name', 'placeholder', 'ariaLabel', 'labels', 'visible', 'accept']),
    formatDiscoveryTable('Textareas', discovered.textareas, ['index', 'id', 'name', 'placeholder', 'ariaLabel', 'labels', 'visible']),
    formatDiscoveryTable('Selects', discovered.selects, ['index', 'id', 'name', 'ariaLabel', 'labels', 'visible']),
    formatDiscoveryTable('Buttons', discovered.buttons, ['index', 'text', 'id', 'name', 'ariaLabel', 'visible']),
    formatDiscoveryTable('File Inputs', discovered.fileInputs, ['index', 'id', 'name', 'accept', 'ariaLabel', 'labels', 'visible']),
    ``,
  ].join('\n');
}

function formatDiscoveryTable(title, rows, keys) {
  const lines = [`## ${title}`, ''];
  if (!rows?.length) return `${lines.join('\n')}\nNone\n`;
  lines.push(`| ${keys.join(' | ')} |`);
  lines.push(`| ${keys.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${keys.map(key => formatCell(row[key])).join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatCell(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.join('; ').replace(/\|/g, '\\|');
  return String(value).replace(/\n/g, ' ').replace(/\|/g, '\\|');
}

function validatePackageFile(key, value, errors) {
  if (!value || !exists(absoluteFromMaybeRelative(value))) {
    errors.push({ field: key, error: `${key} not found: ${value || '(missing)'}` });
  }
}

function getManifestValue(manifest, key) {
  if (key === 'lyrics_file' && manifest.lyrics_file) {
    return fs.readFileSync(absoluteFromMaybeRelative(manifest.lyrics_file), 'utf8');
  }
  return manifest[key];
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no'].includes(String(value).toLowerCase());
}

function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
