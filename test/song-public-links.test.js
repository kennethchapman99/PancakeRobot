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
  const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://example.ngrok-free.app/';
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
    if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
  }
});

test('buildSongPublicLinks falls back to original audio when mastered is missing', () => {
  const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://songs.example.com';
  const songId = uniqueSongId();
  writeFakeAudio(songId, 'original');

  try {
    const links = buildSongPublicLinks(songId);

    assert.equal(links.audioKind, 'original');
    assert.equal(links.audioPath, `/media/songs/${songId}/media/source/original.mp3`);
    assert.equal(links.audioUrl, `https://songs.example.com/media/songs/${songId}/media/source/original.mp3`);
  } finally {
    if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
  }
});

test('song public links reject unsafe song ids', () => {
  assert.equal(isValidSongId('../bad'), false);
  assert.equal(isValidSongId('SONG_SAFE_123'), true);
  assert.throws(() => getSongAudioPublicPath('../bad'), /Invalid song id/);
});

test('Telegram final result includes MP3, song details, release kit, and no local filesystem paths', () => {
  const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://public.example.com';
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
    if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
  }
});
