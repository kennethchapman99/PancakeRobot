#!/usr/bin/env node

import fs from 'fs';
import { join } from 'path';
import { validateCanonicalReleasePackageManifest } from '../../src/shared/release-package-validation.js';
import {
  DANGEROUS_BUTTON_NAMES,
  DISTROKID_AUTH_PATH,
  DISTROKID_PLAYWRIGHT_PROFILE_DIR,
  DISTROKID_RUN_EVENT_PREFIX,
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
import {
  BLOCKED_FILL_VALIDATION_CODE,
  BLOCKED_FILL_VALIDATION_EXIT_CODE,
  BLOCKED_UPLOAD_VALIDATION_CODE,
  BLOCKED_UPLOAD_VALIDATION_EXIT_CODE,
  createTrackCountValidationError,
  ensureDistroKidTrackCount,
  fillReleaseFields,
} from './upload-release-helpers.mjs';

let DISTROKID_JOB_STATUSES = {
  UPLOAD_STARTED: 'upload_started',
  BLOCKED_UPLOAD_VALIDATION: 'blocked_upload_validation',
  AUTH_NEEDED: 'auth_needed',
  FAILED: 'failed',
  SUBMITTED: 'submitted',
  AWAITING_MANUAL_REVIEW: 'awaiting_manual_review',
};
let getDistroKidJob = () => null;
let markDistroKidJobStatus = () => {};

const { values } = parseArgs({
  manifest: { type: 'string' },
  'dry-run': { type: 'boolean', default: true },
  'live-submit': { type: 'boolean', default: false },
  'confirm-live-submit': { type: 'boolean', default: false },
  headed: { type: 'string', default: 'true' },
  'slow-mo': { type: 'string', default: '0' },
  'field-map': { type: 'string' },
  'pause-at-end': { type: 'string', default: 'true' },
  'no-pause': { type: 'boolean', default: false },
  'browser-mode': { type: 'string', default: 'storage-state' },
  'discover-fields': { type: 'boolean', default: false },
  'certify-important-checkboxes': { type: 'boolean', default: false },
  'artwork-path': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

if (values.help || !values.manifest) {
  console.error('Usage: bash scripts/pancake.sh distrokid:upload --manifest output/release-packages/SONG_ID/manifest.json --dry-run');
  process.exit(values.help ? 0 : 1);
}

const liveSubmit = values['live-submit'] === true;
if (liveSubmit && values['confirm-live-submit'] !== true) {
  console.error('FAIL: --live-submit requires --confirm-live-submit.');
  process.exit(1);
}
const dryRun = !liveSubmit;
const headed = parseBool(values.headed, true);
const pauseAtEnd = values['no-pause'] ? false : parseBool(values['pause-at-end'], true);
const discoverFields = values['discover-fields'] === true;
const certifyImportantCheckboxes = values['certify-important-checkboxes'] === true;
const slowMo = Number(values['slow-mo']) || 0;
const manifestPath = absoluteFromMaybeRelative(values.manifest);
const IMPORTANT_CERTIFICATION_CHECKBOXES = new Set([
  '#areyousureyoutube',
  '#areyousurepromoservices',
  '#areyousurerecorded',
  '#areyousureotherartist',
  '#areyousuretandc',
]);
const BLOCKED_LOGIN_EXIT_CODE = 21;
const CANCELLED_EXIT_CODE = 130;
const CONDITIONAL_CERTIFICATION_CHECKBOXES = new Set([
  '#areyousureticktokcml',
  '#areyousuresnap',
]);
const PANCAKE_ROBOT_DISTROKID_DEFAULTS = Object.freeze({
  primary_genre: "Children's Music",
  ai_disclosure: {
    uses_ai: true,
    lyrics_written_by_ai: false,
    music_composed_by_ai: false,
    all_audio_performed_by_ai: true,
    part_audio_performed_by_ai_and_humans: false,
  },
  songwriter_real_name: {
    role: 'Music and lyrics',
    first: 'Kenneth',
    middle: '',
    last: 'Chapman',
  },
  apple_music_credits: {
    performer: {
      role: 'Performer',
      name: 'Pancake Robot',
    },
    producer: {
      role: 'Executive Producer',
      name: 'Kenneth Chapman',
    },
  },
  rights_confirmations: {
    youtube_music_selected_acknowledged: true,
    no_promo_services: true,
    recorded_and_authorized: true,
    no_unapproved_artist_names: true,
    distribution_agreement_accepted: true,
    tiktok_commercial_music_library: false,
    snapchat: false,
  },
});

if (!exists(manifestPath)) {
  console.error(`FAIL: manifest not found: ${values.manifest}`);
  process.exit(1);
}

let manifest = readJson(manifestPath);
manifest = normalizeDistroKidManifest(manifest);
const resolvedArtworkPath = resolveArtworkPath(manifest, values['artwork-path']);
if (resolvedArtworkPath) manifest.cover_art = resolvedArtworkPath;
const manifestEntityId = resolveManifestEntityId(manifest);
if (!manifestEntityId) {
  console.error('FAIL: manifest is missing song_id/release_id/album_id.');
  process.exit(1);
}

const runDir = ensureDir(getDistrokidRunDir(manifestEntityId));
const filledFields = [];
const skippedFields = [];
const errors = [];
let fieldMap = { dangerous_paid_extras_never_autofill: [] };
let finishedEarly = false;
let finished = false;
let finalStatus = 'pending';
let finalCode = '';
let finalMessage = '';
let exitCode = 0;
const runLog = {
  song_id: manifest.song_id || null,
  release_id: manifest.release_id || manifest.album_id || null,
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
    track_count_validation: null,
    fill_validation: null,
    lifecycle: [],
  },
  final_status: null,
  final_code: null,
  final_message: null,
  releaseDateFromManifest: null,
  releaseDateAppliedToDistroKid: null,
};
runLog.resolved_artwork_path = resolvedArtworkPath || manifest.cover_art || null;
const manifestJobSongIds = collectManifestSongIds(manifest);
const normalizedManifestReleaseDate = normalizeReleaseDateValue(manifest.release_date);
runLog.releaseDateFromManifest = normalizedManifestReleaseDate;
if (normalizedManifestReleaseDate) {
  console.log(JSON.stringify({ releaseDateFromManifest: normalizedManifestReleaseDate }));
  runLog.diagnostics.lifecycle.push(`releaseDateFromManifest=${normalizedManifestReleaseDate}`);
} else if (manifest.release_date) {
  const warning = `Manifest release_date is invalid and will not be trusted: ${manifest.release_date}`;
  console.warn(warning);
  runLog.diagnostics.lifecycle.push(warning);
} else {
  const warning = 'Manifest release_date is missing; DistroKid automation will leave the current release date behavior unchanged.';
  console.warn(warning);
  runLog.diagnostics.lifecycle.push(warning);
}
const validation = validateCanonicalReleasePackageManifest(manifest, { releaseType: manifest.release_type });
for (const issue of validation.issues) {
  if (issue.code === 'missing_cover_art') errors.push({ field: 'cover_art', error: 'cover_art not found: (missing)' });
  else if (issue.code === 'missing_cover_art_file') errors.push({ field: 'cover_art', error: issue.message.replace(/^Canonical package is missing cover_art\.$/, 'cover_art not found: (missing)') });
  else if (issue.code === 'missing_track_audio_file') errors.push({ field: issue.path || 'audio_file', error: 'audio_file not found: (missing)' });
  else if (issue.code === 'missing_track_audio_file_path') errors.push({ field: issue.path || 'audio_file', error: issue.message.replace(/^[^:]+: /, '') });
  else if (issue.code === 'missing_tracks') errors.push({ field: 'tracks', error: 'tracks not found: (missing)' });
  else if (issue.code === 'album_song_id_confusion') errors.push({ field: 'release_id', error: issue.message });
  else if (issue.code === 'missing_manifest') errors.push({ field: 'manifest', error: issue.message });
}
if (manifest.lyrics_file && !exists(absoluteFromMaybeRelative(manifest.lyrics_file))) {
  skippedFields.push({ field: 'lyrics', reason: `lyrics file not found: ${manifest.lyrics_file}` });
}
if (errors.length) {
  await finish(null, true);
  process.exit(1);
}

logRunStep('loading manifest');
logRunStep('resolving artwork');

const auth = exists(DISTROKID_AUTH_PATH) ? readJson(DISTROKID_AUTH_PATH) : null;
console.log(`Cookie domains: ${getCookieDomains(auth).join(', ') || '(none)'}`);

const fieldMapPath = values['field-map']
  ? absoluteFromMaybeRelative(values['field-map'])
  : exists(FIELD_MAP_LOCAL_PATH) ? FIELD_MAP_LOCAL_PATH : FIELD_MAP_EXAMPLE_PATH;
if (!exists(fieldMapPath)) {
  errors.push({ field: 'field_map', error: `field map not found: ${fieldMapPath}` });
  await finish(null, true);
  process.exit(1);
}

fieldMap = readJson(fieldMapPath);
runLog.field_map = relativeToRepo(fieldMapPath);
const dangerousNames = [...new Set([...DANGEROUS_BUTTON_NAMES, ...(fieldMap.dangerous_buttons_never_click || [])])];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  errors.push({ field: 'playwright', error: 'Playwright is not installed. Run bash scripts/pancake.sh doctor.' });
  await finish(null, true);
  process.exit(1);
}

console.log(`DistroKid upload ${dryRun ? 'preview' : 'live submit'}: ${manifestEntityId}`);
if (dryRun) console.log('Safety: preview mode stops before final submit.');
else console.log('LIVE SUBMIT: final DistroKid submission is enabled by explicit confirmation.');
if (certifyImportantCheckboxes) {
  console.log('WARNING: Certification checkboxes are legal attestations. Only use this when the statements are true.');
}
console.log(`Field map: ${relativeToRepo(fieldMapPath)}`);

await loadDistroKidJobBindings();
const existingJob = manifestJobSongIds.map(id => getDistroKidJob(id)).find(Boolean) || null;
markManifestJobs(DISTROKID_JOB_STATUSES.UPLOAD_STARTED, {
  attempt_count: (existingJob?.attempt_count || 0) + 1,
  last_attempt_at: runLog.started_at,
  latest_run_log_path: relativeToRepo(join(runDir, 'run-log.json')),
  latest_error_json: null,
});
let context;
let page;
try {
  context = await chromium.launchPersistentContext(ensureDir(DISTROKID_PLAYWRIGHT_PROFILE_DIR), {
    channel: 'chrome',
    headless: !headed,
    slowMo,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
  });
} catch {
  context = await chromium.launchPersistentContext(ensureDir(DISTROKID_PLAYWRIGHT_PROFILE_DIR), {
    headless: !headed,
    slowMo,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
  });
}

try {
  await seedPersistentContext(context, auth);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  page = context.pages()[0] || await context.newPage();
  installAuthPersistence(context, page);
  await installSafetyGuard(page, dangerousNames, { allowSubmit: liveSubmit });

  await page.goto(fieldMap.upload_url || 'https://distrokid.com/new/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(2000);
  if (await detectAuthRequired(page)) {
    await blockForLogin(context, page, 'DistroKid login required. Complete login in the browser, then resume.');
    finishedEarly = true;
  }
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
    await finish(context, false);
    finishedEarly = true;
  }

  if (!finishedEarly) {
    const fillResult = await fillReleaseFields({
      page,
      manifest,
      fieldEntries: getOrderedFields(fieldMap.fields || {}),
      ensureTrackCount: async () => {
        const trackCount = Array.isArray(manifest.tracks) ? manifest.tracks.length : 1;
        logRunStep(`selecting track count: ${getTrackCountPhaseLabel(trackCount)}`);
        const result = await ensureDistroKidTrackCount(page, trackCount, runDir);
        runLog.diagnostics.track_count_validation = result;
        return result;
      },
      waitForAlbumFormReady: async () => {
        const trackCount = Array.isArray(manifest.tracks) ? manifest.tracks.length : 1;
        logRunStep(`waiting for ${trackCount} track groups`);
        runLog.diagnostics.post_track_count_render = await waitForAlbumFormReady(page, manifest, fieldMap);
      },
      runFieldForManifest: async (...args) => {
        logFieldPhase(args[0], manifest);
        if (page.isClosed()) {
          const message = 'DistroKid page closed before field loop completed';
          errors.push({ field: 'browser', error: message });
          return;
        }
        if (await detectAuthRequired(page)) {
          await blockForLogin(context, page, 'DistroKid login required. Complete login in the browser, then resume.');
          finishedEarly = true;
          return;
        }
        if (!finishedEarly) await runFieldForManifest(...args);
      },
    });

    if (!fillResult.ok) {
      const trackCountError = createTrackCountValidationError(fillResult.trackCountCheck);
      errors.push(trackCountError);
      finalStatus = 'blocked';
      finalCode = BLOCKED_UPLOAD_VALIDATION_CODE;
      finalMessage = trackCountError.error;
      exitCode = BLOCKED_UPLOAD_VALIDATION_EXIT_CODE;
      markManifestJobs(DISTROKID_JOB_STATUSES.BLOCKED_UPLOAD_VALIDATION, {
        latest_run_log_path: relativeToRepo(join(runDir, 'run-log.json')),
        latest_error_json: trackCountError,
      });
      await saveScreenshot(page, 'screenshot-track-count-validation.png');
      await savePageSnapshot(page);
      emitRunEvent({
        status: 'blocked',
        code: finalCode,
        message: finalMessage,
        latest_run_log_path: relativeToRepo(join(runDir, 'run-log.json')),
      });
      finishedEarly = true;
    }

    if (!finishedEarly) {
      logRunStep('validating filled DistroKid form');
      const fillValidation = await validateFilledDistroKidForm(page, manifest, fieldMap);
      runLog.diagnostics.fill_validation = fillValidation;
      if (!fillValidation.ok) {
        const fillValidationError = {
          field: 'distrokid_form_validation',
          code: BLOCKED_FILL_VALIDATION_CODE,
          error: fillValidation.summary,
          diagnostics_path: relativeToRepo(join(runDir, 'fill-validation.json')),
        };
        errors.push(fillValidationError);
        finalStatus = 'blocked';
        finalCode = BLOCKED_FILL_VALIDATION_CODE;
        finalMessage = fillValidation.summary;
        exitCode = BLOCKED_FILL_VALIDATION_EXIT_CODE;
        markManifestJobs(DISTROKID_JOB_STATUSES.BLOCKED_UPLOAD_VALIDATION, {
          latest_run_log_path: relativeToRepo(join(runDir, 'run-log.json')),
          latest_error_json: fillValidationError,
        });
        await saveScreenshot(page, 'screenshot-fill-validation.png');
        await savePageSnapshot(page);
        emitRunEvent({
          status: 'blocked',
          code: finalCode,
          message: finalMessage,
          latest_run_log_path: relativeToRepo(join(runDir, 'run-log.json')),
        });
        finishedEarly = true;
      }
    }

    if (!finishedEarly) {
      await page.waitForTimeout(1000);
      await saveScreenshot(page, 'screenshot-after-fill.png');
      await auditDangerousButtons(page, dangerousNames);
      await saveScreenshot(page, 'screenshot-final-review.png');
      await savePageSnapshot(page);
      if (liveSubmit) {
        const submitResult = await submitRelease(page, fieldMap);
        runLog.submission = submitResult;
        if (submitResult.ok) {
          runLog.stopped_before_submit = false;
          console.log(`DistroKid submit clicked: ${submitResult.selector || submitResult.text}`);
        } else {
          errors.push({ field: 'submit', error: submitResult.reason });
        }
      }
      console.log(`PLAYWRIGHT STAGING COMPLETE: ${manifestEntityId}`);
    }
  }
} catch (error) {
  errors.push({ field: 'browser', error: error.message });
} finally {
  if (!finishedEarly) await finish(context, false);
}

async function runFieldForManifest(page, fieldName, fieldDef, sourceManifest) {
      const condition = shouldRunField(sourceManifest, fieldDef);
      if (!condition.ok) {
        addSkipped({ field: fieldName, selector: fieldDef.selector || '', strategy: fieldDef.strategy || null, status: fieldDef.category === 'certification' ? 'skipped_manual' : undefined, reason: condition.reason });
        return;
      }
      if (fieldDef.requires_certify && !certifyImportantCheckboxes) {
        addSkipped({
          field: fieldName,
          selector: fieldDef.selector || '',
          strategy: fieldDef.strategy || null,
          status: 'skipped_manual',
          reason: 'certification checkbox requires --certify-important-checkboxes',
        });
        return;
      }
      if (fieldDef.category === 'certification' && !isCertificationSelectorAllowed(fieldDef.selector, fieldDef)) {
        addSkipped({
          field: fieldName,
          selector: fieldDef.selector || '',
          strategy: fieldDef.strategy || null,
          status: 'blocked_not_allowlisted',
          reason: 'certification checkbox selector is not allowlisted',
        });
        return;
      }
      const manifestKey = fieldDef.manifest_key || fieldName;
      const value = getCertificationValue(sourceManifest, fieldDef) ?? getFieldValue(sourceManifest, fieldName, fieldDef);
      const baseDiagnostic = {
        field: fieldName,
        selector: fieldDef.selector || '',
        strategy: fieldDef.strategy || null,
        manifest_key: manifestKey,
        manifest_value_present: isPresent(value),
      };
      if (!isPresent(value) && fieldDef.allowEmpty !== true && !Object.hasOwn(fieldDef, 'value')) {
        addSkipped({ ...baseDiagnostic, status: fieldDef.category === 'certification' ? 'skipped_manual' : undefined, reason: `manifest value missing for ${manifestKey}` });
        return;
      }
      if (fieldDef.category === 'certification' && !certifyImportantCheckboxes && !toBool(value)) {
        addSkipped({ ...baseDiagnostic, status: 'skipped_manual', reason: `rights confirmation is not true for ${manifestKey}` });
        return;
      }
      if (!fieldDef.selector && !fieldDef.name_prefix && !fieldDef.labelText) {
        addSkipped({ ...baseDiagnostic, reason: 'selector missing in field map' });
        return;
      }
      const result = await fillField(page, fieldName, fieldDef, value);
      if (result.ok) {
        filledFields.push({ field: fieldName, strategy: fieldDef.strategy, manifest_key: manifestKey, category: fieldDef.category || null, status: fieldDef.category === 'certification' ? 'checked' : undefined });
        if (manifestKey === 'release_date') {
          const appliedReleaseDate = normalizeReleaseDateValue(value);
          runLog.releaseDateAppliedToDistroKid = appliedReleaseDate;
          if (appliedReleaseDate) {
            console.log(JSON.stringify({ releaseDateAppliedToDistroKid: appliedReleaseDate }));
            runLog.diagnostics.lifecycle.push(`releaseDateAppliedToDistroKid=${appliedReleaseDate}`);
          }
        }
      }
      else {
        if (isPageClosedError(result.reason)) {
          const message = 'DistroKid page closed before field loop completed';
          errors.push({ field: 'browser', error: message, during_field: fieldName });
          return;
        }
        addSkipped({ ...baseDiagnostic, status: result.status || (fieldDef.category === 'certification' ? 'unavailable' : undefined), reason: result.reason, element: result.element || null, candidates: result.candidates || null, options: result.options || null });
        if (!fieldDef.optional && !result.skipped) {
          errors.push({ field: fieldName, error: result.reason, selector: fieldDef.selector, strategy: fieldDef.strategy, manifest_key: manifestKey, element: result.element || null });
        }
      }
}

async function fillField(page, fieldName, fieldDef, value) {
  try {
    if (page.isClosed()) return { ok: false, skipped: true, reason: 'page is closed' };
    const selector = fieldDef.selector;
    if (isDangerousAction(selector, dangerousNames)) {
      return { ok: false, reason: `selector text looks dangerous: ${selector}` };
    }

    switch (fieldDef.strategy) {
      case 'label': {
        const target = page.getByLabel(selector, { exact: false });
        if (await target.count() === 0) return { ok: false, reason: `label not found: ${selector}` };
        const element = await describeLocator(target);
        if (isHidden(element, fieldDef)) return { ok: false, skipped: true, reason: `selector resolved to hidden field: ${selector}`, element };
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
        if (count > 1 && !isExactSelector(selector, fieldDef)) {
          const candidates = await logFileInputCandidates(page, fieldName);
          return { ok: false, reason: 'multiple file inputs found; selector is not reliable enough', candidates };
        }
        const element = await describeLocator(target);
        if (isHidden(element, fieldDef)) return { ok: false, skipped: true, reason: `selector resolved to hidden file input: ${selector}`, element };
        if (element && element.tagName !== 'INPUT') {
          return { ok: false, reason: `selector resolved to non-file element ${element.tagName}`, element };
        }
        if (String(element?.type || '').toLowerCase() !== 'file') {
          return { ok: false, reason: `selector resolved to non-file input type ${element?.type || 'unknown'}`, element };
        }
        await target.first().setInputFiles(filePath);
        await page.waitForTimeout(1500);
        return { ok: true };
      }
      case 'cssSelect':
      case 'select': {
        const target = page.locator(selector);
        if (await target.count() === 0) return { ok: false, reason: `select not found: ${selector}` };
        const element = await describeLocator(target);
        if (isHidden(element, fieldDef)) return { ok: false, skipped: true, reason: `selector resolved to hidden select: ${selector}`, element };
        if (element?.tagName !== 'SELECT') {
          return { ok: false, reason: `selector resolved to non-select element ${element?.tagName || 'unknown'}`, element };
        }
        if (element.visible === false && fieldDef.allowHidden) {
          const options = await getSelectOptions(target);
          const exactOption = findExactSelectOption(options, value);
          if (!exactOption) {
            const nonFatal = fieldDef.optional || fieldName === 'secondary_genre' || fieldName.startsWith('apple_music_');
            return { ok: false, skipped: nonFatal, reason: `select option label not found: ${value}`, options };
          }
          await setHiddenSelectValue(target, exactOption.value);
          return { ok: true };
        }
        const selectResult = await target.first().selectOption({ label: String(value) }).catch(async error => ({
          error,
          options: await getSelectOptions(target),
        }));
        if (selectResult?.error) {
          if (fieldDef.allowValueFallback) await target.first().selectOption(String(value)).catch(error => ({ error }));
          else {
            const exactOption = findExactSelectOption(selectResult.options, value);
            if (exactOption) {
              const retry = await target.first().selectOption({ value: exactOption.value }).catch(error => ({ error }));
              if (retry?.error) {
                const nonFatal = fieldDef.optional || fieldName === 'secondary_genre' || fieldName.startsWith('apple_music_');
                return { ok: false, skipped: nonFatal, reason: retry.error.message, options: selectResult.options };
              }
              return { ok: true };
            }
            const nonFatal = fieldDef.optional || fieldName === 'secondary_genre' || fieldName.startsWith('apple_music_');
            return { ok: false, skipped: nonFatal, reason: `select option label not found: ${value}`, options: selectResult.options };
          }
        }
        return { ok: true };
      }
      case 'cssRadio':
      case 'cssCheckbox':
      case 'cssCheck': {
        const target = page.locator(selector);
        if (await target.count() === 0) return { ok: false, reason: `radio/checkbox not found: ${selector}` };
        if (await target.count() > 1 && !isExactSelector(selector, fieldDef)) {
          return { ok: false, reason: `multiple radio/checkbox candidates found for non-exact selector: ${selector}` };
        }
        const element = await describeLocator(target);
        if (isHidden(element, fieldDef)) return { ok: false, skipped: true, reason: `selector resolved to hidden radio/checkbox: ${selector}`, element };
        if (!isCheckableElement(element)) {
          return { ok: false, reason: `selector resolved to non-checkable input type ${element?.type || element?.tagName || 'unknown'}`, element };
        }
        const truthy = toBool(value);
        if (truthy) await target.first().check();
        else if (String(element.type || '').toLowerCase() === 'checkbox') await target.first().uncheck().catch(() => {});
        return { ok: true };
      }
      case 'radioOrCheckbox': {
        const target = page.getByLabel(selector, { exact: false });
        if (await target.count() === 0) return { ok: false, reason: `radio/checkbox not found: ${selector}` };
        const element = await describeLocator(target);
        if (isHidden(element, fieldDef)) return { ok: false, skipped: true, reason: `selector resolved to hidden radio/checkbox: ${selector}`, element };
        if (!isCheckableElement(element)) {
          return { ok: false, reason: `selector resolved to non-checkable input type ${element?.type || element?.tagName || 'unknown'}`, element };
        }
        const truthy = toBool(value);
        if (truthy) await target.first().check();
        else if (String(element.type || '').toLowerCase() === 'checkbox') await target.first().uncheck().catch(() => {});
        return { ok: true };
      }
      case 'dynamicRadioByNamePrefixLabel': {
        const labelText = fieldDef.label_text || (toBool(value) ? 'Yes' : 'No');
        const match = await findVisibleInputByNamePrefixAndLabel(page, 'radio', fieldDef.name_prefix, labelText);
        if (!match) return { ok: false, reason: `visible radio not found for name prefix ${fieldDef.name_prefix} and label ${labelText}` };
        const target = page.locator(`input[type="radio"][name^="${cssAttrValue(fieldDef.name_prefix)}"]`).nth(match.index);
        await target.check();
        await page.waitForTimeout(500);
        return { ok: true };
      }
      case 'dynamicCheckboxByNamePrefix': {
        await page.waitForSelector(`input[type="checkbox"][name^="${cssAttrValue(fieldDef.name_prefix)}"]`, { timeout: 2000 }).catch(() => {});
        const target = page.locator(`input[type="checkbox"][name^="${cssAttrValue(fieldDef.name_prefix)}"]`);
        const count = await target.count();
        if (count === 0 && (fieldDef.labelText || fieldDef.label_text)) {
          return fillField(page, fieldName, { ...fieldDef, strategy: 'checkboxByLabelText' }, value);
        }
        if (count === 0) return { ok: false, skipped: true, reason: `checkbox not found for name prefix ${fieldDef.name_prefix}` };
        if (count > 1 && !fieldDef.allowMultiple) return { ok: false, reason: `multiple checkboxes found for name prefix ${fieldDef.name_prefix}` };
        const element = await describeLocator(target);
        if (isHidden(element, fieldDef)) return { ok: false, skipped: true, reason: `selector resolved to hidden dynamic checkbox: ${fieldDef.name_prefix}`, element };
        if (toBool(value)) await target.first().check();
        else await target.first().uncheck().catch(() => {});
        return { ok: true };
      }
      case 'checkboxByLabelText': {
        const labelText = fieldDef.labelText || fieldDef.label_text || selector;
        const target = page.getByLabel(labelText, { exact: false });
        if (await target.count() === 0) return { ok: false, skipped: true, reason: `checkbox label not found: ${labelText}` };
        const element = await describeLocator(target);
        if (isHidden(element, fieldDef)) return { ok: false, skipped: true, reason: `selector resolved to hidden checkbox label: ${labelText}`, element };
        if (!isCheckableElement(element) || String(element.type || '').toLowerCase() !== 'checkbox') {
          return { ok: false, reason: `label resolved to non-checkbox input type ${element?.type || element?.tagName || 'unknown'}`, element };
        }
        if (toBool(value)) await target.first().check();
        else await target.first().uncheck().catch(() => {});
        return { ok: true };
      }
      case 'clickByText': {
        const text = fieldDef.text || selector;
        if (isDangerousAction(text, dangerousNames)) return { ok: false, reason: `click text looks dangerous: ${text}` };
        const target = page.getByText(text, { exact: fieldDef.exactText === true });
        if (await target.count() === 0) return { ok: false, skipped: true, reason: `click text not found: ${text}` };
        await target.first().click();
        await page.waitForTimeout(fieldDef.waitAfterMs || 500);
        return { ok: true };
      }
      case 'clickModalButton': {
        if (fieldName === 'ai_modal_save') {
          const enforced = await enforceAiDisclosureModal(page, manifest.ai_disclosure || {});
          if (!enforced.ok) return enforced;
        }
        const result = await clickModalButton(page, fieldDef);
        return result;
      }
      case 'smartFill': {
        const result = await smartFillField(page, fieldDef, value);
        return result;
      }
      case 'cssFill':
      case 'fill':
      case 'textarea':
      case 'date': {
        const target = page.locator(selector);
        if (await target.count() === 0) return { ok: false, reason: `field not found: ${selector}` };
        const element = await describeLocator(target);
        if (isHidden(element, fieldDef)) return { ok: false, skipped: true, reason: `selector resolved to hidden field: ${selector}`, element };
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
    visible: (() => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    })(),
  })).catch(() => null);
}

