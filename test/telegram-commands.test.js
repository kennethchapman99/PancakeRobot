import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTelegramCommand } from '../src/inbound/telegram/commands.js';
import { normalizeMagicSongInput } from '../src/workflows/magic-song-workflow.js';

test('parseTelegramCommand extracts magic song theme from slash command', () => {
  const result = parseTelegramCommand('/magic a dinosaur who cannot reach the syrup');
  assert.equal(result.type, 'magic_song_request');
  assert.equal(result.theme, 'a dinosaur who cannot reach the syrup');
});

test('parseTelegramCommand treats normal text as a song theme', () => {
  const result = parseTelegramCommand('pancake robot in space');
  assert.equal(result.type, 'magic_song_request');
  assert.equal(result.theme, 'pancake robot in space');
});

test('parseTelegramCommand supports cancel', () => {
  const result = parseTelegramCommand('/cancel');
  assert.equal(result.type, 'cancel');
});

test('normalizeMagicSongInput defaults to human review and creates ids', () => {
  const result = normalizeMagicSongInput({
    theme: 'tiny robot makes breakfast',
    requestedBy: 'telegram-user',
    source: 'telegram',
  });

  assert.equal(result.theme, 'tiny robot makes breakfast');
  assert.equal(result.mode, 'human_review');
  assert.equal(result.source, 'telegram');
  assert.match(result.songId, /^SONG_/);
  assert.match(result.runId, /^MAGIC_/);
});
