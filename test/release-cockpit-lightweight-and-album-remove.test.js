import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-release-cockpit-lightweight-remove').slug;

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
  upsertReleaseLink,
  upsertSong,
} = await import('../src/shared/db.js');
const {
  removeSongsFromAlbum,
} = await import('../src/shared/album-track-membership.js');
const {
  listReleaseCockpitEntries,
} = await import('../src/shared/release-cockpit.js');

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createSong(title, overrides = {}) {
  const id = uniqueId('LIGHT_COCKPIT_SONG');
  songIds.add(id);
  upsertSong({
    id,
    title,
    brand_profile_id: 'default',
    release_date: '2026-06-12',
    status: 'draft',
    is_test: false,
    ...overrides,
  });
  return id;
}

function createTestAlbum(title, songIdsForAlbum = []) {
  const id = createAlbum({
    id: uniqueId('LIGHT_COCKPIT_ALBUM'),
    album_title: title,
    release_date: '2026-07-01',
    number_of_songs: Math.max(songIdsForAlbum.length, 1),
    status: 'assembled',
    brand_profile_id: 'default',
    is_test: false,
  });
  albumIds.add(id);
  if (songIdsForAlbum.length) assignSongsToAlbum(id, songIdsForAlbum);
  return id;
}

test('Release Cockpit index entries are DB-first lightweight summaries', () => {
  const first = createSong('Lightweight Album Track One');
  const second = createSong('Lightweight Album Track Two');
  const albumId = createTestAlbum('Lightweight Cockpit Album', [first, second]);
  const singleId = createSong('Lightweight Cockpit Single');

  upsertReleaseLink(first, 'HyperFollow', 'https://distrokid.com/hyperfollow/pancakerobot/lightweight-album');

  const entries = listReleaseCockpitEntries();
  const albumEntry = entries.find(entry => entry.type === 'album' && entry.id === albumId);
  const singleEntry = entries.find(entry => entry.type === 'single' && entry.id === singleId);

  assert.ok(albumEntry);
  assert.ok(singleEntry);
  assert.equal(albumEntry.stageSummary, '2 tracks');
  assert.equal(albumEntry.trackCount, 2);
  assert.equal(albumEntry.hyperfollowUrl, 'https://distrokid.com/hyperfollow/pancakerobot/lightweight-album');
  assert.equal(singleEntry.stageSummary, '1 track');
  assert.equal(singleEntry.trackCount, 1);
  assert.equal(albumEntry.blockerCount, 0);
});

test('Release Cockpit hides orphan zero-track albums but keeps active planned generations', () => {
  const hiddenAlbumId = createAlbum({
    id: uniqueId('LIGHT_COCKPIT_ALBUM'),
    album_title: 'Hidden Zero Track Album',
    number_of_songs: 4,
    status: 'completed_with_failures',
    brand_profile_id: 'default',
    is_test: false,
  });
  albumIds.add(hiddenAlbumId);

  const visibleAlbumId = createAlbum({
    id: uniqueId('LIGHT_COCKPIT_ALBUM'),
    album_title: 'Planned Zero Track Album',
    number_of_songs: 3,
    status: 'generating_tracks',
    brand_profile_id: 'default',
    is_test: false,
    shared_orchestration: {
      plan: {
        tracks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
      },
    },
  });
  albumIds.add(visibleAlbumId);

  const entries = listReleaseCockpitEntries();
  const hidden = entries.find(entry => entry.id === hiddenAlbumId);
  const visible = entries.find(entry => entry.id === visibleAlbumId);

  assert.equal(hidden, undefined);
  assert.ok(visible);
  assert.equal(visible.stageSummary, '3 planned tracks');
  assert.equal(visible.trackCount, 3);
});

test('removeSongsFromAlbum detaches songs, keeps catalog rows, renumbers remaining tracks, and updates album count', () => {
  const first = createSong('Keep Track One');
  const second = createSong('Remove Track Two');
  const third = createSong('Keep Track Three');
  const albumId = createTestAlbum('Removal Cockpit Album', [first, second, third]);

  const remaining = removeSongsFromAlbum(albumId, [second]);
  const removedSong = getSong(second);
  const keptTracks = getSongsForAlbum(albumId);
  const album = getAlbum(albumId);

  assert.ok(removedSong, 'removed song should remain in catalog');
  assert.equal(removedSong.album_id, null);
  assert.equal(removedSong.track_number, null);
  assert.deepEqual(remaining.map(song => song.id), [first, third]);
  assert.deepEqual(keptTracks.map(song => song.id), [first, third]);
  assert.deepEqual(keptTracks.map(song => song.track_number), [1, 2]);
  assert.equal(album.number_of_songs, 2);
});

test('removeSongsFromAlbum rejects songs that are not assigned to the target album', () => {
  const assigned = createSong('Assigned Track');
  const unassigned = createSong('Unassigned Track');
  const albumId = createTestAlbum('Removal Validation Album', [assigned]);

  assert.throws(() => removeSongsFromAlbum(albumId, [unassigned]), /No selected songs are assigned to this album/);
});