async function getSelectOptions(locator) {
  return locator.first().evaluate(el => [...el.options].map(option => ({
    value: option.value,
    text: option.text,
  }))).catch(() => []);
}

function findExactSelectOption(options, value) {
  const wanted = String(value || '').trim().toLowerCase();
  if (!wanted) return null;
  return (options || []).find(option => String(option.text || '').trim().toLowerCase() === wanted)
    || (options || []).find(option => String(option.value || '').trim().toLowerCase() === wanted)
    || null;
}

async function setHiddenSelectValue(locator, value) {
  await locator.first().evaluate((select, selectedValue) => {
    select.value = selectedValue;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('blur', { bubbles: true }));
  }, value);
}

async function clickModalButton(page, fieldDef) {
  const buttonText = fieldDef.buttonText || fieldDef.selector || 'Save';
  if (isDangerousAction(buttonText, dangerousNames)) return { ok: false, reason: `modal button text looks dangerous: ${buttonText}` };
  const requiredText = fieldDef.modalContainsText || '';
  const result = await page.evaluate(({ buttonText, requiredText }) => {
    const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const containers = [...document.querySelectorAll('[role="dialog"], .modal, .modal-dialog, [aria-modal="true"]')]
      .filter(visible)
      .filter(el => !requiredText || normalize(el.innerText).includes(normalize(requiredText)));
    for (const container of containers) {
      const buttons = [...container.querySelectorAll('button,input[type="button"],input[type="submit"],[role="button"]')]
        .filter(visible);
      const button = buttons.find(el => normalize(el.innerText || el.value || el.getAttribute('aria-label')).includes(normalize(buttonText)));
      if (button) {
        button.click();
        return { ok: true };
      }
    }
    return { ok: false };
  }, { buttonText, requiredText }).catch(error => ({ ok: false, reason: error.message }));
  if (!result.ok) return { ok: false, skipped: true, reason: result.reason || `visible AI modal with ${buttonText} button not found` };
  await page.waitForTimeout(fieldDef.waitAfterMs || 500);
  return { ok: true };
}

