#!/usr/bin/env node

import fs from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { DANGEROUS_BUTTON_NAMES, REPO_ROOT, isDangerousAction } from './lib.mjs';

let passed = 0;
let failed = 0;

checkFile('scripts/distrokid/lib.mjs');
checkFile('scripts/distrokid/save-auth.mjs');
checkFile('scripts/distrokid/check-auth.mjs');
checkFile('scripts/distrokid/build-release-package.mjs');
checkFile('scripts/distrokid/upload-release.mjs');
checkFile('scripts/distrokid/batch-upload.mjs');
checkFile('scripts/distrokid/queue-song.mjs');
checkFile('scripts/distrokid/run-queued.mjs');
checkFile('scripts/distrokid/mark-submitted.mjs');
checkFile('src/shared/distrokid-jobs.js');
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
  'distrokid:queue',
  'distrokid:run-queued',
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
for (const key of ['cover_art', 'audio_file', 'track_title', 'language', 'primary_genre', 'original_song', 'ai_generated_gate', 'ai_all_audio']) {
  assertField(fieldMap, key, 'field map');
}
assert(fieldMap.fields.cover_art.selector === '#artwork' && fieldMap.fields.cover_art.strategy === 'inputFile' && fieldMap.fields.cover_art.manifest_key === 'cover_art' && fieldMap.fields.cover_art.exact === true, 'field map cover art exact upload selector');
assert(fieldMap.fields.audio_file.selector === '#js-track-upload-1' && fieldMap.fields.audio_file.strategy === 'inputFile' && fieldMap.fields.audio_file.manifest_key === 'audio_file' && fieldMap.fields.audio_file.exact === true, 'field map audio exact upload selector');
assert(fieldMap.fields.track_title.selector.includes('input[id^="title_"]') && fieldMap.fields.track_title.strategy === 'cssFill' && fieldMap.fields.track_title.manifest_key === 'track_title', 'field map dynamic track title selector');
assert(fieldMap.fields.language.selector === '#language' && fieldMap.fields.language.strategy === 'cssSelect' && fieldMap.fields.language.manifest_key === 'language' && fieldMap.fields.language.exact === true, 'field map language exact select');
assert(fieldMap.fields.primary_genre.selector === '#genrePrimary' && fieldMap.fields.primary_genre.strategy === 'cssSelect' && fieldMap.fields.primary_genre.manifest_key === 'primary_genre', 'field map primary genre select');
assert(fieldMap.fields.original_song.selector === '#not_coversong_radio_button_1' && fieldMap.fields.original_song.strategy === 'cssRadio' && fieldMap.fields.original_song.exact === true, 'field map original song radio');
assert(fieldMap.fields.ai_generated_gate.strategy === 'dynamicRadioByNamePrefixLabel' && fieldMap.fields.ai_generated_gate.name_prefix === 'ai_gate_' && fieldMap.fields.ai_generated_gate.manifest_key === 'ai_disclosure.uses_ai', 'field map dynamic AI generated gate');
assert(fieldMap.fields.ai_all_audio.strategy === 'checkboxByLabelText' && fieldMap.fields.ai_all_audio.labelText === 'All of the audio' && fieldMap.fields.ai_all_audio.manifest_key === 'ai_disclosure.all_audio_performed_by_ai', 'field map AI all audio by label');
assert(fieldMap.fields.songwriter_role?.manifest_key === 'songwriter_real_name.role', 'field map songwriter role field');
assert(fieldMap.fields.songwriter_first?.selector === 'input[name="songwriter_real_name_first1"]' && fieldMap.fields.songwriter_first?.manifest_key === 'songwriter_real_name.first' && fieldMap.fields.songwriter_first?.exact === true, 'field map songwriter first selector');
assert(fieldMap.fields.songwriter_middle?.selector === 'input[name="songwriter_real_name_middle1"]' && fieldMap.fields.songwriter_middle?.manifest_key === 'songwriter_real_name.middle' && fieldMap.fields.songwriter_middle?.allowEmpty === true, 'field map songwriter middle selector');
assert(fieldMap.fields.songwriter_last?.selector === 'input[name="songwriter_real_name_last1"]' && fieldMap.fields.songwriter_last?.manifest_key === 'songwriter_real_name.last' && fieldMap.fields.songwriter_last?.exact === true, 'field map songwriter last selector');
assert(fieldMap.fields.apple_music_credits_expand?.strategy === 'clickByText' && fieldMap.safe_click_texts?.includes('Add credits for each song on this release'), 'field map Apple Music credits expansion safe click');
assert(fieldMap.fields.apple_music_performer_role?.selector === '#track-1-performer-1-role' && fieldMap.fields.apple_music_performer_role?.manifest_key === 'apple_music_credits.performer.role', 'field map Apple performer role selector');
assert(fieldMap.fields.apple_music_performer_name?.selector === '#track-1-performer-1-name' && fieldMap.fields.apple_music_performer_name?.manifest_key === 'apple_music_credits.performer.name', 'field map Apple performer name selector');
assert(fieldMap.fields.apple_music_producer_role?.selector === '#track-1-producer-1-role' && fieldMap.fields.apple_music_producer_role?.manifest_key === 'apple_music_credits.producer.role', 'field map Apple producer role selector');
assert(fieldMap.fields.apple_music_producer_name?.selector === '#track-1-producer-1-name' && fieldMap.fields.apple_music_producer_name?.manifest_key === 'apple_music_credits.producer.name', 'field map Apple producer name selector');
assertCertificationAllowlist(fieldMap, 'field map');
assertNoUnsafeLabelSelectors(fieldMap, 'field map');
assertNoDangerousPaidExtras(fieldMap, 'field map');

