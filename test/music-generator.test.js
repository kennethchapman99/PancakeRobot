import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use dynamic imports with unique tokens to isolate module state
const {
  GENERATION_POLICIES,
  findExistingValidAudioFile,
  generateMusic,
} = await import(`../src/agents/music-generator.js?t=${Date.now()}`);

test('GENERATION_POLICIES exports expected values', () => {
  assert.equal(GENERATION_POLICIES.ONE_TAKE, 'one_take');
  assert.equal(GENERATION_POLICIES.ALLOW_REGENERATION, 'allow_regeneration');
  assert.equal(GENERATION_POLICIES.PRODUCER_MODE, 'producer_mode');
  assert.ok(Object.isFrozen(GENERATION_POLICIES));
});

test('findExistingValidAudioFile returns null for missing directory', () => {
  const nonexistent = path.join(os.tmpdir(), `pancake-test-missing-${Date.now()}`);
  assert.equal(findExistingValidAudioFile(nonexistent), null);
});

test('findExistingValidAudioFile returns null for empty directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-test-empty-'));
  try {
    assert.equal(findExistingValidAudioFile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findExistingValidAudioFile returns null for zero-byte audio files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-test-zero-'));
  try {
    fs.writeFileSync(path.join(dir, 'empty.mp3'), '');
    assert.equal(findExistingValidAudioFile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findExistingValidAudioFile returns first valid mp3 path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-test-mp3-'));
  const filePath = path.join(dir, 'test-song.mp3');
  try {
    fs.writeFileSync(filePath, Buffer.alloc(1024));
    assert.equal(findExistingValidAudioFile(dir), filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findExistingValidAudioFile returns first valid wav path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-test-wav-'));
  const filePath = path.join(dir, 'test-song.wav');
  try {
    fs.writeFileSync(filePath, Buffer.alloc(512));
    assert.equal(findExistingValidAudioFile(dir), filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findExistingValidAudioFile ignores non-audio files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-test-nonaudio-'));
  try {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not audio');
    fs.writeFileSync(path.join(dir, 'cover.jpg'), Buffer.alloc(1024));
    assert.equal(findExistingValidAudioFile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generateMusic returns skipped_existing_audio when valid audio exists and forceRegenerate is false', async () => {
  // Use the project output directory (generateMusic computes path from __dirname)
  const testSongId = `SONG_TEST_EXISTING_${Date.now().toString(36).toUpperCase()}`;
  const projectRoot = path.resolve(__dirname, '..');
  const songDir = path.join(projectRoot, 'output', 'songs', testSongId);
  const audioDir = path.join(songDir, 'audio');

  try {
    fs.mkdirSync(audioDir, { recursive: true });
    const fakeMp3 = path.join(audioDir, 'test-song.mp3');
    fs.writeFileSync(fakeMp3, Buffer.alloc(2048));

    const result = await generateMusic({
      songId: testSongId,
      title: 'Test Song',
      lyricsText: '[Verse]\nTest lyrics\n[Chorus]\nTest chorus',
      audioPromptData: null,
      forceRegenerate: false,
    });

    assert.equal(result.skipped_existing_audio, true, 'should mark skipped_existing_audio=true');
    assert.equal(result.skipped, false);
    assert.equal(result.audioFiles?.length, 1, 'should return the existing audio file');
    assert.equal(result.audioFiles?.[0]?.path, fakeMp3);
    assert.equal(result.audioFiles?.[0]?.reused, true);
  } finally {
    fs.rmSync(songDir, { recursive: true, force: true });
  }
});

test('generateMusic proceeds past existing audio check when forceRegenerate is true (no API key → falls through to skipped)', async () => {
  const savedKey = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;

  const testSongId = `SONG_TEST_FORCE_${Date.now().toString(36).toUpperCase()}`;
  const projectRoot = path.resolve(__dirname, '..');
  const songDir = path.join(projectRoot, 'output', 'songs', testSongId);
  const audioDir = path.join(songDir, 'audio');

  try {
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'test-song.mp3'), Buffer.alloc(2048));

    const result = await generateMusic({
      songId: testSongId,
      title: 'Test Song Force',
      lyricsText: '[Verse]\nTest lyrics\n[Chorus]\nTest chorus',
      audioPromptData: null,
      forceRegenerate: true,
    });

    // With forceRegenerate=true it bypasses the existing audio check,
    // then hits the missing API key guard and returns skipped=true
    assert.equal(result.skipped_existing_audio, undefined, 'should NOT set skipped_existing_audio');
    assert.equal(result.skipped, true, 'should fall through to api-key-missing skip');
  } finally {
    if (savedKey !== undefined) process.env.MINIMAX_API_KEY = savedKey;
    fs.rmSync(songDir, { recursive: true, force: true });
  }
});

test('generateMusic without existing audio and no API key returns skipped=true (song_only creates at most one generation attempt)', async () => {
  const savedKey = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;

  const testSongId = `SONG_TEST_NOKEY_${Date.now().toString(36).toUpperCase()}`;
  const projectRoot = path.resolve(__dirname, '..');
  const songDir = path.join(projectRoot, 'output', 'songs', testSongId);

  try {
    const result = await generateMusic({
      songId: testSongId,
      title: 'No Key Song',
      lyricsText: '[Verse]\nTest lyrics\n[Chorus]\nTest chorus',
      audioPromptData: null,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.audioFiles?.length, 0);
  } finally {
    if (savedKey !== undefined) process.env.MINIMAX_API_KEY = savedKey;
    fs.rmSync(songDir, { recursive: true, force: true });
  }
});