async function smartFillField(page, fieldDef, value) {
  const keywords = String(fieldDef.selector || '')
    .split('|')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
  const result = await page.evaluate(({ keywords, value: nextValue }) => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labelsFor = input => {
      const labels = new Set();
      if (input.id) document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).forEach(label => labels.add(label.innerText.trim()));
      input.labels?.forEach?.(label => labels.add(label.innerText.trim()));
      if (input.closest('label')?.innerText) labels.add(input.closest('label').innerText.trim());
      let cursor = input.parentElement;
      for (let depth = 0; cursor && depth < 3; depth += 1, cursor = cursor.parentElement) {
        if (cursor.innerText) labels.add(cursor.innerText.trim());
      }
      return [...labels].filter(Boolean);
    };
    const fillable = input => {
      const tag = String(input.tagName || '').toLowerCase();
      const type = String(input.getAttribute('type') || '').toLowerCase();
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      return !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(type);
    };
    const score = input => {
      const haystack = `${labelsFor(input).join(' ')} ${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-label') || ''} ${input.getAttribute('name') || ''}`.toLowerCase();
      let points = 0;
      for (const keyword of keywords) {
        if (haystack.includes(keyword)) points += keyword.length;
      }
      if (/track\s*\d+/i.test(haystack)) points -= 100;
      return points;
    };
    const candidates = [...document.querySelectorAll('input, textarea')]
      .filter(visible)
      .filter(fillable)
      .map(input => ({
        input,
        score: score(input),
        labels: labelsFor(input),
      }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) {
      return {
        ok: false,
        candidates: [],
        reason: `smart fill target not found for keywords: ${keywords.join(', ')}`,
      };
    }
    best.input.focus();
    best.input.value = String(nextValue ?? '');
    best.input.dispatchEvent(new Event('input', { bubbles: true }));
    best.input.dispatchEvent(new Event('change', { bubbles: true }));
    best.input.dispatchEvent(new Event('blur', { bubbles: true }));
    return {
      ok: true,
      element: {
        id: best.input.id || null,
        name: best.input.getAttribute('name') || null,
        placeholder: best.input.getAttribute('placeholder') || null,
        labels: best.labels,
      },
      candidates: candidates.slice(0, 5).map(candidate => ({
        id: candidate.input.id || null,
        name: candidate.input.getAttribute('name') || null,
        placeholder: candidate.input.getAttribute('placeholder') || null,
        labels: candidate.labels,
      })),
    };
  }, { keywords, value }).catch(error => ({ ok: false, reason: error.message }));
  return result.ok ? { ok: true } : { ok: false, reason: result.reason, candidates: result.candidates || [], element: result.element || null };
}

