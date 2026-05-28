import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureDistroKidTrackCount,
  fillReleaseFields,
} from '../scripts/distrokid/upload-release-helpers.mjs';
import {
  buildDistroKidUploadInvocation,
} from '../src/shared/distrokid-upload-invocation.js';

test('selecting 21 songs still passes the render guard', async () => {
  const result = await ensureDistroKidTrackCount({}, 21, '/tmp', {
    locateAndSelectImpl: async (_page, requestedTrackCount, optionLabel) => ({
      ok: true,
      selectedOption: optionLabel,
      requestedTrackCount,
      renderedTrackCount: 1,
    }),
    waitForRenderedTrackCountImpl: async () => 21,
    writeJsonImpl: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.selectedOption, '21 songs');
  assert.equal(result.renderedTrackCount, 21);
});

test('album title fill waits until track-count render completes and per-track fill iterates across manifest length', async () => {
  const manifest = {
    release_id: 'ALBUM_TEST',
    release_title: 'Test Album',
    tracks: [
      { track_title: 'One' },
      { track_title: 'Two' },
      { track_title: 'Three' },
    ],
  };
  const phases = [];
  const filled = [];

  const result = await fillReleaseFields({
    page: {},
    manifest,
    fieldEntries: [
      ['release_title', { manifest_key: 'release_title' }],
      ['track_title', { manifest_key: 'track_title' }],
    ],
    ensureTrackCount: async () => {
      phases.push('ensure-track-count');
      return { ok: true, renderedTrackCount: 3, requestedTrackCount: 3 };
    },
    waitForAlbumFormReady: async () => {
      phases.push('wait-for-album-form');
    },
    runFieldForManifest: async (_page, fieldName, _fieldDef, sourceManifest) => {
      filled.push({ fieldName, value: sourceManifest.track_title || sourceManifest.release_title });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(phases, ['ensure-track-count', 'wait-for-album-form']);
  assert.deepEqual(filled, [
    { fieldName: 'release_title', value: 'Test Album' },
    { fieldName: 'track_title_track_1', value: 'One' },
    { fieldName: 'track_title_track_2', value: 'Two' },
    { fieldName: 'track_title_track_3', value: 'Three' },
  ]);
});

test('upload invocation includes resolved artwork path when provided', () => {
  const invocation = buildDistroKidUploadInvocation({
    manifestPath: '/tmp/manifest.json',
    mode: 'preview',
    artworkPath: '/tmp/brand-fallback-cover.png',
  });

  assert.deepEqual(invocation.args.slice(0, 6), [
    expectScriptPath(),
    '--manifest',
    '/tmp/manifest.json',
    '--artwork-path',
    '/tmp/brand-fallback-cover.png',
    '--no-pause',
  ]);
  assert.match(invocation.command, /--artwork-path/);
  assert.match(invocation.command, /brand-fallback-cover\.png/);
});

function expectScriptPath() {
  return invocationScriptPath;
}

const invocationScriptPath = buildDistroKidUploadInvocation({
  manifestPath: '/tmp/placeholder.json',
}).args[0];
