import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTelegramCommand } from '../src/inbound/telegram/commands.js';
import {
  parseBrandProfileJson,
  repairAndValidateProfile,
  slugifyBrandName,
} from '../src/services/brand-profile-installer.js';
import { validateBrandProfile } from '../src/shared/brand-profile.js';
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

test('parseTelegramCommand supports brand profile creation', () => {
  const result = parseTelegramCommand('/brand new');
  assert.equal(result.type, 'brand_profile_new');
});

test('slugifyBrandName creates safe brand ids', () => {
  assert.equal(slugifyBrandName('Neon Koala!'), 'neon-koala');
  assert.equal(slugifyBrandName('Static Postcards & Synth Kids'), 'static-postcards-and-synth-kids');
});

test('parseBrandProfileJson strips markdown fences before parsing', () => {
  const parsed = parseBrandProfileJson('```json\n{"brand_name":"Neon Koala"}\n```');
  assert.equal(parsed.brand_name, 'Neon Koala');
});

test('repairAndValidateProfile fills required schema fields without installing broken JSON', async () => {
  const profile = await repairAndValidateProfile({
    brandName: 'Neon Koala',
    brandId: 'neon-koala',
    description: 'Fun neon synth-pop for kids, slightly weird, high-energy, catchy, danceable.',
    profile: {
      brand_name: 'Neon Koala',
      music: {
        default_style: 'neon synth-pop',
      },
    },
  });

  validateBrandProfile(profile, 'test generated profile');
  assert.equal(profile.brand_name, 'Neon Koala');
  assert.equal(profile.music.default_bpm, 124);
  assert.equal(profile.distribution.primary_genre, 'Electronic');
  assert.equal(profile.ui.logo_path, '/logo.png');
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