async function enforceAiDisclosureModal(page, disclosure) {
  const result = await page.evaluate(({ disclosure }) => {
    const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const containers = [...document.querySelectorAll('[role="dialog"], .modal, .modal-dialog, [aria-modal="true"]')]
      .filter(visible)
      .filter(el => normalize(el.innerText).includes('which parts of this song were ai-generated?'));
    const modal = containers[0];
    if (!modal) return { ok: false, skipped: true, reason: 'visible AI disclosure modal not found' };

    const labelsFor = input => {
      const labels = new Set();
      if (input.id) modal.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).forEach(label => labels.add(label.innerText));
      if (input.closest('label')?.innerText) labels.add(input.closest('label').innerText);
      let cursor = input.parentElement;
      for (let depth = 0; cursor && depth < 3 && cursor !== modal; depth += 1, cursor = cursor.parentElement) {
        if (cursor.innerText) labels.add(cursor.innerText);
      }
      return [...labels].map(normalize);
    };
    const findCheckbox = labelText => {
      const wanted = normalize(labelText);
      const checkboxes = [...modal.querySelectorAll('input[type="checkbox"]')].filter(visible);
      return checkboxes.find(input => labelsFor(input).some(label => label === wanted))
        || checkboxes.find(input => labelsFor(input).some(label => label.includes(wanted)));
    };
    const setChecked = (labelText, checked) => {
      const input = findCheckbox(labelText);
      if (!input) return { labelText, ok: false };
      if (input.checked !== checked) {
        input.click();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { labelText, ok: true, checked: input.checked };
    };
    const checkboxResults = [
      setChecked('Lyrics', disclosure.lyrics_written_by_ai === true),
      setChecked('Music', disclosure.music_composed_by_ai === true),
      setChecked('All of the audio', disclosure.all_audio_performed_by_ai === true),
      setChecked('Part of the audio', disclosure.part_audio_performed_by_ai_and_humans === true),
    ];
    const personaVisible = normalize(modal.innerText).includes('is pancake robot a human artist or an ai persona?');
    return {
      ok: checkboxResults.every(item => item.ok),
      checkboxResults,
      personaVisible,
    };
  }, { disclosure }).catch(error => ({ ok: false, reason: error.message }));

  if (result.personaVisible) {
    if (isPresent(manifest.ai_artist_identity)) {
      addSkipped({ field: 'ai_artist_identity', status: 'skipped_manual', reason: `AI artist identity question visible; manifest value present but not yet mapped: ${manifest.ai_artist_identity}` });
    } else {
      addSkipped({ field: 'ai_artist_identity', status: 'skipped_manual', reason: 'AI artist identity question visible; no manifest value provided' });
    }
  }
  if (!result.ok) {
    return { ok: false, skipped: true, reason: result.reason || `AI disclosure modal checkbox not found: ${(result.checkboxResults || []).filter(item => !item.ok).map(item => item.labelText).join(', ')}` };
  }
  return { ok: true };
}