const uploadSrc = readText('scripts/distrokid/upload-release.mjs');
const distroKidGuidance = [
  'scripts/distrokid/save-auth.mjs',
  'scripts/distrokid/check-auth.mjs',
  'scripts/distrokid/build-release-package.mjs',
  'scripts/distrokid/upload-release.mjs',
  'scripts/distrokid/batch-upload.mjs',
  'scripts/distrokid/queue-song.mjs',
  'scripts/distrokid/run-queued.mjs',
  'scripts/distrokid/mark-submitted.mjs',
  'docs/distrokid-uploader.md',
  'docs/distrokid-selector-capture.md',
].map(path => readText(path)).join('\n');
assert(readText('docs/distrokid-uploader.md').includes('npm run distrokid:upload -- --manifest output/release-packages/SONG_ID/manifest.json --dry-run'), 'DistroKid docs primary upload command uses npm script');
assert(readText('docs/distrokid-uploader.md').includes('npm run distrokid:run-queued -- --limit 5 --dry-run'), 'DistroKid docs include queued runner command');
assert(uploadSrc.includes("'live-submit'") && uploadSrc.includes("'confirm-live-submit'"), 'upload supports explicit live submit mode');
assert(uploadSrc.includes('isDangerousAction'), 'upload has dangerous action helper');
assert(uploadSrc.includes('installSafetyGuard'), 'upload installs safety guard');
assert(uploadSrc.includes('waitForBrowserClose'), 'upload has waitForBrowserClose helper');
assert(!uploadSrc.includes("browser.waitForEvent('disconnected')"), 'upload does not call browser.waitForEvent disconnected');
assert(uploadSrc.includes("'discover-fields'") && uploadSrc.includes('discovered-fields.json'), 'upload supports --discover-fields');
assert(uploadSrc.includes("'no-pause'") && uploadSrc.includes("values['no-pause']"), 'upload supports --no-pause');
assert(uploadSrc.includes("'certify-important-checkboxes'") && uploadSrc.includes('Certification checkboxes are legal attestations'), 'upload supports --certify-important-checkboxes with warning');
assert(uploadSrc.includes('normalizeDistroKidManifest') && uploadSrc.includes('Manifest normalized with Pancake Robot DistroKid defaults'), 'upload normalizes stale manifests');
assert(uploadSrc.includes("case 'cssFill'") && uploadSrc.includes("case 'cssSelect'"), 'upload supports css selectors');
assert(uploadSrc.includes("case 'cssRadio'") && uploadSrc.includes("case 'cssCheckbox'"), 'upload supports css radio/check selectors');
assert(uploadSrc.includes('dynamicRadioByNamePrefixLabel'), 'upload supports dynamic radio group by name prefix and label');
assert(uploadSrc.includes('dynamicCheckboxByNamePrefix'), 'upload supports dynamic checkbox by name prefix');
assert(uploadSrc.includes("case 'checkboxByLabelText'") && uploadSrc.includes('ai_all_audio'), 'upload supports AI all-audio checkbox by label text');
assert(uploadSrc.includes("setChecked('Lyrics', disclosure.lyrics_written_by_ai === true)"), 'upload actively enforces AI lyrics checkbox state');
assert(uploadSrc.includes("setChecked('Music', disclosure.music_composed_by_ai === true)"), 'upload actively enforces AI music checkbox state');
assert(uploadSrc.includes("setChecked('All of the audio', disclosure.all_audio_performed_by_ai === true)"), 'upload actively enforces AI all-audio checkbox state');
assert(uploadSrc.includes("setChecked('Part of the audio', disclosure.part_audio_performed_by_ai_and_humans === true)"), 'upload actively enforces AI part-audio checkbox state');
assert(uploadSrc.includes('ai_artist_identity') && uploadSrc.includes('AI artist identity question visible'), 'upload detects AI artist identity question for manual handling');
assert(uploadSrc.includes('- ai_lyrics:') && uploadSrc.includes('- ai_music:') && uploadSrc.includes('- ai_all_audio:') && uploadSrc.includes('- ai_part_audio:'), 'upload prints explicit AI disclosure checked/unchecked summary');
assert(uploadSrc.includes("case 'clickModalButton'") && uploadSrc.includes('modalContainsText'), 'upload saves only guarded modal buttons');
assert(uploadSrc.includes("case 'clickByText'"), 'upload supports safe text expansion clicks');
assert(!isDangerousAction('Add credits for each song on this release'), 'Add credits expansion is safe');
assert(isDangerousAction('#doneButton') && isDangerousAction('Continue'), '#doneButton and Continue remain blocked');
assert(uploadSrc.includes('IMPORTANT_CERTIFICATION_CHECKBOXES') && uploadSrc.includes('#areyousureyoutube') && uploadSrc.includes('blocked_not_allowlisted'), 'important checkboxes are explicit allowlist gated');
assert(uploadSrc.includes('getCertificationValue') && uploadSrc.includes('if (IMPORTANT_CERTIFICATION_CHECKBOXES.has(selector)) return true'), '--certify-important-checkboxes asserts allowlisted cert checkboxes');
assert(uploadSrc.includes('isFillableElement') && uploadSrc.includes("['checkbox', 'radio', 'file'"), 'upload never fills checkbox/radio/file inputs');
assert(uploadSrc.includes('isExactSelector') && uploadSrc.includes('multiple file inputs found'), 'upload blocks broad multi-candidate file upload');
assert(uploadSrc.includes('allowHidden') && uploadSrc.includes('selector resolved to hidden'), 'upload skips hidden selectors by default');
assert(uploadSrc.includes('submitRelease') && uploadSrc.includes('allowSubmit'), 'upload only submits through guarded live submit path');
assert(!uploadSrc.split(/\n/).some(line => /Continue/.test(line) && /\.click\(/.test(line)), 'upload does not click Continue');
assert(!/name=["']extras["']/.test(uploadSrc), 'upload does not target paid extras by name');
assert(uploadSrc.includes('getOrderedFields') && uploadSrc.includes("fieldDef.strategy === 'inputFile'") && uploadSrc.includes('return 60'), 'field order puts file uploads last');
assert(uploadSrc.includes('page.isClosed()') && uploadSrc.includes('DistroKid page closed before field loop completed'), 'upload detects page close before field loop completes');

const packageBuilderSrc = readText('scripts/distrokid/build-release-package.mjs');
assert(packageBuilderSrc.includes('"Alternative"') && packageBuilderSrc.includes('ai_disclosure'), 'package builder has genre and AI defaults');
assert(packageBuilderSrc.includes('lyrics_written_by_ai: false'), 'package builder defaults AI lyrics to false');
assert(packageBuilderSrc.includes('music_composed_by_ai: false'), 'package builder defaults AI music to false');
assert(packageBuilderSrc.includes('all_audio_performed_by_ai: true'), 'package builder defaults AI all-audio to true');
assert(packageBuilderSrc.includes('part_audio_performed_by_ai_and_humans: false'), 'package builder defaults AI part-audio to false');
assert(packageBuilderSrc.includes('ai_artist_identity'), 'package builder preserves future AI artist identity metadata when present');
assert(packageBuilderSrc.includes('songwriter_real_name') && packageBuilderSrc.includes('Kenneth') && packageBuilderSrc.includes('Chapman'), 'package builder has songwriter real-name defaults');
assert(packageBuilderSrc.includes('apple_music_credits') && packageBuilderSrc.includes('Executive Producer'), 'package builder has Apple Music credit defaults');
assert(packageBuilderSrc.includes('rights_confirmations') && packageBuilderSrc.includes('distribution_agreement_accepted: true'), 'package builder has rights confirmation defaults');
assert(packageBuilderSrc.includes('buildNestedDefaults') && packageBuilderSrc.includes('pancake_robot_default'), 'package builder sources nested defaults');

const localMapPath = 'config/distrokid/field-map.local.json';
if (fs.existsSync(join(REPO_ROOT, localMapPath))) {
  const localMap = readJson(localMapPath);
  assert(localMap.stop_before_submit === true, 'local field map stops before submit');
  for (const key of ['cover_art', 'audio_file', 'track_title', 'language', 'primary_genre', 'secondary_genre', 'original_song', 'ai_generated_gate']) {
    assert(Boolean(localMap.fields?.[key]), `local field map field ${key}`);
  }
  assert(localMap.fields.cover_art.selector === '#artwork', 'local field map artwork selector');
  assert(localMap.fields.audio_file.selector === '#js-track-upload-1', 'local field map audio selector');
  assert(localMap.fields.track_title.selector.includes('input[id^="title_"]'), 'local field map dynamic track title selector');
  assert(localMap.fields.ai_generated_gate.strategy === 'dynamicRadioByNamePrefixLabel', 'local field map dynamic AI gate');
  assert(localMap.fields.ai_all_audio?.strategy === 'checkboxByLabelText' && localMap.fields.ai_all_audio?.labelText === 'All of the audio', 'local field map AI all audio by label');
  assert(localMap.fields.apple_music_performer_role?.selector === '#track-1-performer-1-role', 'local field map Apple performer role selector');
  assert(localMap.fields.apple_music_producer_role?.selector === '#track-1-producer-1-role', 'local field map Apple producer role selector');
  assert(localMap.fields.songwriter_first?.selector === 'input[name="songwriter_real_name_first1"]', 'local field map songwriter first selector');
  assert(localMap.fields.cert_youtube_music?.selector === '#areyousureyoutube' && localMap.fields.cert_youtube_music?.requires_certify === true, 'local field map certification gated allowlist');
  assertNoDangerousPaidExtras(localMap, 'local field map');
}

const saveAuthSrc = readText('scripts/distrokid/save-auth.mjs');
assert(saveAuthSrc.includes("ignoreDefaultArgs: ['--enable-automation']"), 'save-auth strips --enable-automation');
assert(saveAuthSrc.includes('--disable-blink-features=AutomationControlled'), 'save-auth disables AutomationControlled');
assert(saveAuthSrc.includes("Object.defineProperty(navigator, 'webdriver'"), 'save-auth hides navigator.webdriver');
assert(saveAuthSrc.includes("'domcontentloaded'") && saveAuthSrc.includes("'framenavigated'") && saveAuthSrc.includes('setInterval'), 'save-auth saves before browser close');

const checkAuthSrc = readText('scripts/distrokid/check-auth.mjs');
assert(checkAuthSrc.includes('auth-check.png'), 'check-auth saves screenshot');
assert(checkAuthSrc.includes('auth-check-page-text.txt'), 'check-auth saves text snapshot');
assert(checkAuthSrc.includes('auth-check.html'), 'check-auth saves html snapshot');

const jobSrc = readText('src/shared/distrokid-jobs.js');
assert(jobSrc.includes('queued_for_distrokid') && jobSrc.includes('awaiting_manual_review') && jobSrc.includes('submitted'), 'queue helpers define allowed statuses');
assert(readText('src/shared/db.js').includes('CREATE TABLE IF NOT EXISTS distrokid_release_jobs'), 'queue table exists');
assert(readText('scripts/distrokid/queue-song.mjs').includes('queueSongForDistroKid'), 'queue CLI queues jobs');
assert(readText('scripts/distrokid/run-queued.mjs').includes('listQueuedDistroKidJobs'), 'run-queued CLI lists queued jobs');
assert(uploadSrc.includes('markDistroKidJobStatus') && uploadSrc.includes('AWAITING_MANUAL_REVIEW'), 'upload updates DistroKid job status');

assertCommandFailsClearly(['scripts/distrokid/build-release-package.mjs'], 'build-release-package missing args fails clearly');
assertCommandFailsClearly(['scripts/distrokid/queue-song.mjs'], 'queue-song missing args fails clearly');
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

function assertField(map, key, name) {
  assert(Boolean(map.fields?.[key]), `${name} field ${key}`);
}

function assertCertificationAllowlist(map, name) {
  const required = {
    cert_youtube_music: '#areyousureyoutube',
    cert_no_promo_services: '#areyousurepromoservices',
    cert_recorded_authorized: '#areyousurerecorded',
    cert_no_unapproved_artist_names: '#areyousureotherartist',
    cert_distribution_agreement: '#areyousuretandc',
  };
  for (const [fieldName, selector] of Object.entries(required)) {
    const fieldDef = map.fields?.[fieldName];
    assert(fieldDef?.strategy === 'cssCheckbox' && fieldDef?.selector === selector && fieldDef?.category === 'certification' && fieldDef?.requires_certify === true && fieldDef?.exact === true, `${name} certification allowlist ${fieldName}`);
  }
}

function assertNoUnsafeLabelSelectors(map, name) {
  for (const [fieldName, fieldDef] of Object.entries(map.fields || {})) {
    assert(fieldDef.strategy !== 'label', `${name} field ${fieldName} avoids unsafe label selector strategy`);
  }
}

function assertNoDangerousPaidExtras(map, name) {
  const dangerous = [
    'socialmediapack',
    'Social Media Pack',
    'Store Maximizer',
    'Loudness Normalization',
    'Discovery Pack',
    'Leave a Legacy',
    'DistroVid',
    'Cover Song Licensing',
  ];
  const fillSurface = JSON.stringify(map.fields || {});
  for (const item of dangerous) {
    assert(!fillSurface.includes(item), `${name} does not autofill ${item}`);
  }
}
