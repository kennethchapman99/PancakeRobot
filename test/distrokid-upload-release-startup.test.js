import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

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
    await execFileAsync(process.execPath, [scriptPath, '--manifest', manifestPath, '--dry-run', '--no-pause'], {
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
    result = await execFileAsync(process.execPath, [scriptPath, '--manifest', manifestPath, '--dry-run', '--no-pause'], {
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
    result = await execFileAsync(process.execPath, [scriptPath, '--manifest', manifestPath, '--dry-run', '--no-pause'], {
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
});