function isFillableElement(element) {
  if (!element) return false;
  const tag = String(element.tagName || '').toUpperCase();
  const type = String(element.type || '').toLowerCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'hidden'].includes(type);
}

function isCheckableElement(element) {
  if (!element) return false;
  const tag = String(element.tagName || '').toUpperCase();
  const type = String(element.type || '').toLowerCase();
  return tag === 'INPUT' && ['checkbox', 'radio'].includes(type);
}

function isHidden(element, fieldDef = {}) {
  return !fieldDef.allowHidden && element && element.visible === false;
}

function isExactSelector(selector, fieldDef = {}) {
  if (fieldDef.exact) return true;
  return /^#[A-Za-z][\w:-]*$/.test(String(selector || ''));
}

function toBool(value) {
  return value === true || ['true', 'yes', '1', 'on'].includes(String(value).toLowerCase());
}

function cssAttrValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isCertificationSelectorAllowed(selector, fieldDef = {}) {
  const normalized = String(selector || '').trim();
  if (fieldDef.conditional_certification === true) return CONDITIONAL_CERTIFICATION_CHECKBOXES.has(normalized);
  return IMPORTANT_CERTIFICATION_CHECKBOXES.has(normalized);
}

function isPageClosedError(reason) {
  return /target page, context or browser has been closed|page is closed/i.test(String(reason || ''));
}

function getCertificationValue(manifest, fieldDef = {}) {
  if (fieldDef.category !== 'certification') return null;
  if (!certifyImportantCheckboxes) return null;
  const selector = String(fieldDef.selector || '').trim();
  if (IMPORTANT_CERTIFICATION_CHECKBOXES.has(selector)) return true;
  if (CONDITIONAL_CERTIFICATION_CHECKBOXES.has(selector)) return getFieldValue(manifest, fieldDef.manifest_key, fieldDef);
  return null;
}

