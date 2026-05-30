import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BLOCKED_UPLOAD_VALIDATION_CODE,
  fillReleaseFields,
  getDistroKidTrackCountLabel,
  writeTrackCountValidationArtifact,
} from '../scripts/distrokid/upload-release-helpers.mjs';

test('multi-track manifest ensures Number of songs before filling track 2 fields', async () => {
  const events = [];
  const manifest = {
    release_id: 'ALBUM_TRACK_COUNT_ORDER',
    tracks: [
      { song_id: 'TRACK_1', track_title: 'One' },
      { song_id: 'TRACK_2', track_title: 'Two' },
    ],
  };

  const result = await fillReleaseFields({
    page: {},
    manifest,
    fieldEntries: [
      ['release_title', { manifest_key: 'release_title' }],
      ['track_title', { manifest_key: 'track_title', selector: 'input[id^="title_"]' }],
    ],
    ensureTrackCount: async (_page, trackCount) => {
      events.push(`ensure:${trackCount}`);
      return { ok: true, requestedTrackCount: trackCount, selectedOption: '2 songs', renderedTrackCount: 2 };
    },
    runFieldForManifest: async (_page, fieldName) => {
      events.push(fieldName);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    'ensure:2',
    'release_title',
    'track_title_track_1',
    'track_title_track_2',
  ]);
});

test('21-track manifest requests the "21 songs" dropdown option', () => {
  assert.equal(getDistroKidTrackCountLabel(21), '21 songs');
});

test('missing Number of songs option returns blocked_upload_validation', async () => {
  const calls = [];
  const manifest = {
    release_id: 'ALBUM_TRACK_COUNT_BLOCKED',
    tracks: Array.from({ length: 21 }, (_, index) => ({
      song_id: `TRACK_${index + 1}`,
      track_title: `Track ${index + 1}`,
    })),
  };

  const result = await fillReleaseFields({
    page: {},
    manifest,
    fieldEntries: [
      ['track_title', { manifest_key: 'track_title', selector: 'input[id^="title_"]' }],
    ],
    ensureTrackCount: async () => ({
      ok: false,
      requestedTrackCount: 21,
      selectedOption: '1 song (a single)',
      renderedTrackCount: 1,
      error: 'Number of songs dropdown does not contain required option: 21 songs',
    }),
    runFieldForManifest: async (_page, fieldName) => {
      calls.push(fieldName);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, BLOCKED_UPLOAD_VALIDATION_CODE);
  assert.deepEqual(calls, []);
});

test('track 2 selectors are not attempted while rendered track count is still 1', async () => {
  const calls = [];
  const manifest = {
    release_id: 'ALBUM_TRACK_COUNT_GUARD',
    tracks: [
      { song_id: 'TRACK_1', track_title: 'One' },
      { song_id: 'TRACK_2', track_title: 'Two' },
    ],
  };

  const result = await fillReleaseFields({
    page: {},
    manifest,
    fieldEntries: [
      ['track_title', { manifest_key: 'track_title', selector: 'input[id^="title_"]' }],
    ],
    ensureTrackCount: async () => ({
      ok: false,
      requestedTrackCount: 2,
      selectedOption: '1 song (a single)',
      renderedTrackCount: 1,
      error: 'DistroKid rendered 1 track section after selecting "1 song (a single)", expected at least 2.',
    }),
    runFieldForManifest: async (_page, fieldName) => {
      calls.push(fieldName);
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('track-count artifact persists selected and rendered counts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pancakerobot-track-count-artifact-'));
  const artifact = writeTrackCountValidationArtifact(tempDir, {
    requestedTrackCount: 21,
    selectedOption: '21 songs',
    renderedTrackCount: 21,
    ok: true,
    error: '',
  });

  const saved = JSON.parse(fs.readFileSync(path.join(tempDir, 'track-count-validation.json'), 'utf8'));
  assert.equal(artifact.selectedOption, '21 songs');
  assert.equal(saved.selectedOption, '21 songs');
  assert.equal(saved.renderedTrackCount, 21);
});
