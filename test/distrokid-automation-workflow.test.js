import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-distrokid-automation-workflow').slug;
process.env.PANCAKE_DISTROKID_AUTOMATION_STUB = '1';

const {
  createAlbum,
  getReleaseLinks,
  getSong,
  getSongsForAlbum,
  upsertSong,
} = await import('../src/shared/db.js');
const { getDistroKidJob } = await import('../src/shared/distrokid-jobs.js');
const {
  buildDistroKidUploadInvocation,
  captureHyperFollowLink,
  runDistroKidAlbumAutomation,
  runDistroKidSongAutomation,
} = await import('../src/shared/distrokid-automation.js');

test('preview mode builds package and runs automation without submitting', async t => {
  const songId = `SONG_DK_PREVIEW_${Date.now()}`;
  t.after(() => cleanupTestOutputArtifacts({ packageIds: [songId] }));
  upsertSong({ id: songId, title: 'Preview Bot', status: 'draft', is_test: true });

  const result = await runDistroKidSongAutomation(songId, { mode: 'preview' });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'preview');
  assert.equal(getSong(songId).status, 'draft');
  assert.equal(getDistroKidJob(songId).status, 'package_built');
  assert.ok(result.log.some(item => /Package built/i.test(item.message)));
});

test('live mode updates status after successful submit', async t => {
  const songId = `SONG_DK_LIVE_${Date.now()}`;
  t.after(() => cleanupTestOutputArtifacts({ packageIds: [songId] }));
  upsertSong({ id: songId, title: 'Live Bot', status: 'draft', is_test: true });

  const result = await runDistroKidSongAutomation(songId, {
    mode: 'live',
    confirm: true,
    releaseUrl: 'https://distrokid.com/release/live-bot',
  });

  assert.equal(result.ok, true);
  assert.equal(getSong(songId).status, 'submitted to DistroKid');
  assert.equal(getSong(songId).distribution_status, 'submitted');
  assert.equal(getDistroKidJob(songId).status, 'submitted_pending_hyperfollow');
});

test('HyperFollow URL capture updates release metadata field', async t => {
  const songId = `SONG_DK_HYPER_${Date.now()}`;
  t.after(() => cleanupTestOutputArtifacts({ packageIds: [songId] }));
  upsertSong({ id: songId, title: 'Hyper Bot', status: 'submitted to DistroKid', is_test: true });

  const hyperfollow = await captureHyperFollowLink(songId, {
    hyperfollowUrl: 'https://distrokid.com/hyperfollow/pancakerobot/hyper-bot',
  });
  const song = getSong(songId);
  const links = getReleaseLinks(songId);

  assert.equal(hyperfollow.status, 'captured');
  assert.equal(song.marketing_links.smart_link, 'https://distrokid.com/hyperfollow/pancakerobot/hyper-bot');
  assert.ok(links.some(link => link.platform === 'HyperFollow' && link.url === song.marketing_links.smart_link));
});

test('album automation loops over tracks without requiring song-level manual asset edits', async t => {
  const albumId = createAlbum({
    id: `ALBUM_DK_${Date.now()}`,
    album_title: 'Automation Album',
    number_of_songs: 2,
    status: 'completed',
    is_test: true,
  });
  t.after(() => cleanupTestOutputArtifacts({ packageIds: [albumId] }));
  upsertSong({ id: `${albumId}_T01`, title: 'One', album_id: albumId, track_number: 1, status: 'draft', is_test: true });
  upsertSong({ id: `${albumId}_T02`, title: 'Two', album_id: albumId, track_number: 2, status: 'draft', is_test: true });

  const result = await runDistroKidAlbumAutomation(albumId, { mode: 'preview' });

  assert.equal(result.ok, true);
  assert.equal(result.trackCount, 2);
  assert.deepEqual(getSongsForAlbum(albumId).map(song => song.status), ['draft', 'draft']);
  assert.ok(result.log.some(item => /Track 1 filled from package metadata/i.test(item.message)));
  assert.ok(result.log.some(item => /Track 2 filled from package metadata/i.test(item.message)));
});

test('interactive preview invocation omits --no-pause until auth is confirmed', () => {
  const manifestPath = '/tmp/distrokid-manifest.json';

  const blocked = buildDistroKidUploadInvocation({
    manifestPath,
    mode: 'preview',
    interactivePreview: true,
    authConfirmed: false,
  });
  const confirmed = buildDistroKidUploadInvocation({
    manifestPath,
    mode: 'preview',
    interactivePreview: true,
    authConfirmed: true,
  });

  assert.equal(blocked.args.includes('--no-pause'), false);
  assert.equal(confirmed.args.includes('--no-pause'), true);
});
