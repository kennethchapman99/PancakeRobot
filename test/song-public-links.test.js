import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildSongPublicLinks,
  getSongAudioPublicPath,
  getSongAudioPaths,
  isValidSongId,
} from '../src/shared/song-public-links.js';
import { formatFinalResult } from '../src/inbound/telegram/magic-song-handler.js';

const PUBLIC_URL_ENV_KEYS = [
  'PUBLIC_APP_BASE_URL',
  'PUBLIC_BASE_URL',
  'TELEGRAM_PUBLIC_BASE_URL',
  'NGROK_URL',
  'NGROK_PUBLIC_URL',
];

function snapshotPublicUrlEnv() {
  return Object.fromEntries(PUBLIC_URL_ENV_KEYS.map(key => [key, process.env[key]]));
}

function restorePublicUrlEnv(snapshot) {
  for (const key of PUBLIC_URL_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function setOnlyPublicBaseUrl(value) {
  for (const key of PUBLIC_URL_ENV_KEYS) delete process.env[key];
  process.env.PUBLIC_BASE_URL = value;
}

function uniqueSongId(prefix = 'SONG_LINK_TEST') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function writeFakeAudio(songId, kind) {
  const paths = getSongAudioPaths(songId);
  const filePath = kind === 'original' ? paths.original : paths.mastered;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'fake-mp3');
  return filePath;
}

test('buildSongPublicLinks prefers mastered audio and uses configured public base URL', () => {
  const previousEnv = snapshotPublicUrlEnv();
  setOnlyPublicBaseUrl('https://example.ngrok-free.app/');
  const songId = uniqueSongId();
  writeFakeAudio(songId, 'original');
  writeFakeAudio(songId, 'mastered');

  try {
    const links = buildSongPublicLinks(songId);

    assert.equal(links.audioKind, 'mastered');
    assert.equal(links.publicBaseConfigured, true);
    assert.equal(links.isLocalBaseUrl, false);
    assert.equal(links.audioPath, `/media/songs/${songId}/masters/local_fast_master/mastered_320.mp3`);
    assert.equal(links.audioUrl, `https://example.ngrok-free.app/media/songs/${songId}/masters/local_fast_master/mastered_320.mp3`);
    assert.equal(links.detailUrl, `https://example.ngrok-free.app/songs/${songId}`);
    assert.equal(links.releaseKitUrl, `https://example.ngrok-free.app/release-kit/${songId}?preview=1`);
  } finally {
    restorePublicUrlEnv(previousEnv);
  }
});

test('buildSongPublicLinks falls back to original audio when mastered is missing', () => {
  const previousEnv = snapshotPublicUrlEnv();
  setOnlyPublicBaseUrl('https://songs.example.com');
  const songId = uniqueSongId();
  writeFakeAudio(songId, 'original');

  try {
    const links = buildSongPublicLinks(songId);

    assert.equal(links.audioKind, 'original');
    assert.equal(links.audioPath, `/media/songs/${songId}/media/source/original.mp3`);
    assert.equal(links.audioUrl, `https://songs.example.com/media/songs/${songId}/media/source/original.mp3`);
  } finally {
    restorePublicUrlEnv(previousEnv);
  }
});

test('song public links reject unsafe song ids', () => {
  assert.equal(isValidSongId('../bad'), false);
  assert.equal(isValidSongId('SONG_SAFE_123'), true);
  assert.throws(() => getSongAudioPublicPath('../bad'), /Invalid song id/);
});

test('Telegram final result includes MP3, song details, release kit, and no local filesystem paths', () => {
  const previousEnv = snapshotPublicUrlEnv();
  setOnlyPublicBaseUrl('https://public.example.com');
  const songId = uniqueSongId();
  writeFakeAudio(songId, 'mastered');

  try {
    const message = formatFinalResult({
      songId,
      title: 'Moon Boots on the Bus',
      score: 88,
      status: 'recommended_to_publish',
      runId: 'MAGIC_TEST_RUN',
    });

    assert.match(message, /🎵 Song ready: Moon Boots on the Bus/);
    assert.match(message, /▶️ Listen \/ download MP3:/);
    assert.match(message, new RegExp(`https://public\\.example\\.com/media/songs/${songId}/masters/local_fast_master/mastered_320\\.mp3`));
    assert.match(message, new RegExp(`https://public\\.example\\.com/songs/${songId}`));
    assert.match(message, new RegExp(`https://public\\.example\\.com/release-kit/${songId}\\?preview=1`));
    assert.doesNotMatch(message, /output\/songs/);
    assert.doesNotMatch(message, /localhost/);
  } finally {
    restorePublicUrlEnv(previousEnv);
  }
});
