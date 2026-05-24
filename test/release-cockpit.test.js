import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-release-cockpit').slug;

const repoRoot = path.resolve(import.meta.dirname, '..');
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
  getReleaseCockpitLogs,
  getReleaseLinks,
  upsertReleaseLink,
  upsertSong,
} = await import('../src/shared/db.js');
const {
  assertReleaseLiveSubmitReady,
  buildReleaseCockpitViewModel,
  listReleaseCockpitEntries,
  logReleaseCockpitEvent,
} = await import('../src/shared/release-cockpit.js');
const {
  getReleaseAssetOwner,
} = await import('../src/shared/song-release-assets-service.js');

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createSong(title, overrides = {}) {
  const id = uniqueId('COCKPIT_SONG');
  songIds.add(id);
  upsertSong({
    id,
    title,
    brand_profile_id: 'release-cockpit-brand',
    release_date: '2026-06-12',
    is_test: true,
    ...overrides,
  });
  return id;
}

function writeSongAsset(songId, relativePath, content = 'test') {
  const filePath = path.join(repoRoot, 'output', 'songs', songId, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeAlbumImage(albumId) {
  const filePath = path.join(repoRoot, 'output', 'albums', albumId, 'reference', 'primary-image.png');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'not-a-real-image-but-good-enough-for-state');
  return filePath;
}

test('album cockpit includes ordered tracks', () => {
  const first = createSong('First Cockpit Track');
  const second = createSong('Second Cockpit Track');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_ORDERED'),
    album_title: 'Ordered Cockpit Album',
    release_date: '2026-07-01',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [second, first]);

  const cockpit = buildReleaseCockpitViewModel('album', albumId);

  assert.equal(cockpit.type, 'album');
  assert.deepEqual(cockpit.tracks.map(track => track.id), [second, first]);
  assert.deepEqual(cockpit.tracks.map(track => track.track_number), [1, 2]);
});

test('album-owned songs inherit album media in release cockpit context', () => {
  const songId = createSong('Inherited Media Track');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_MEDIA'),
    album_title: 'Media Owner Album',
    release_date: '2026-07-02',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [songId]);
  writeAlbumImage(albumId);

  const owner = getReleaseAssetOwner('song', songId);
  const cockpit = buildReleaseCockpitViewModel('album', albumId);

  assert.equal(owner.type, 'album');
  assert.equal(owner.id, albumId);
  assert.equal(cockpit.canonicalMediaOwner.type, 'album');
  assert.equal(cockpit.canonicalMediaOwner.id, albumId);
});

test('singles have their own cockpit and appear as single releases', () => {
  const songId = createSong('Standalone Cockpit Single', { is_test: false });

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const entries = listReleaseCockpitEntries();

  assert.equal(cockpit.type, 'single');
  assert.equal(cockpit.id, songId);
  assert.equal(cockpit.tracks.length, 1);
  assert.ok(entries.some(entry => entry.type === 'single' && entry.id === songId));
});

test('missing metadata and audio block live submit but keep preview and readiness available', () => {
  const songId = createSong('Blocked Cockpit Single');
  const cockpit = buildReleaseCockpitViewModel('single', songId);

  assert.equal(cockpit.canLiveSubmit, false);
  assert.ok(cockpit.blockers.some(blocker => /audio file is missing/i.test(blocker)));
  assert.ok(cockpit.blockers.some(blocker => /metadata\.json is missing/i.test(blocker)));
  assert.ok(cockpit.nextActions.find(action => action.key === 'readiness')?.enabled);
  assert.ok(cockpit.nextActions.find(action => action.key === 'preview')?.enabled);
  assert.equal(cockpit.nextActions.find(action => action.key === 'live_submit')?.enabled, false);
  assert.throws(() => assertReleaseLiveSubmitReady('single', songId), /Live submit blocked/);
});

test('HyperFollow URL is persisted and reused in cockpit state', () => {
  const songId = createSong('HyperFollow Cockpit Single');
  upsertReleaseLink(songId, 'HyperFollow', 'https://distrokid.com/hyperfollow/example/hyperfollow-cockpit-single');

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const links = getReleaseLinks(songId);

  assert.equal(cockpit.hyperfollow.url, 'https://distrokid.com/hyperfollow/example/hyperfollow-cockpit-single');
  assert.ok(links.some(link => link.platform === 'HyperFollow'));
});

test('cockpit execution log is visible through the release model', () => {
  const songId = createSong('Logged Cockpit Single');
  logReleaseCockpitEvent('single', songId, 'readiness_check', 'blocked', 'Readiness check found blockers.', { blockers: ['audio'] });

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const logs = getReleaseCockpitLogs('single', songId);

  assert.equal(cockpit.logs[0].action, 'readiness_check');
  assert.equal(logs[0].payload.blockers[0], 'audio');
});

test('cockpit templates avoid duplicate competing controls for album-owned songs', () => {
  const songDetail = fs.readFileSync(path.join(repoRoot, 'src/web/views/songs/detail.ejs'), 'utf8');
  const releaseDetail = fs.readFileSync(path.join(repoRoot, 'src/web/views/releases/detail.ejs'), 'utf8');
  const releaseModel = fs.readFileSync(path.join(repoRoot, 'src/shared/release-cockpit.js'), 'utf8');

  assert.match(songDetail, /href="\/releases\/<%= albumReleaseContext \? 'album' : 'single' %>/);
  assert.match(songDetail, /This track is submitted as part of its album/);
  assert.match(songDetail, /<% } else { %>\s*<section class="mb-6 rounded-2xl border border-fuchsia-200 bg-white p-5 shadow-sm" x-data="distroKidAutomation/);
  assert.match(releaseDetail, /Run DistroKid live submit/);
  assert.match(releaseModel, /ByteSeed video publishing/);
  assert.match(releaseModel, /Meta publishing/);
});