function getOrderedFields(fields) {
  const entries = Object.entries(fields);
  return entries
    .map((entry, index) => ({ entry, index, order: fieldOrder(entry[0], entry[1]) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(item => item.entry);
}

function fieldOrder(fieldName, fieldDef = {}) {
  if (fieldDef.strategy === 'inputFile') return 60;
  if (fieldDef.category === 'certification') return 50;
  if (fieldName.startsWith('apple_music_')) return 40;
  if (fieldName.startsWith('songwriter_')) return 30;
  if (fieldName.startsWith('ai_')) return 20;
  return 10;
}

async function findVisibleInputByNamePrefixAndLabel(page, type, namePrefix, labelText) {
  return page.evaluate(({ type, namePrefix, labelText }) => {
    const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const wanted = normalize(labelText);
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labelsFor = el => {
      const labels = new Set();
      if (el.id) document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach(label => labels.add(label.innerText));
      if (el.closest('label')?.innerText) labels.add(el.closest('label').innerText);
      let cursor = el.parentElement;
      for (let depth = 0; cursor && depth < 3; depth += 1, cursor = cursor.parentElement) {
        if (cursor.innerText) labels.add(cursor.innerText);
      }
      return [...labels];
    };
    const candidates = [...document.querySelectorAll(`input[type="${type}"]`)]
      .filter(el => String(el.getAttribute('name') || '').startsWith(namePrefix))
      .map((el, index) => ({ el, index }))
      .filter(({ el }) => visible(el));
    const exact = candidates.find(({ el }) => labelsFor(el).some(label => normalize(label) === wanted));
    if (exact) return { index: exact.index };
    const includes = candidates.find(({ el }) => labelsFor(el).some(label => normalize(label).includes(wanted)));
    return includes ? { index: includes.index } : null;
  }, { type, namePrefix, labelText }).catch(() => null);
}

async function installSafetyGuard(page, dangerousNames, options = {}) {
  await page.addInitScript(({ names, allowSubmit }) => {
    const normalize = value => String(value || '').trim().toLowerCase().replace(/[^\p{L}\p{N}#&]+/gu, ' ').replace(/\s+/g, ' ');
    const safeClickTexts = new Set(['add credits for each song on this release']);
    const dangerous = text => {
      const normalized = normalize(text);
      if (!normalized || safeClickTexts.has(normalized)) return false;
      if (normalized === '#donebutton' || normalized === 'donebutton') return true;
      return names.some(name => normalized === normalize(name));
    };
    document.addEventListener('click', event => {
      const target = event.target?.closest?.('button,a,input,[role="button"]');
      if (!target) return;
      const text = target.innerText || target.value || target.getAttribute('aria-label') || target.getAttribute('name') || '';
      if (dangerous(text) || target.id === 'doneButton') {
        if (allowSubmit && (target.id === 'doneButton' || normalize(text) === 'submit' || normalize(text) === 'submit release')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        console.warn(`Blocked dangerous DistroKid action: ${text}`);
      }
    }, true);
  }, { names: dangerousNames, allowSubmit: options.allowSubmit === true });
}

async function submitRelease(page, fieldMap = {}) {
  const selector = fieldMap.submit_selector || '#doneButton';
  if (selector) {
    const target = page.locator(selector).first();
    if (await target.count().catch(() => 0)) {
      await target.click();
      await page.waitForTimeout(3000);
      await saveScreenshot(page, 'screenshot-after-submit.png');
      return { ok: true, selector };
    }
  }
  for (const text of ['Submit release', 'Submit', 'Done']) {
    const target = page.getByRole('button', { name: text, exact: true }).first();
    if (await target.count().catch(() => 0)) {
      await target.click();
      await page.waitForTimeout(3000);
      await saveScreenshot(page, 'screenshot-after-submit.png');
      return { ok: true, text };
    }
  }
  return { ok: false, reason: `submit control not found (${selector})` };
}

async function auditDangerousButtons(page, dangerousNames) {
  const found = [];
  for (const name of dangerousNames) {
    const count = await page.getByRole('button', { name, exact: true }).count().catch(() => 0);
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
  if (!page || page.isClosed()) return;
  await page.screenshot({ path: join(runDir, filename), fullPage: true }).catch(() => {});
}

async function savePageSnapshot(page) {
  if (!page || page.isClosed()) return;
  const text = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');
  writeText(join(runDir, 'page-text-snapshot.txt'), text);
  writeText(join(runDir, 'html-snapshot.html'), html);
}

async function finish(context, skipBrowserClose) {
  if (finished) return;
  finished = true;
  if (finalStatus === 'pending') {
    if (errors.some(item => item.field === 'auth')) {
      finalStatus = 'blocked';
      finalCode = 'distrokid_login_required';
      finalMessage = 'DistroKid login required. Complete login in the browser, then resume.';
      exitCode = BLOCKED_LOGIN_EXIT_CODE;
    } else if (errors.some(item => isBlockedValidationCode(item.code))) {
      finalStatus = 'blocked';
      finalCode = errors.find(item => isBlockedValidationCode(item.code))?.code || BLOCKED_UPLOAD_VALIDATION_CODE;
      finalMessage = errors.find(item => isBlockedValidationCode(item.code))?.error || 'DistroKid upload blocked by validation.';
      exitCode = BLOCKED_UPLOAD_VALIDATION_EXIT_CODE;
    } else if (errors.length) {
      finalStatus = 'failed';
      finalCode = 'distrokid_automation_failed';
      finalMessage = errors[0]?.error || 'DistroKid automation failed.';
      exitCode = 1;
    } else {
      finalStatus = liveSubmit ? 'complete' : 'complete';
      finalCode = liveSubmit ? 'distrokid_live_submit_complete' : 'distrokid_preview_ready';
      finalMessage = liveSubmit ? 'DistroKid live submit finished.' : 'DistroKid preview finished.';
      exitCode = 0;
    }
  }
  runLog.finished_at = new Date().toISOString();
  runLog.filled_count = filledFields.length;
  runLog.skipped_count = skippedFields.length;
  runLog.error_count = errors.length;
  runLog.final_status = finalStatus;
  runLog.final_code = finalCode;
  runLog.final_message = finalMessage;
  writeJson(join(runDir, 'run-log.json'), runLog);
  writeJson(join(runDir, 'filled-fields.json'), filledFields);
  writeJson(join(runDir, 'skipped-fields.json'), skippedFields);
  writeJson(join(runDir, 'errors.json'), errors);
  const authError = errors.some(item => item.field === 'auth');
  const validationBlocked = errors.some(item => isBlockedValidationCode(item.code)) || isBlockedValidationCode(finalCode);
  markManifestJobs(
    authError
      ? DISTROKID_JOB_STATUSES.AUTH_NEEDED
      : validationBlocked
        ? DISTROKID_JOB_STATUSES.BLOCKED_UPLOAD_VALIDATION
        : errors.length
          ? DISTROKID_JOB_STATUSES.FAILED
          : liveSubmit
            ? DISTROKID_JOB_STATUSES.SUBMITTED
            : DISTROKID_JOB_STATUSES.AWAITING_MANUAL_REVIEW,
    {
      latest_run_log_path: relativeToRepo(join(runDir, 'run-log.json')),
      latest_error_json: errors.length ? { errors } : null,
    }
  );
  process.exitCode = exitCode;

  console.log('');
  printUploadSummary();
  console.log(`Package: output/release-packages/${manifestEntityId}/`);
  console.log(`Screenshots/logs: ${relativeToRepo(runDir)}`);
  if (skippedFields.length) {
    console.log('Skipped fields:');
    for (const item of skippedFields) console.log(`- ${item.field}: ${item.reason}`);
  }
  if (liveSubmit) {
    console.log('Live submit completed if DistroKid accepted the final click. Confirm the release URL in DistroKid.');
  } else {
    console.log('Manual next steps: review DistroKid, fill skipped fields, and submit manually only when ready.');
    console.log(`After manual submission: bash scripts/pancake.sh distrokid:mark-submitted --song-id ${manifestJobSongIds[0] || manifestEntityId} --distrokid-url URL`);
  }

  if (context && pauseAtEnd && !skipBrowserClose) {
    console.log('Browser remains open for manual review. Close it when done.');
    await waitForBrowserClose(context, page);
  } else if (context) {
    await context.close().catch(() => {});
  }
}

async function seedPersistentContext(context, storageState) {
  if (!storageState?.cookies?.length) return;
  try {
    await context.addCookies(storageState.cookies);
  } catch {}
}

function installAuthPersistence(context, page) {
  const saver = async (trigger) => {
    if (!page || page.isClosed()) return false;
    if (!(await detectLoggedInDistroKidPage(page))) return false;
    try {
      await context.storageState({ path: DISTROKID_AUTH_PATH });
      console.log(`[auth] Saved DistroKid session (${trigger})`);
      return true;
    } catch {
      return false;
    }
  };
  page.on('framenavigated', () => { void saver('framenavigated'); });
  page.on('load', () => { void saver('load'); });
}

async function detectAuthRequired(page) {
  const url = String(page?.url?.() || '').toLowerCase();
  if (url.includes('/signin') || url.includes('/sign-in') || url.includes('accounts.google.com')) return true;
  const text = String(await page.locator('body').innerText().catch(() => '')).toLowerCase();
  return text.includes('sign in with google')
    || text.includes("couldn't sign you in")
    || text.includes('log in')
    || text.includes('sign in');
}

async function detectLoggedInDistroKidPage(page) {
  const url = String(page?.url?.() || '').toLowerCase();
  if (!url.includes('distrokid.com') || url.includes('/signin') || url.includes('/sign-in')) return false;
  const text = String(await page.locator('body').innerText().catch(() => '')).toLowerCase();
  return url.includes('/new')
    || text.includes('upload')
    || text.includes('my music');
}

async function blockForLogin(context, page, message) {
  const error = { field: 'auth', error: message, code: 'distrokid_login_required' };
  errors.push(error);
  finalStatus = 'blocked';
  finalCode = 'distrokid_login_required';
  finalMessage = message;
  exitCode = BLOCKED_LOGIN_EXIT_CODE;
  markManifestJobs(DISTROKID_JOB_STATUSES.AUTH_NEEDED, {
    latest_run_log_path: relativeToRepo(join(runDir, 'run-log.json')),
    latest_error_json: error,
  });
  await saveScreenshot(page, 'screenshot-auth-required.png');
  await savePageSnapshot(page);
  emitRunEvent({
    status: 'blocked',
    code: finalCode,
    message,
    latest_run_log_path: relativeToRepo(join(runDir, 'run-log.json')),
  });
  await finish(context, !headed);
}

function emitRunEvent(payload) {
  console.log(`${DISTROKID_RUN_EVENT_PREFIX}${JSON.stringify(payload)}`);
}

function collectManifestSongIds(manifest) {
  if (Array.isArray(manifest?.tracks) && manifest.tracks.length) {
    const ids = manifest.tracks.map(track => String(track?.song_id || track?.track_metadata?.id || '').trim()).filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }
  return [String(manifest?.song_id || '').trim()].filter(Boolean);
}

function resolveManifestEntityId(manifest) {
  return String(manifest?.release_id || manifest?.album_id || manifest?.song_id || manifest?.tracks?.[0]?.song_id || '').trim();
}

function markManifestJobs(status, fields = {}) {
  for (const id of manifestJobSongIds) {
    try {
      markDistroKidJobStatus(id, status, fields);
    } catch (error) {
      if (!/Song not found/i.test(error.message)) throw error;
    }
  }
}

function printUploadSummary() {
  console.log(`Filled: ${filledFields.length}`);
  console.log(`Skipped: ${skippedFields.length}`);
  console.log(`Failed: ${errors.length}`);
  const groups = [
    ['Files uploaded', ['audio_file', 'cover_art']],
    ['Core metadata filled', ['artist', 'release_title', 'track_title', 'primary_genre', 'secondary_genre', 'language', 'explicit', 'not_explicit', 'clean_always', 'contains_lyrics', 'instrumental', 'original_song', 'lyrics', 'release_date', 'made_for_kids']],
    ['Songwriter credits filled', ['songwriter_role', 'songwriter_first', 'songwriter_middle', 'songwriter_last']],
    ['Apple Music credits filled', ['apple_music_credits_expand', 'apple_music_performer_role', 'apple_music_performer_name', 'apple_music_producer_role', 'apple_music_producer_name']],
  ];
  for (const [title, names] of groups) {
    const items = filledFields.filter(item => names.includes(item.field));
    console.log(`${title}: ${items.map(item => item.field).join(', ') || 'none'}`);
  }
  printAiDisclosureSummary();
  const certificationFilled = filledFields.filter(item => item.category === 'certification');
  const certificationSkipped = skippedFields.filter(item => item.status && ['checked', 'skipped_manual', 'unavailable', 'blocked_not_allowlisted'].includes(item.status));
  console.log('Certification checkboxes:');
  if (!certificationFilled.length && !certificationSkipped.length) console.log('- none');
  for (const item of certificationFilled) console.log(`- ${item.field}: checked`);
  for (const item of certificationSkipped) console.log(`- ${item.field}: ${item.status}`);
  const neverAutomated = fieldMap.dangerous_paid_extras_never_autofill || [];
  console.log(`Manual remaining fields: ${skippedFields.filter(item => item.status !== 'blocked_not_allowlisted').map(item => item.field).join(', ') || 'none'}`);
  console.log(`Never automated fields: final submit, Continue${neverAutomated.length ? `, ${neverAutomated.join(', ')}` : ''}`);
}

function printAiDisclosureSummary() {
  const disclosure = manifest.ai_disclosure || {};
  const filledNames = new Set(filledFields.map(item => item.field));
  const checked = value => value === true ? 'checked' : 'unchecked';
  console.log('AI disclosure filled:');
  console.log(`- ai_generated_gate: ${filledNames.has('ai_generated_gate') && disclosure.uses_ai === true ? 'yes' : 'none'}`);
  console.log(`- ai_lyrics: ${checked(disclosure.lyrics_written_by_ai)}`);
  console.log(`- ai_music: ${checked(disclosure.music_composed_by_ai)}`);
  console.log(`- ai_all_audio: ${checked(disclosure.all_audio_performed_by_ai)}`);
  console.log(`- ai_part_audio: ${checked(disclosure.part_audio_performed_by_ai_and_humans)}`);
}

async function waitForBrowserClose(context, page) {
  const browser = context?.browser?.() || null;
  const isBrowserClosed = await Promise.resolve(browser?.isConnected?.() === false).catch(() => true);
  if (!context || isBrowserClosed) return;
  if (page?.isClosed?.()) return;

  await new Promise(resolve => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    try { browser?.on('disconnected', done); } catch {}
    try { context.on('close', done); } catch {}
    try { page?.on('close', done); } catch {}

    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await context.close().catch(() => {});
}

function addSkipped(item) {
  skippedFields.push(item);
  runLog.diagnostics.skipped_fields.push(item);
}

function resolveArtworkPath(currentManifest, overridePath) {
  if (!isPresent(overridePath)) return currentManifest.cover_art || null;
  const resolvedPath = absoluteFromMaybeRelative(overridePath);
  if (!exists(resolvedPath)) {
    errors.push({ field: 'cover_art', error: `cover_art not found: ${overridePath}` });
    return currentManifest.cover_art || null;
  }
  return resolvedPath;
}

function normalizeReleaseDateValue(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === normalized ? normalized : null;
}

function logRunStep(message) {
  const entry = { at: new Date().toISOString(), message };
  runLog.diagnostics.lifecycle.push(entry);
  console.log(`[distrokid] ${message}`);
}

function getTrackCountPhaseLabel(trackCount) {
  return getTrackCountLabel(trackCount);
}

function getTrackCountLabel(trackCount) {
  return `${trackCount} song${trackCount === 1 ? '' : 's'}`;
}

const loggedFieldPhases = new Set();

function logFieldPhase(fieldName, currentManifest) {
  const trackCount = Array.isArray(currentManifest?.tracks) ? currentManifest.tracks.length : 1;
  if (fieldName === 'release_title' || fieldName === 'artist' || fieldName === 'primary_genre' || fieldName === 'language') {
    if (!loggedFieldPhases.has('album_metadata')) {
      loggedFieldPhases.add('album_metadata');
      logRunStep('filling album metadata');
    }
    return;
  }
  if (fieldName === 'cover_art') {
    if (!loggedFieldPhases.has('artwork')) {
      loggedFieldPhases.add('artwork');
      logRunStep(dryRun ? 'uploading artwork in preview mode' : 'uploading artwork');
    }
    return;
  }
  const trackMatch = String(fieldName || '').match(/_track_(\d+)$/);
  if (trackMatch) {
    const trackNumber = Number(trackMatch[1]) || 1;
    const key = `track_${trackNumber}`;
    if (!loggedFieldPhases.has(key)) {
      loggedFieldPhases.add(key);
      logRunStep(`filling track ${trackNumber}/${trackCount}`);
    }
  }
}

function isBlockedValidationCode(code) {
  return [BLOCKED_UPLOAD_VALIDATION_CODE, BLOCKED_FILL_VALIDATION_CODE].includes(String(code || ''));
}

async function waitForAlbumFormReady(page, currentManifest, currentFieldMap) {
  const expectedTrackCount = Array.isArray(currentManifest?.tracks) ? currentManifest.tracks.length : 1;
  const titleSelector = currentFieldMap?.fields?.release_title?.selector || '';
  const artistSelector = currentFieldMap?.fields?.artist?.selector || '';
  await page.waitForFunction(({ count, titleSelector: releaseSelector, artistSelector: bandSelector }) => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labelsFor = input => {
      const labels = new Set();
      if (input.id) document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).forEach(label => labels.add(label.innerText));
      input.labels?.forEach?.(label => labels.add(label.innerText));
      if (input.closest('label')?.innerText) labels.add(input.closest('label').innerText);
      let cursor = input.parentElement;
      for (let depth = 0; cursor && depth < 3; depth += 1, cursor = cursor.parentElement) {
        if (cursor.innerText) labels.add(cursor.innerText);
      }
      return [...labels].join(' ').toLowerCase();
    };
    const renderedTrackCount = (() => {
      const audioInputs = [...document.querySelectorAll('input[type="file"]')]
        .filter(visible)
        .filter(input => {
          const signature = `${input.id || ''} ${input.getAttribute('name') || ''} ${input.className || ''}`.toLowerCase();
          const accept = String(input.getAttribute('accept') || '').toLowerCase();
          if (/artwork|cover/.test(signature) || /image/.test(accept)) return false;
          return /track|upload|audio|song/.test(signature);
        })
        .length;
      const titleInputs = [...document.querySelectorAll('input')]
        .filter(visible)
        .filter(input => /^(title_|track-title)/i.test(String(input.id || '')) || /^title_/i.test(String(input.getAttribute('name') || '')))
        .length;
      return Math.max(audioInputs, titleInputs);
    })();
    if (renderedTrackCount < count) return false;

    const candidates = [...document.querySelectorAll('input, textarea, select')].filter(visible);
    const globalFieldVisible = selector => {
      if (!selector) return false;
      return candidates.some(input => {
        try {
          return input.matches(selector);
        } catch {
          return false;
        }
      });
    };
    const heuristicVisible = keywordList => candidates.some(input => {
      const context = `${labelsFor(input)} ${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-label') || ''}`.toLowerCase();
      return keywordList.some(keyword => context.includes(keyword));
    });
    return globalFieldVisible(releaseSelector)
      || globalFieldVisible(bandSelector)
      || heuristicVisible(['album title', 'release title', 'album', 'artist', 'band name']);
  }, { count: expectedTrackCount, titleSelector, artistSelector }, { timeout: 15000 }).catch(() => {});

  await page.waitForTimeout(500).catch(() => {});
  return page.evaluate(() => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const countVisible = selector => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    };
    return {
      captured_at: new Date().toISOString(),
      visible_input_count: [...document.querySelectorAll('input,textarea,select')].filter(visible).length,
      track_title_input_count: [...document.querySelectorAll('input')]
        .filter(visible)
        .filter(input => /^(title_|track-title)/i.test(String(input.id || '')) || /^title_/i.test(String(input.getAttribute('name') || '')))
        .length,
      file_input_count: countVisible('input[type="file"]'),
    };
  }).catch(() => ({ captured_at: new Date().toISOString() }));
}

async function validateFilledDistroKidForm(page, currentManifest, currentFieldMap) {
  const expectedTrackCount = Array.isArray(currentManifest?.tracks) ? currentManifest.tracks.length : 1;
  const expectedAlbumTitle = String(currentManifest.release_title || currentManifest.album_metadata?.title || '').trim();
  const expectedTrackTitles = (Array.isArray(currentManifest.tracks) && currentManifest.tracks.length
    ? currentManifest.tracks
    : [currentManifest]).map(track => String(track?.track_title || '').trim());
  const snapshot = await inspectFilledDistroKidForm(page, currentFieldMap);
  const targetIndexes = [...new Set([
    0,
    Math.max(0, Math.floor((expectedTrackCount - 1) / 2)),
    Math.max(0, expectedTrackCount - 1),
  ])];
  const failingTrackIndex = findFirstMissingTrackIndex(expectedTrackTitles, snapshot.trackTitleFields);
  const albumTitleMatches = !expectedAlbumTitle || snapshot.albumTitleField.value === expectedAlbumTitle;
  const renderedTrackCountMatches = Number(snapshot.renderedTrackCount || 0) >= expectedTrackCount;
  const sampledTracksMatch = targetIndexes.every(index => {
    const expected = expectedTrackTitles[index] || '';
    const actual = snapshot.trackTitleFields[index]?.value || '';
    return !expected || expected === actual;
  });
  const filledTrackCount = snapshot.trackTitleFields.filter(field => field.value).length;
  const artworkUploadAttempted = filledFields.some(item => item.field === 'cover_art');
  const artworkUploadExplicitlySkipped = skippedFields.some(item => item.field === 'cover_art');
  const ok = albumTitleMatches
    && renderedTrackCountMatches
    && sampledTracksMatch
    && filledTrackCount >= expectedTrackCount
    && (artworkUploadAttempted || artworkUploadExplicitlySkipped);

  const validation = {
    ok,
    expectedAlbumTitle,
    detectedAlbumTitleFieldCandidates: snapshot.albumTitleCandidates,
    expectedTrackCount,
    renderedTrackCount: snapshot.renderedTrackCount,
    filledTrackCount,
    expectedTrackTitles: summarizeTrackTitleExpectations(expectedTrackTitles, targetIndexes),
    actualTrackTitles: summarizeTrackTitleActuals(snapshot.trackTitleFields, targetIndexes),
    firstMissingFailingTrackIndex: failingTrackIndex,
    artworkPath: runLog.resolved_artwork_path || currentManifest.cover_art || null,
    artworkUploadAttempted,
    dryRunSuppressedUpload: false,
    artworkUploadExplicitlySkipped,
    selectorCandidates: {
      albumTitle: snapshot.albumTitleCandidates,
      artworkInput: snapshot.artworkCandidates,
      trackTitleFields: snapshot.trackTitleCandidates,
    },
  };
  validation.summary = ok
    ? 'Filled DistroKid form validation passed.'
    : `DistroKid form validation failed. Expected album title "${expectedAlbumTitle}", rendered ${snapshot.renderedTrackCount}/${expectedTrackCount} track groups, filled ${filledTrackCount}/${expectedTrackCount} track titles.`;
  writeJson(join(runDir, 'fill-validation.json'), validation);
  return validation;
}

function summarizeTrackTitleExpectations(expectedTrackTitles, indexes) {
  return indexes.map(index => ({ index: index + 1, value: expectedTrackTitles[index] || '' }));
}

function summarizeTrackTitleActuals(trackTitleFields, indexes) {
  return indexes.map(index => ({ index: index + 1, value: trackTitleFields[index]?.value || '' }));
}

function findFirstMissingTrackIndex(expectedTrackTitles, actualFields) {
  for (let index = 0; index < expectedTrackTitles.length; index += 1) {
    const expected = String(expectedTrackTitles[index] || '').trim();
    const actual = String(actualFields[index]?.value || '').trim();
    if (expected && expected !== actual) return index + 1;
  }
  return null;
}

async function inspectFilledDistroKidForm(page, currentFieldMap) {
  const releaseTitleSelector = currentFieldMap?.fields?.release_title?.selector || '';
  const artworkSelector = currentFieldMap?.fields?.cover_art?.selector || '';
  return page.evaluate(({ releaseTitleSelector: titleSelector, artworkSelector: coverSelector }) => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labelsFor = input => {
      const labels = new Set();
      if (input.id) document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).forEach(label => labels.add(label.innerText.trim()));
      input.labels?.forEach?.(label => labels.add(label.innerText.trim()));
      if (input.closest('label')?.innerText) labels.add(input.closest('label').innerText.trim());
      let cursor = input.parentElement;
      for (let depth = 0; cursor && depth < 3; depth += 1, cursor = cursor.parentElement) {
        if (cursor.innerText) labels.add(cursor.innerText.trim());
      }
      return [...labels].filter(Boolean);
    };
    const describe = input => ({
      id: input.id || null,
      name: input.getAttribute('name') || null,
      placeholder: input.getAttribute('placeholder') || null,
      ariaLabel: input.getAttribute('aria-label') || null,
      labels: labelsFor(input),
      value: 'value' in input ? String(input.value || '').trim() : '',
      visible: visible(input),
    });
    const allInputs = [...document.querySelectorAll('input, textarea')].filter(visible);
    const albumTitleCandidates = allInputs
      .filter(input => {
        const text = `${labelsFor(input).join(' ')} ${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-label') || ''}`.toLowerCase();
        if (titleSelector) {
          try {
            if (input.matches(titleSelector)) return true;
          } catch {}
        }
        return /album title|release title/.test(text);
      })
      .map(describe);
    const albumTitleField = albumTitleCandidates[0] || { value: '' };
    const trackTitleFields = allInputs
      .filter(input => /^(title_|track-title)/i.test(String(input.id || '')) || /^title_/i.test(String(input.getAttribute('name') || '')))
      .map(describe);
    const trackTitleCandidates = trackTitleFields.slice(0, 10);
    const artworkCandidates = [...document.querySelectorAll('input[type="file"]')]
      .filter(input => {
        const text = `${labelsFor(input).join(' ')} ${input.id || ''} ${input.getAttribute('name') || ''} ${input.getAttribute('accept') || ''}`.toLowerCase();
        if (coverSelector) {
          try {
            if (input.matches(coverSelector)) return true;
          } catch {}
        }
        return /artwork|cover|image/.test(text);
      })
      .map(describe);
    return {
      albumTitleField,
      albumTitleCandidates,
      trackTitleFields,
      trackTitleCandidates,
      artworkCandidates,
      renderedTrackCount: trackTitleFields.length,
    };
  }, { releaseTitleSelector, artworkSelector }).catch(() => ({
    albumTitleField: { value: '' },
    albumTitleCandidates: [],
    trackTitleFields: [],
    trackTitleCandidates: [],
    artworkCandidates: [],
    renderedTrackCount: 0,
  }));
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

async function loadDistroKidJobBindings() {
  try {
    const jobs = await import('../../src/shared/distrokid-jobs.js');
    DISTROKID_JOB_STATUSES = jobs.DISTROKID_JOB_STATUSES || DISTROKID_JOB_STATUSES;
    getDistroKidJob = jobs.getDistroKidJob || getDistroKidJob;
    markDistroKidJobStatus = jobs.markDistroKidJobStatus || markDistroKidJobStatus;
  } catch {}
}

function normalizeDistroKidManifest(manifest) {
  let changed = false;
  const normalized = { ...manifest };
  normalized.field_sources = normalized.field_sources && typeof normalized.field_sources === 'object'
    ? { ...normalized.field_sources }
    : {};
  if (!isPresent(normalized.primary_genre)) {
    normalized.primary_genre = PANCAKE_ROBOT_DISTROKID_DEFAULTS.primary_genre;
    normalized.field_sources.primary_genre = 'pancake_robot_default';
    changed = true;
  }
  for (const key of ['ai_disclosure', 'songwriter_real_name', 'apple_music_credits', 'rights_confirmations']) {
    const result = mergeMissingDefaults(normalized[key], PANCAKE_ROBOT_DISTROKID_DEFAULTS[key], normalized.field_sources[key]);
    normalized[key] = result.value;
    normalized.field_sources[key] = result.sources;
    changed = changed || result.changed;
  }
  const aiResult = normalizePancakeRobotAiDisclosure(normalized.ai_disclosure, normalized.field_sources.ai_disclosure);
  normalized.ai_disclosure = aiResult.value;
  normalized.field_sources.ai_disclosure = aiResult.sources;
  changed = changed || aiResult.changed;
  if (changed) console.log('Manifest normalized with Pancake Robot DistroKid defaults');
  return normalized;
}

function normalizePancakeRobotAiDisclosure(current, currentSources) {
  const value = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  const sources = currentSources && typeof currentSources === 'object' && !Array.isArray(currentSources) ? { ...currentSources } : {};
  let changed = false;
  for (const [key, defaultValue] of Object.entries(PANCAKE_ROBOT_DISTROKID_DEFAULTS.ai_disclosure)) {
    if (value[key] !== defaultValue) {
      value[key] = defaultValue;
      sources[key] = 'pancake_robot_default';
      changed = true;
    }
  }
  return { value, sources, changed };
}

function mergeMissingDefaults(current, defaults, currentSources) {
  const value = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  const sources = currentSources && typeof currentSources === 'object' && !Array.isArray(currentSources) ? { ...currentSources } : {};
  let changed = false;
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
      const nested = mergeMissingDefaults(value[key], defaultValue, sources[key]);
      value[key] = nested.value;
      sources[key] = nested.sources;
      changed = changed || nested.changed;
      continue;
    }
    if (isMissingForDefault(value[key], defaultValue)) {
      value[key] = defaultValue;
      sources[key] = 'pancake_robot_default';
      changed = true;
    }
  }
  return { value, sources, changed };
}

function isMissingForDefault(value, defaultValue) {
  if (defaultValue === '') return value === null || value === undefined;
  return !isPresent(value) && value !== false;
}

function getFieldValue(manifest, fieldName, fieldDef) {
  if (Object.hasOwn(fieldDef, 'value')) return fieldDef.value;
  if (fieldDef.value_source === 'has_lyrics_file') {
    return Boolean(manifest.lyrics_file && exists(absoluteFromMaybeRelative(manifest.lyrics_file)));
  }
  if (fieldDef.value_source === 'instrumental_from_manifest') {
    return manifest.instrumental === true || manifest.is_instrumental === true;
  }
  return getManifestValue(manifest, fieldDef.manifest_key || fieldName);
}

function getManifestValue(manifest, key) {
  if (key === 'lyrics_file' && manifest.lyrics_file) {
    return fs.readFileSync(absoluteFromMaybeRelative(manifest.lyrics_file), 'utf8');
  }
  if (!String(key || '').includes('.')) return manifest[key];
  return String(key).split('.').reduce((value, part) => value?.[part], manifest);
}

function shouldRunField(manifest, fieldDef = {}) {
  if (!fieldDef.when) return { ok: true };
  const conditions = Array.isArray(fieldDef.when) ? fieldDef.when : [fieldDef.when];
  for (const condition of conditions) {
    const value = condition.value_source
      ? getFieldValue(manifest, condition.manifest_key || condition.value_source, condition)
      : getManifestValue(manifest, condition.manifest_key);
    if (Object.hasOwn(condition, 'equals') && value !== condition.equals) {
      return { ok: false, reason: `condition not met: ${condition.manifest_key || condition.value_source} !== ${condition.equals}` };
    }
    if (Object.hasOwn(condition, 'notEquals') && value === condition.notEquals) {
      return { ok: false, reason: `condition not met: ${condition.manifest_key || condition.value_source} === ${condition.notEquals}` };
    }
    if (condition.exists === true && !isPresent(value)) {
      return { ok: false, reason: `condition not met: ${condition.manifest_key || condition.value_source} missing` };
    }
    if (condition.truthy === true && !toBool(value)) {
      return { ok: false, reason: `condition not met: ${condition.manifest_key || condition.value_source} is not true` };
    }
    if (condition.truthy === false && toBool(value)) {
      return { ok: false, reason: `condition not met: ${condition.manifest_key || condition.value_source} is true` };
    }
  }
  return { ok: true };
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
