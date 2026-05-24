import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-album-assignment').slug;

const albumIds = new Set();
const songIds = new Set();

test.after(() => {
  cleanupTestOutputArtifacts({
    albumIds: [...albumIds],
    songIds: [...songIds],
  });
});

const {
  assignSongsToAlbum,
  createAlbum,
  getAlbum,
  getSong,
  getSongsForAlbum,
  reorderAlbumTracks,
  upsertSong,
} = await import('../src/shared/db.js');
const {
  getReleaseAssetOwner,
} = await import('../src/shared/song-release-assets-service.js');

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTestSong(title, overrides = {}) {
  const id = uniqueId('ALBUM_ASSIGN_SONG');
  songIds.add(id);
  upsertSong({
    id,
    title,
    brand_profile_id: 'album-assignment-brand',
    is_test: true,
    ...overrides,
  });
  return id;
}

test('creating a new album from selected catalog songs assigns tracks in order', () => {
  const first = createTestSong('First Track');
  const second = createTestSong('Second Track');
  const albumId = createAlbum({
    id: uniqueId('ALBUM_ASSIGN_NEW'),
    album_title: 'Selected Songs Album',
    brand_profile_id: 'album-assignment-brand',
    release_date: '2026-06-05',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);

  assignSongsToAlbum(albumId, [first, second]);

  const album = getAlbum(albumId);
  const tracks = getSongsForAlbum(albumId);
  assert.equal(album.release_date, '2026-06-05');
  assert.deepEqual(tracks.map(song => song.id), [first, second]);
  assert.deepEqual(tracks.map(song => song.track_number), [1, 2]);
  assert.equal(getSong(first).album_id, albumId);
});

test('adding selected songs to an existing album appends after current tracks', () => {
  const original = createTestSong('Original Track');
  const added = createTestSong('Added Track');
  const albumId = createAlbum({
    id: uniqueId('ALBUM_ASSIGN_EXISTING'),
    album_title: 'Existing Album',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);

  assignSongsToAlbum(albumId, [original]);
  assignSongsToAlbum(albumId, [added], { startTrackNumber: 2 });

  assert.deepEqual(getSongsForAlbum(albumId).map(song => song.id), [original, added]);
  assert.equal(getSong(added).track_number, 2);
});

test('album track order persists after reordering', () => {
  const first = createTestSong('Order First');
  const second = createTestSong('Order Second');
  const third = createTestSong('Order Third');
  const albumId = createAlbum({
    id: uniqueId('ALBUM_ASSIGN_ORDER'),
    album_title: 'Ordered Album',
    number_of_songs: 3,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);

  assignSongsToAlbum(albumId, [first, second, third]);
  reorderAlbumTracks(albumId, [third, first, second]);

  assert.deepEqual(getSongsForAlbum(albumId).map(song => song.id), [third, first, second]);
  assert.deepEqual(getSongsForAlbum(albumId).map(song => song.track_number), [1, 2, 3]);
});

test('album media is canonical for assigned songs', () => {
  const songId = createTestSong('Inherited Canonical Media');
  const albumId = createAlbum({
    id: uniqueId('ALBUM_ASSIGN_CANONICAL'),
    album_title: 'Canonical Album',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);

  assignSongsToAlbum(albumId, [songId]);

  const owner = getReleaseAssetOwner('song', songId);
  assert.equal(owner.type, 'album');
  assert.equal(owner.id, albumId);
  assert.equal(owner.inheritedFrom.id, albumId);
});
