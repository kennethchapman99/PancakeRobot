import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  BLOCKED_FILL_VALIDATION_EXIT_CODE,
  BLOCKED_UPLOAD_VALIDATION_EXIT_CODE,
  countRenderedTrackBlocksFromPage,
  fillReleaseFields,
  isTrackLevelField,
} from '../scripts/distrokid/upload-release-helpers.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts/distrokid/upload-release.mjs');

test('upload-release dry-run startup no longer throws finished temporal dead zone error', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancakerobot-distrokid-startup-'));
  const manifestPath = path.join(tempDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    song_id: 'TEST_DRY_RUN_STARTUP',
    audio_file: path.join(tempDir, 'missing-audio.wav'),
    cover_art: path.join(tempDir, 'missing-cover.png'),
  }, null, 2)}\n`);

  let error = null;
  try {
    await execFileAsync(process.execPath, [scriptPath, '--manifest', manifestPath, '--dry-run', '--no-pause', '--browser-mode', 'none'], {
      cwd: repoRoot,
      env: process.env,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, 'script should exit non-zero for invalid manifest');
  const combinedOutput = `${error.stdout || ''}\n${error.stderr || ''}`;
  assert.doesNotMatch(combinedOutput, /ReferenceError: Cannot access 'finished' before initialization/);
  assert.doesNotMatch(combinedOutput, /at finish \(/);
  assert.match(combinedOutput, /Failed:\s+2/);
  assert.match(combinedOutput, /Manual next steps:/);
});

test('upload-release accepts album manifests that use release_id and track audio files without album song_id', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancakerobot-distrokid-album-manifest-'));
  const audioPath = path.join(tempDir, 'track-1.wav');
  const coverPath = path.join(tempDir, 'cover.png');
  const manifestPath = path.join(tempDir, 'manifest.json');
  fs.writeFileSync(audioPath, 'fake-audio');
  fs.writeFileSync(coverPath, 'fake-cover');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    release_type: 'album',
    album_id: 'ALBUM_UPLOAD_RELEASE_ID',
    release_id: 'ALBUM_UPLOAD_RELEASE_ID',
    cover_art: coverPath,
    tracks: [
      {
        song_id: 'SONG_UPLOAD_RELEASE_TRACK_1',
        track_title: 'Track One',
        audio_file: audioPath,
      },
    ],
  }, null, 2)}\n`);

  let error = null;
  let result = null;
  try {
    result = await execFileAsync(process.execPath, [scriptPath, '--manifest', manifestPath, '--dry-run', '--no-pause', '--browser-mode', 'none'], {
      cwd: repoRoot,
      env: process.env,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch (caught) {
    error = caught;
  }

  const combinedOutput = `${result?.stdout || error?.stdout || ''}\n${result?.stderr || error?.stderr || ''}`;
  assert.doesNotMatch(combinedOutput, /manifest is missing song_id/i);
  assert.doesNotMatch(combinedOutput, /audio_file not found/i);
  assert.doesNotMatch(combinedOutput, /cover_art not found/i);
});

test('upload-release still handles legacy single manifests that only provide song_id', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancakerobot-distrokid-legacy-manifest-'));
  const audioPath = path.join(tempDir, 'single.wav');
  const coverPath = path.join(tempDir, 'cover.png');
  const manifestPath = path.join(tempDir, 'manifest.json');
  fs.writeFileSync(audioPath, 'fake-audio');
  fs.writeFileSync(coverPath, 'fake-cover');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    song_id: 'SONG_UPLOAD_LEGACY_SINGLE',
    audio_file: audioPath,
    cover_art: coverPath,
  }, null, 2)}\n`);

  let error = null;
  let result = null;
  try {
    result = await execFileAsync(process.execPath, [scriptPath, '--manifest', manifestPath, '--dry-run', '--no-pause', '--browser-mode', 'none'], {
      cwd: repoRoot,
      env: process.env,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch (caught) {
    error = caught;
  }

  const combinedOutput = `${result?.stdout || error?.stdout || ''}\n${result?.stderr || error?.stderr || ''}`;
  assert.doesNotMatch(combinedOutput, /manifest is missing song_id\/release_id\/album_id/i);
  assert.doesNotMatch(combinedOutput, /audio_file not found/i);
  assert.doesNotMatch(combinedOutput, /cover_art not found/i);
  assert.match(combinedOutput, /browserLaunchSkipped/);
});

test('upload-release records release date from manifest in startup output', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancakerobot-distrokid-release-date-'));
  const audioPath = path.join(tempDir, 'single.wav');
  const coverPath = path.join(tempDir, 'cover.png');
  const manifestPath = path.join(tempDir, 'manifest.json');
  fs.writeFileSync(audioPath, 'fake-audio');
  fs.writeFileSync(coverPath, 'fake-cover');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    song_id: 'SONG_UPLOAD_RELEASE_DATE',
    audio_file: audioPath,
    cover_art: coverPath,
    release_date: '2026-06-12',
  }, null, 2)}\n`);

  let error = null;
  let result = null;
  try {
    result = await execFileAsync(process.execPath, [scriptPath, '--manifest', manifestPath, '--dry-run', '--no-pause', '--browser-mode', 'none'], {
      cwd: repoRoot,
      env: process.env,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch (caught) {
    error = caught;
  }

  const combinedOutput = `${result?.stdout || error?.stdout || ''}\n${result?.stderr || error?.stderr || ''}`;
  assert.match(combinedOutput, /"releaseDateFromManifest":"2026-06-12"/);
  assert.match(combinedOutput, /browserLaunchSkipped/);
});

test('upload-release blocks before DistroKid fill when --artwork-path points to a missing file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancakerobot-distrokid-artwork-override-'));
  const audioPath = path.join(tempDir, 'single.wav');
  const coverPath = path.join(tempDir, 'cover.png');
  const manifestPath = path.join(tempDir, 'manifest.json');
  fs.writeFileSync(audioPath, 'fake-audio');
  fs.writeFileSync(coverPath, 'fake-cover');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    song_id: 'SONG_UPLOAD_MISSING_ARTWORK_OVERRIDE',
    audio_file: audioPath,
    cover_art: coverPath,
  }, null, 2)}\n`);

  let error = null;
  try {
    await execFileAsync(process.execPath, [
      scriptPath,
      '--manifest',
      manifestPath,
      '--artwork-path',
      path.join(tempDir, 'does-not-exist.png'),
      '--dry-run',
      '--no-pause',
    ], {
      cwd: repoRoot,
      env: process.env,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, 'script should exit non-zero when artwork override is missing');
  const combinedOutput = `${error.stdout || ''}\n${error.stderr || ''}`;
  assert.match(combinedOutput, /cover_art not found/i);
  assert.doesNotMatch(combinedOutput, /Playwright is not installed/i);
});

test('fillReleaseFields album: ensureTrackCount called before any runFieldForManifest call', async () => {
  const calls = [];
  const manifest = {
    release_type: 'album',
    release_title: 'Test Album',
    tracks: [{ song_id: 's1', track_title: 'Track 1', audio_file: '/fake/track1.wav' }],
  };
  const fieldEntries = [
    ['release_title', { strategy: 'fill', selector: '#title' }],
    ['audio_file', { strategy: 'inputFile', selector: '#audio', manifest_key: 'audio_file' }],
  ];
  await fillReleaseFields({
    page: {},
    manifest,
    fieldEntries,
    ensureTrackCount: async () => { calls.push('ensureTrackCount'); return { ok: true, renderedTrackCount: 1 }; },
    waitForAlbumFormReady: async () => { calls.push('waitForAlbumFormReady'); },
    runFieldForManifest: async (_page, fieldName) => { calls.push(fieldName); },
  });
  assert.strictEqual(calls[0], 'ensureTrackCount', 'track count must be first call');
  assert.strictEqual(calls[1], 'waitForAlbumFormReady', 'form ready wait must follow track count');
  assert.ok(calls.indexOf('release_title') > 1, 'album fields must come after track count');
});

test('fillReleaseFields album: album-level fields filled before per-track fields', async () => {
  const calls = [];
  const manifest = {
    release_type: 'album',
    release_title: 'Phase Test',
    tracks: [
      { song_id: 's1', track_title: 'Track 1', audio_file: '/fake/t1.wav' },
      { song_id: 's2', track_title: 'Track 2', audio_file: '/fake/t2.wav' },
    ],
  };
  const fieldEntries = [
    ['audio_file', { strategy: 'inputFile', selector: '#audio', manifest_key: 'audio_file' }],
    ['release_title', { strategy: 'fill', selector: '#title' }],
    ['track_title', { strategy: 'fill', selector: '#track-title', manifest_key: 'track_title' }],
  ];
  await fillReleaseFields({
    page: {},
    manifest,
    fieldEntries,
    ensureTrackCount: async () => ({ ok: true, renderedTrackCount: 2 }),
    waitForAlbumFormReady: null,
    runFieldForManifest: async (_page, fieldName) => { calls.push(fieldName); },
  });
  const releaseTitleIndex = calls.indexOf('release_title');
  const audioFileIndex = calls.indexOf('audio_file_track_1');
  const trackTitleIndex = calls.indexOf('track_title_track_1');
  assert.ok(releaseTitleIndex < audioFileIndex, 'release_title (album-level) must come before audio_file_track_1 (track-level)');
  assert.ok(releaseTitleIndex < trackTitleIndex, 'release_title must come before track_title_track_1');
  assert.ok(calls.includes('track_title_track_2'), 'all tracks must be filled in phase 3');
});

test('fillReleaseFields single: does not call ensureTrackCount', async () => {
  let trackCountCalled = false;
  const manifest = { song_id: 'single-1', track_title: 'My Single', audio_file: '/fake/single.wav' };
  const fieldEntries = [
    ['track_title', { strategy: 'fill', selector: '#title', manifest_key: 'track_title' }],
  ];
  await fillReleaseFields({
    page: {},
    manifest,
    fieldEntries,
    ensureTrackCount: async () => { trackCountCalled = true; return { ok: true }; },
    waitForAlbumFormReady: null,
    runFieldForManifest: async () => {},
  });
  assert.strictEqual(trackCountCalled, false, 'single release must not call ensureTrackCount');
});

test('fillReleaseFields album: blocked and returns BLOCKED_UPLOAD_VALIDATION_CODE when track count fails', async () => {
  const manifest = {
    release_type: 'album',
    tracks: [{ song_id: 's1', track_title: 'T1' }, { song_id: 's2', track_title: 'T2' }],
  };
  const result = await fillReleaseFields({
    page: {},
    manifest,
    fieldEntries: [['release_title', { strategy: 'fill', selector: '#title' }]],
    ensureTrackCount: async () => ({ ok: false, renderedTrackCount: 0, error: 'dropdown missing' }),
    waitForAlbumFormReady: null,
    runFieldForManifest: async () => { throw new Error('should not be called'); },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'blocked_upload_validation');
});

test('BLOCKED_FILL_VALIDATION_EXIT_CODE is 23 and distinct from BLOCKED_UPLOAD_VALIDATION_EXIT_CODE (22)', () => {
  assert.strictEqual(BLOCKED_FILL_VALIDATION_EXIT_CODE, 23);
  assert.strictEqual(BLOCKED_UPLOAD_VALIDATION_EXIT_CODE, 22);
  assert.notStrictEqual(BLOCKED_FILL_VALIDATION_EXIT_CODE, BLOCKED_UPLOAD_VALIDATION_EXIT_CODE);
});
