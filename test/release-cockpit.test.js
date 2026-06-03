import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-release-cockpit').slug;
process.env.PANCAKE_DISTROKID_AUTOMATION_STUB = '1';

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
  getReleaseCampaignByRelease,
  getReleaseLinks,
  upsertReleaseCampaignTask,
  upsertReleaseLink,
  upsertSong,
} = await import('../src/shared/db.js');
const {
  assertReleaseLiveSubmitReady,
  buildReleasePackageForCockpit,
  buildReleaseCockpitViewModel,
  getCanonicalReleaseManifestPath,
  getCanonicalReleaseManifest,
  listReleaseCockpitEntries,
  logReleaseCockpitEvent,
  resolveDistroKidArtwork,
  validateReleaseAction,
} = await import('../src/shared/release-cockpit.js');
const {
  getReleaseAssetOwner,
} = await import('../src/shared/song-release-assets-service.js');
const {
  captureHyperFollowLink,
  runDistroKidAlbumAutomation,
  runDistroKidSongAutomation,
} = await import('../src/shared/distrokid-automation.js');
const {
  createMagicReleaseCampaign,
} = await import('../src/shared/magic-release.js');
const {
  getDistroKidJob,
} = await import('../src/shared/distrokid-jobs.js');
const {
  upsertMarketingTarget,
} = await import('../src/shared/marketing-db.js');
const {
  createOutreachRun,
} = await import('../src/agents/marketing-outreach-run-agent.js');
const {
  getActiveProfileId,
} = await import('../src/shared/brand-profile.js');
const {
  getSelectedReleaseAudio,
  selectReleaseAudio,
} = await import('../src/shared/song-audio-selection.js');
const { app } = await import('../src/web/server.js');

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function startServer() {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

function createSong(title, overrides = {}) {
  const id = uniqueId('COCKPIT_SONG');
  songIds.add(id);
  upsertSong({
    id,
    title,
    brand_profile_id: 'default',
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

function writeReadySongFiles(songId) {
  writeSongAsset(songId, 'audio.mp3', 'fake-audio');
  writeSongAsset(songId, 'reference/base-image.png', 'fake-primary-image');
  writeSongAsset(songId, 'metadata.json', JSON.stringify({
    artist: 'Pancake Robot',
    title: `Title ${songId}`,
    primary_genre: "Children's Music",
    made_for_kids: true,
  }));
  writeSongAsset(songId, 'lyrics.md', 'la la test');
  const marketingDir = path.join(repoRoot, 'output', 'marketing-ready', songId);
  fs.mkdirSync(marketingDir, { recursive: true });
  fs.writeFileSync(path.join(marketingDir, 'no-text-variation.png'), 'fake-cover');
  fs.writeFileSync(path.join(marketingDir, 'metadata.json'), JSON.stringify({
    primary_image_fingerprint: 'test',
    generated_assets: [
      'spotify-cover-3000x3000.png',
      'youtube-thumbnail-1280x720.png',
      'instagram-square-1080x1080.png',
      'instagram-vertical-1080x1920.png',
      'facebook-post-1200x630.png',
    ].map(name => ({ name, format: name, path: path.join(marketingDir, name), publicUrl: `/media/marketing-ready/${songId}/${name}` })),
  }));
}

function writeReadyAlbumFiles(albumId, songIds) {
  writeAlbumImage(albumId);
  const albumAssetsDir = path.join(repoRoot, 'output', 'albums', albumId, 'assets');
  fs.mkdirSync(albumAssetsDir, { recursive: true });
  fs.writeFileSync(path.join(albumAssetsDir, 'metadata.json'), JSON.stringify({
    primary_image_fingerprint: 'test',
    generated_assets: [
      'spotify-cover-3000x3000.png',
      'youtube-thumbnail-1280x720.png',
      'instagram-square-1080x1080.png',
      'instagram-vertical-1080x1920.png',
      'facebook-post-1200x630.png',
    ].map(name => ({ name, format: name, path: path.join(albumAssetsDir, name), publicUrl: `/media/albums/${albumId}/assets/${name}` })),
  }));
  for (const songId of songIds) {
    writeSongAsset(songId, 'audio.mp3', 'fake-audio');
    writeSongAsset(songId, 'metadata.json', JSON.stringify({
      artist: 'Pancake Robot',
      title: `Title ${songId}`,
      primary_genre: "Children's Music",
      made_for_kids: true,
    }));
    writeSongAsset(songId, 'lyrics.md', 'la la album');
  }
}

function writePackageManifest(releaseId, manifest) {
  const filePath = path.join(repoRoot, 'output', 'release-packages', releaseId, 'manifest.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return filePath;
}

function writePreviewRunArtifacts(releaseId, { releaseType = 'single', filledCount = 12, skippedCount = 0, errorCount = 0, dryRun = true, stoppedBeforeSubmit = true, errors = [], skippedFields = [], finalStatus = errorCount > 0 ? 'failed' : 'complete', trackCountValidation = null } = {}) {
  const runDir = path.join(repoRoot, 'output', 'release-packages', releaseId, 'distrokid-run');
  fs.mkdirSync(runDir, { recursive: true });
  const runLog = {
    song_id: releaseType === 'single' ? releaseId : null,
    release_id: releaseId,
    manifest_path: `output/release-packages/${releaseId}/manifest.json`,
    dry_run: dryRun,
    stopped_before_submit: stoppedBeforeSubmit,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    filled_count: filledCount,
    skipped_count: skippedCount,
    error_count: errorCount,
    final_status: finalStatus,
    diagnostics: {
      track_count_validation: trackCountValidation,
    },
  };
  fs.writeFileSync(path.join(runDir, 'run-log.json'), `${JSON.stringify(runLog, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'errors.json'), `${JSON.stringify(errors, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'skipped-fields.json'), `${JSON.stringify(skippedFields, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'filled-fields.json'), '[]\n');
  fs.writeFileSync(path.join(runDir, 'screenshot-after-fill.png'), 'fake-png');
  fs.writeFileSync(path.join(runDir, 'screenshot-final-review.png'), 'fake-png');
  fs.writeFileSync(path.join(runDir, 'html-snapshot.html'), '<html><body>test</body></html>');
  fs.writeFileSync(path.join(runDir, 'page-text-snapshot.txt'), 'test page');
  return `output/release-packages/${releaseId}/distrokid-run/run-log.json`;
}

function seedEmailOutlet(id) {
  const sourcePath = path.join(repoRoot, 'output', 'test-marketing-outlets-source.json');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ outlet_targets: [] }));
  process.env.MARKETING_OUTLETS_SOURCE_PATH = sourcePath;
  upsertMarketingTarget({
    id,
    brand_profile_id: getActiveProfileId(),
    name: `Cockpit Acceptance Outlet ${id}`,
    type: 'playlist',
    platform: 'email',
    source_url: `https://cockpit-outlet.local/${id}`,
    contact_email: 'editor@cockpit-outlet.local',
    public_email: 'editor@cockpit-outlet.local',
    status: 'approved',
    ai_policy: 'allowed',
    fit_score: 95,
    contactability: { status: 'contactable', free_contact_method_found: true, best_channel: 'email', contact_methods: [{ type: 'email', value: 'editor@cockpit-outlet.local' }] },
    cost_policy: { requires_payment: false, cost_type: 'free' },
    outreach_eligibility: { eligible: true, reason_codes: [] },
  });
  return id;
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

test('release detail page renders release date input, saves release date to canonical manifest, reloads saved value, and shows header artwork or a placeholder cleanly', async t => {
  const withLogoSongId = createSong('Release Detail Save Date');
  writeReadySongFiles(withLogoSongId);
  await buildReleasePackageForCockpit('single', withLogoSongId);

  const withoutLogoSongId = createSong('Release Detail Missing Logo', { brand_profile_id: 'missing-release-logo-profile' });

  const server = await startServer();
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const initialRes = await fetch(`${baseUrl}/releases/single/${withLogoSongId}`);
  const initialHtml = await initialRes.text();
  assert.equal(initialRes.status, 200);
  assert.match(initialHtml, /data-release-date-input/);
  assert.match(initialHtml, /value="2026-06-12"/);
  assert.match(initialHtml, /data-save-release-date/);
  assert.match(initialHtml, /data-release-header-art/);

  const postRes = await fetch(`${baseUrl}/releases/single/${withLogoSongId}/actions/release-date`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ release_date: '2026-09-19' }),
    redirect: 'manual',
  });
  assert.equal(postRes.status, 303);
  assert.match(postRes.headers.get('location') || '', /notice=Release\+date\+saved\./);

  const manifest = getCanonicalReleaseManifest('single', withLogoSongId);
  assert.equal(manifest.release_date, '2026-09-19');
  assert.equal(manifest.field_sources.release_date, 'release_cockpit');

  const reloadedRes = await fetch(`${baseUrl}${postRes.headers.get('location')}`);
  const reloadedHtml = await reloadedRes.text();
  assert.equal(reloadedRes.status, 200);
  assert.match(reloadedHtml, /value="2026-09-19"/);
  assert.match(reloadedHtml, /Release date saved\./);

  const missingLogoRes = await fetch(`${baseUrl}/releases/single/${withoutLogoSongId}`);
  const missingLogoHtml = await missingLogoRes.text();
  assert.equal(missingLogoRes.status, 200);
  assert.match(missingLogoHtml, /data-release-date-input/);
  assert.match(missingLogoHtml, /data-release-header-placeholder/);
  assert.doesNotMatch(missingLogoHtml, /data-release-header-art/);
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

test('missing metadata and audio block package, preview, and live submit but keep readiness available', () => {
  const songId = createSong('Blocked Cockpit Single');
  const cockpit = buildReleaseCockpitViewModel('single', songId);

  assert.equal(cockpit.canLiveSubmit, false);
  assert.ok(cockpit.blockers.some(blocker => /audio file is missing/i.test(blocker)));
  assert.ok(cockpit.blockers.some(blocker => /metadata\.json is missing/i.test(blocker)));
  assert.ok(cockpit.nextActions.find(action => action.key === 'readiness')?.enabled);
  assert.equal(cockpit.nextActions.find(action => action.key === 'package')?.enabled, false);
  assert.equal(cockpit.nextActions.find(action => action.key === 'preview')?.enabled, false);
  assert.equal(cockpit.nextActions.find(action => action.key === 'live_submit')?.enabled, false);
  assert.throws(() => validateReleaseAction('package', cockpit), /Package blocked/);
  assert.throws(() => assertReleaseLiveSubmitReady('single', songId), /Live submit blocked/);
});

test('multiple audio files block packaging until a release master is selected', async () => {
  const songId = createSong('Multiple Audio Master Single');
  writeReadySongFiles(songId);
  writeSongAsset(songId, 'audio/rough.mp3', 'rough-candidate');
  writeSongAsset(songId, 'audio/final.wav', 'final-candidate');

  let releaseAudio = getSelectedReleaseAudio(songId);
  // Multiple masters for one track with no explicit selection is a blocking duplicate,
  // not a normal "choose one" picker.
  assert.equal(releaseAudio.status, 'duplicate');
  assert.equal(releaseAudio.duplicate, true);
  assert.equal(releaseAudio.blocking, true);
  assert.equal(releaseAudio.requiresSelection, true);
  assert.ok(releaseAudio.candidates.length >= 3);

  let cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.stages.find(stage => stage.key === 'audio')?.status, 'blocked');
  assert.ok(cockpit.blockers.some(blocker => /duplicate master audio detected/i.test(blocker)));
  assert.equal(cockpit.nextActions.find(action => action.key === 'package')?.enabled, false);
  assert.throws(() => validateReleaseAction('package', cockpit), /duplicate master audio detected/i);

  selectReleaseAudio(songId, `output/songs/${songId}/audio/final.wav`);
  releaseAudio = getSelectedReleaseAudio(songId);
  assert.equal(releaseAudio.status, 'selected');
  assert.equal(releaseAudio.selected.name, 'final.wav');

  cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.stages.find(stage => stage.key === 'audio')?.status, 'complete');
  assert.equal(cockpit.nextActions.find(action => action.key === 'package')?.enabled, true);

  const pkg = await buildReleasePackageForCockpit('single', songId);
  assert.equal(pkg.ok, true);
  const manifest = getCanonicalReleaseManifest('single', songId);
  assert.match(manifest.audio_file, /audio\.wav$/);
  assert.match(manifest.field_sources.audio_file, /release_audio:output\/songs\/.*\/audio\/final\.wav/);
});

test('album package uses each track release master instead of arbitrary audio candidates', async () => {
  const first = createSong('Album Master One');
  const second = createSong('Album Master Two');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_AUDIO_MASTER'),
    album_title: 'Audio Master Album',
    release_date: '2026-07-12',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [first, second]);
  writeReadyAlbumFiles(albumId, [first, second]);
  writeSongAsset(first, 'audio/demo.mp3', 'demo-candidate');
  writeSongAsset(first, 'audio/final.wav', 'album-final-candidate');

  let cockpit = buildReleaseCockpitViewModel('album', albumId);
  assert.equal(cockpit.stages.find(stage => stage.key === 'audio')?.status, 'blocked');

  selectReleaseAudio(first, `output/songs/${first}/audio/final.wav`);
  cockpit = buildReleaseCockpitViewModel('album', albumId);
  assert.equal(cockpit.stages.find(stage => stage.key === 'audio')?.status, 'complete');

  const pkg = await buildReleasePackageForCockpit('album', albumId);
  assert.equal(pkg.ok, true);
  const manifest = getCanonicalReleaseManifest('album', albumId);
  const firstTrack = manifest.tracks.find(track => track.song_id === first);
  assert.ok(firstTrack);
  assert.match(firstTrack.field_sources.audio_file, /release_audio:output\/songs\/.*\/audio\/final\.wav/);
  assert.ok(manifest.canonical_distrokid_upload_payload.tracks.every(track => track.audio_file));
});

test('missing platform derivatives do not block packaging when primary artwork exists', () => {
  const first = createSong('Derivative Optional One');
  const second = createSong('Derivative Optional Two');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_DERIVATIVES'),
    album_title: 'Optional Derivatives Album',
    release_date: '2026-07-18',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [first, second]);
  // Primary artwork present, tracks ready, but derivatives have no publicUrl (not generated).
  writeAlbumImage(albumId);
  const albumAssetsDir = path.join(repoRoot, 'output', 'albums', albumId, 'assets');
  fs.mkdirSync(albumAssetsDir, { recursive: true });
  fs.writeFileSync(path.join(albumAssetsDir, 'metadata.json'), JSON.stringify({
    primary_image_fingerprint: 'test',
    generated_assets: [
      'spotify-cover-3000x3000.png',
      'youtube-thumbnail-1280x720.png',
      'instagram-square-1080x1080.png',
    ].map(name => ({ name, format: name, path: path.join(albumAssetsDir, name), publicUrl: null })),
  }));
  for (const songId of [first, second]) {
    writeSongAsset(songId, 'audio.mp3', 'fake-audio');
    writeSongAsset(songId, 'metadata.json', JSON.stringify({ artist: 'Pancake Robot', title: `Title ${songId}`, primary_genre: "Children's Music", made_for_kids: true }));
    writeSongAsset(songId, 'lyrics.md', 'la la album');
  }

  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  const mediaStage = cockpit.stages.find(stage => stage.key === 'media');
  assert.equal(mediaStage.status, 'complete');
  assert.match(mediaStage.detail, /optional/i);
  assert.ok(!cockpit.blockers.some(blocker => /derivative/i.test(blocker)), 'derivatives must not be a blocker');
  // The canonical package action is no longer gated by missing derivatives.
  assert.notEqual(cockpit.stages.find(stage => stage.key === 'package')?.status, 'blocked');
});

test('missing cover_art blocks canonical package readiness and disables DistroKid preview with row fix actions', async () => {
  const first = createSong('Package Cover Block One');
  const second = createSong('Package Cover Block Two');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_PACKAGE_COVER'),
    album_title: 'Package Cover Block Album',
    release_date: '2026-07-15',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [first, second]);
  writeReadyAlbumFiles(albumId, [first, second]);
  await buildReleasePackageForCockpit('album', albumId);

  const manifest = getCanonicalReleaseManifest('album', albumId);
  manifest.cover_art = null;
  writePackageManifest(albumId, manifest);

  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  const packageStage = cockpit.stages.find(stage => stage.key === 'package');
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');

  assert.equal(cockpit.packageState.ready, false);
  assert.match(cockpit.packageState.summary, /missing cover art/i);
  assert.equal(packageStage.status, 'blocked');
  assert.ok(packageStage.validationIssues.some(issue => /missing cover_art/i.test(issue)));
  assert.ok(packageStage.actions.some(action => action.label === 'Rebuild canonical package'));
  assert.ok(packageStage.actions.some(action => action.label === 'Generate / rebuild release assets'));
  assert.ok(packageStage.actions.some(action => action.label === 'Rerun package validation'));
  assert.equal(previewStage.actions[0].enabled, false);
  assert.match(previewStage.actions[0].disabledReason, /missing cover art/i);
});

test('missing tracks audio_file blocks canonical package readiness', async () => {
  const first = createSong('Package Audio Block One');
  const second = createSong('Package Audio Block Two');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_PACKAGE_AUDIO'),
    album_title: 'Package Audio Block Album',
    release_date: '2026-07-16',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [first, second]);
  writeReadyAlbumFiles(albumId, [first, second]);
  await buildReleasePackageForCockpit('album', albumId);

  const manifest = getCanonicalReleaseManifest('album', albumId);
  manifest.tracks[1].audio_file = null;
  writePackageManifest(albumId, manifest);

  const cockpit = buildReleaseCockpitViewModel('album', albumId);

  assert.equal(cockpit.packageState.ready, false);
  assert.match(cockpit.packageState.summary, /missing 1 audio file/i);
  assert.ok(cockpit.packageState.validation.issues.some(issue => issue.path === 'tracks[1].audio_file'));
  assert.equal(cockpit.stages.find(stage => stage.key === 'distrokid_preview').actions[0].enabled, false);
});

test('non-existent cover_art path blocks canonical package readiness', async () => {
  const songId = createSong('Missing Cover Path Single');
  writeReadySongFiles(songId);
  await buildReleasePackageForCockpit('single', songId);

  const manifest = getCanonicalReleaseManifest('single', songId);
  manifest.cover_art = 'output/release-packages/DOES_NOT_EXIST/cover-art.png';
  writePackageManifest(songId, manifest);

  const cockpit = buildReleaseCockpitViewModel('single', songId);

  assert.equal(cockpit.packageState.ready, false);
  assert.ok(cockpit.packageState.validation.issues.some(issue => issue.code === 'missing_cover_art_file'));
  assert.match(cockpit.packageState.summary, /missing cover art/i);
});

test('non-existent audio_file path blocks canonical package readiness', async () => {
  const songId = createSong('Missing Audio Path Single');
  writeReadySongFiles(songId);
  await buildReleasePackageForCockpit('single', songId);

  const manifest = getCanonicalReleaseManifest('single', songId);
  manifest.audio_file = 'output/release-packages/DOES_NOT_EXIST/audio.mp3';
  writePackageManifest(songId, manifest);

  const cockpit = buildReleaseCockpitViewModel('single', songId);

  assert.equal(cockpit.packageState.ready, false);
  assert.ok(cockpit.packageState.validation.issues.some(issue => issue.code === 'missing_track_audio_file_path'));
  assert.match(cockpit.packageState.summary, /missing 1 audio file/i);
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
  assert.match(songDetail, /Packaging, DistroKid preview, live submit, HyperFollow, and outreach actions are managed in the Release Cockpit/);
  assert.doesNotMatch(songDetail, /Run Automation Preview/);
  assert.doesNotMatch(songDetail, /Build Package/);
  assert.match(releaseDetail, /Magic Release/);
  assert.match(releaseDetail, /Magic Release command bar/);
  assert.match(releaseDetail, /Release Readiness/);
  assert.match(releaseDetail, /Paste \/ save HyperFollow URL/);
  assert.match(releaseDetail, /Run history \/ logs/);
  assert.match(releaseDetail, /Generate metadata/);
  assert.match(releaseDetail, /Exact missing inputs/);
  assert.match(releaseDetail, /Remove track/);
  assert.doesNotMatch(releaseDetail, /DistroKid Preview card/);
  assert.doesNotMatch(releaseDetail, /Release approval \+ HyperFollow/);
  assert.doesNotMatch(releaseDetail, /HyperFollow capture<\/div>\s*<form/);
  assert.doesNotMatch(releaseDetail, /Release assets in pipeline/);
  assert.doesNotMatch(releaseDetail, /Magic Release tasks/);
  assert.doesNotMatch(releaseDetail, /Control Panel/);
  assert.doesNotMatch(releaseDetail, /Human Handoff/);
  assert.match(releaseModel, /Start full Magic Release/);
  assert.match(releaseModel, /Run next fixable step/);
  assert.match(releaseModel, /Run readiness check/);
  assert.match(releaseModel, /Generate \/ refresh release plan/);
  assert.match(releaseModel, /Run Browsy dry run/);
  assert.match(releaseModel, /Run DistroKid preview automation/);
  assert.match(releaseModel, /Complete login in browser, then resume preview/);
  assert.match(releaseModel, /Stop \/ cancel run/);
  assert.match(releaseModel, /Run live submit automation/);
  assert.match(releaseModel, /Build outreach campaign/);
  assert.match(releaseModel, /Send outreach \/ social tasks/);
  assert.match(releaseModel, /HyperFollow capture/);
  assert.match(releaseModel, /Approve live submit/);
  assert.match(releaseModel, /Generate \/ refresh release assets/);
  assert.match(releaseModel, /Generate \/ rebuild release assets/);
  assert.match(releaseModel, /Rerun package validation/);
});

test('blocked readiness stages expose inline fix actions', () => {
  const songId = createSong('Blocked Actions Single');
  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const metadataStage = cockpit.stages.find(stage => stage.key === 'metadata');
  const audioStage = cockpit.stages.find(stage => stage.key === 'audio');
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');

  assert.ok(metadataStage);
  assert.equal(metadataStage.status, 'blocked');
  assert.deepEqual(metadataStage.actions.map(action => action.label), ['Fix metadata', 'Generate missing metadata', 'Open filtered tracks']);

  assert.ok(audioStage);
  assert.equal(audioStage.status, 'blocked');
  assert.deepEqual(audioStage.actions.map(action => action.label), ['Choose master', 'Generate master', 'Open affected tracks']);

  assert.ok(previewStage);
  assert.equal(previewStage.status, 'blocked');
  assert.match(previewStage.actions[0].disabledReason, /metadata|audio|package/i);
});

test('live submit requires explicit approval before automation becomes runnable', async () => {
  const songId = createSong('Approval Gate Single');
  writeReadySongFiles(songId);

  await buildReleasePackageForCockpit('single', songId);
  const preview = await runDistroKidSongAutomation(songId, { mode: 'preview' });
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'complete', 'Preview completed for approval test.', preview);

  let cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.liveSubmitApproval.approved, false);
  assert.equal(cockpit.nextActions.find(action => action.key === 'approve_live_submit')?.enabled, true);
  assert.equal(cockpit.nextActions.find(action => action.key === 'live_submit')?.enabled, false);
  assert.throws(() => validateReleaseAction('live_submit', cockpit, { confirm: true }), /human approval/i);

  const state = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  upsertReleaseCampaignTask({
    campaign_id: state.campaign.id,
    task_key: 'distrokid_final_submit_approval',
    title: 'Ken approval gate for DistroKid final submit',
    owner: 'ken',
    status: 'complete',
    blocking: true,
    reason: 'Approved for test coverage.',
    completed_at: new Date().toISOString(),
  });

  cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.liveSubmitApproval.approved, true);
  assert.equal(cockpit.nextActions.find(action => action.key === 'live_submit')?.enabled, true);
});

test('album cockpit track table exposes remove-from-release actions and asset pipeline state', () => {
  const first = createSong('Remove Action One');
  const second = createSong('Remove Action Two');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_REMOVE_ROUTE'),
    album_title: 'Remove Action Album',
    release_date: '2026-08-10',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [first, second]);

  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  const mediaStage = cockpit.stages.find(stage => stage.key === 'media');

  assert.ok(cockpit.trackTable.rows.every(row => row.actions.removeTrack));
  assert.ok(mediaStage);
  assert.equal(mediaStage.label, 'Release assets');
  assert.ok(mediaStage.actions.some(action => action.label === 'Generate / refresh release assets' || action.label === 'Open album details'));
});

test('failed DistroKid preview is visible in readiness row and run history', () => {
  const songId = createSong('Failed Preview Visibility Single');
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'running', 'DistroKid preview automation started.', {
    runId: 'preview_test_run',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: `output/release-packages/${songId}/distrokid-run/run-log.json`,
  });
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'failed', 'Preview crashed before upload.', {
    runId: 'preview_test_run',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: `output/release-packages/${songId}/distrokid-run/run-log.json`,
    error: 'audio_file not found: (missing); cover_art not found: (missing)',
  });

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');

  assert.ok(previewStage);
  assert.equal(previewStage.status, 'failed');
  assert.match(previewStage.detail, /audio_file not found/i);
  assert.match(previewStage.detail, /cover_art not found/i);
  assert.equal(previewStage.latestRun?.runId, 'preview_test_run');
  assert.match(previewStage.latestRun?.logPath || '', /run-log\.json$/);
  assert.ok(previewStage.actions.some(action => /DistroKid preview automation/.test(action.label)));
  assert.equal(cockpit.runHistory[0].runId, 'preview_test_run');
  assert.equal(cockpit.runHistory[0].status, 'failed');
});

test('running preview with a finished run-log is coerced out of running status', () => {
  const songId = createSong('Preview Running Coercion Single');
  const logPath = writePreviewRunArtifacts(songId, {
    filledCount: 0,
    skippedCount: 2,
    errorCount: 1,
    finalStatus: 'failed',
    errors: [
      { field: 'number_of_songs', error: 'Number of songs dropdown does not contain required option: 21 songs' },
    ],
  });
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'running', 'DistroKid preview automation started.', {
    runId: 'preview_running_coercion',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: logPath,
    active: false,
  });

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');

  assert.equal(previewStage.latestRun?.status, 'failed');
  assert.notEqual(previewStage.status, 'running');
});

test('preview diagnostics expose artifact links and selected/rendered track counts', () => {
  const songId = createSong('Preview Artifact Links Single');
  const logPath = writePreviewRunArtifacts(songId, {
    filledCount: 12,
    skippedCount: 0,
    errorCount: 0,
    finalStatus: 'complete',
    trackCountValidation: {
      requestedTrackCount: 21,
      selectedOption: '21 songs',
      renderedTrackCount: 21,
      ok: true,
    },
  });
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'complete', 'Automation process complete.', {
    runId: 'preview_artifacts_run',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: logPath,
  });

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');
  const labels = previewStage.diagnostics?.artifacts?.map(item => item.label) || [];

  assert.equal(previewStage.diagnostics?.trackCountValidation?.selectedOption, '21 songs');
  assert.equal(previewStage.diagnostics?.trackCountValidation?.renderedTrackCount, 21);
  assert.deepEqual(labels, [
    'Final review screenshot',
    'After fill screenshot',
    'Errors JSON',
    'Filled fields JSON',
    'Skipped fields JSON',
    'Run log JSON',
    'HTML snapshot',
    'Page text snapshot',
  ]);
});

test('process-complete preview with zero filled fields and errors renders as failed and blocks approval', () => {
  const albumId = 'ALBUM_MPK9H71S_RTCM';
  albumIds.add(albumId);
  createAlbum({
    id: albumId,
    album_title: 'Fixture Album',
    release_date: '2026-06-20',
    number_of_songs: 21,
    status: 'assembled',
    is_test: true,
  });
  const failedLogPath = writePreviewRunArtifacts(albumId, {
    releaseType: 'album',
    filledCount: 0,
    skippedCount: 334,
    errorCount: 215,
    errors: [
      { field: 'language', error: 'language not found: (missing)' },
      { field: 'track_title_track_1', error: 'track 1 title not found: (missing)' },
      { field: 'cover_art', error: 'file input not found: #artwork' },
      { field: 'audio_file_track_1', error: 'file input not found: #js-track-upload-1' },
      { field: 'ai_generated_gate', error: 'ai disclosure not found: (missing)' },
      { field: 'not_explicit_track_1', error: 'not explicit certification not found: (missing)' },
    ],
  });
  logReleaseCockpitEvent('album', albumId, 'distrokid_preview', 'complete', 'Automation process complete.', {
    runId: 'fixture_preview_run',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: failedLogPath,
    entityType: 'album',
    releaseId: albumId,
  });

  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');
  const approveAction = cockpit.nextActions.find(action => action.key === 'approve_live_submit');

  assert.ok(previewStage);
  assert.equal(previewStage.status, 'failed');
  assert.equal(previewStage.outcome, 'failed');
  assert.match(previewStage.detail, /did not stage the release/i);
  assert.match(previewStage.detail, /0 fields filled\. 215 errors\. 334 skipped\./i);
  assert.match(previewStage.detail, /Required DistroKid controls\/files were not found\./i);
  assert.equal(previewStage.latestRun?.processStatusLabel, 'process complete');
  assert.deepEqual(previewStage.diagnostics?.missingGroups.map(group => group.key), [
    'album_metadata',
    'tracks',
    'audio_uploads',
    'artwork',
    'ai_disclosure',
    'certifications',
  ]);
  assert.equal(approveAction?.enabled, false);
  assert.match(approveAction?.disabledReason || '', /did not stage the release|failed|filled 0 fields|required DistroKid uploads or controls are still missing/i);
});

test('approve live submit stays disabled until a true successful dry run exists', async () => {
  const songId = createSong('Strict Preview Gate Single');
  writeReadySongFiles(songId);
  await buildReleasePackageForCockpit('single', songId);

  const failedLogPath = writePreviewRunArtifacts(songId, {
    filledCount: 0,
    skippedCount: 5,
    errorCount: 2,
    errors: [
      { field: 'cover_art', error: 'file input not found: #artwork' },
      { field: 'audio_file_track_1', error: 'file input not found: #js-track-upload-1' },
    ],
  });
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'complete', 'Automation process complete.', {
    runId: 'failed_preview_gate',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: failedLogPath,
    entityType: 'single',
    releaseId: songId,
  });

  let cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.stages.find(stage => stage.key === 'distrokid_preview')?.outcome, 'failed');
  assert.equal(cockpit.nextActions.find(action => action.key === 'approve_live_submit')?.enabled, false);

  const passedLogPath = writePreviewRunArtifacts(songId, {
    filledCount: 12,
    skippedCount: 0,
    errorCount: 0,
  });
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'complete', 'Automation process complete.', {
    runId: 'passed_preview_gate',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: passedLogPath,
    entityType: 'single',
    releaseId: songId,
  });

  cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.stages.find(stage => stage.key === 'distrokid_preview')?.status, 'complete');
  assert.equal(cockpit.stages.find(stage => stage.key === 'distrokid_preview')?.outcome, 'passed');
  assert.equal(cockpit.nextActions.find(action => action.key === 'approve_live_submit')?.enabled, true);
  assert.match(cockpit.runHistory[0].displayStatus || '', /process complete/i);
  assert.doesNotMatch(cockpit.stages.find(stage => stage.key === 'distrokid_preview')?.detail || '', /preview automation finished/i);
});

test('DistroKid preview route uses the canonical album manifest resolver without throwing', async t => {
  const fixtureAlbumId = 'ALBUM_MPK9H71S_RTCM';
  const albumId = uniqueId(fixtureAlbumId);
  const first = createSong('Preview Route Album One');
  const second = createSong('Preview Route Album Two');
  albumIds.add(albumId);

  createAlbum({
    id: albumId,
    album_title: 'Preview Route Album',
    release_date: '2026-08-21',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  assignSongsToAlbum(albumId, [first, second]);
  writeReadyAlbumFiles(albumId, [first, second]);
  await buildReleasePackageForCockpit('album', albumId);

  assert.equal(
    getCanonicalReleaseManifestPath('album', fixtureAlbumId),
    path.join(repoRoot, 'output', 'release-packages', fixtureAlbumId, 'manifest.json'),
  );

  const server = await startServer();
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/releases/album/${albumId}/actions/distrokid-preview`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.match(body.message || '', /DistroKid preview automation started/i);
});

test('blocked DistroKid preview exposes resume guidance and stop action while browser session remains active', () => {
  const songId = createSong('Blocked Preview Visibility Single');
  writeReadySongFiles(songId);
  writePackageManifest(songId, {
    song_id: songId,
    audio_file: `output/songs/${songId}/audio.mp3`,
    cover_art: `output/marketing-ready/${songId}/no-text-variation.png`,
    readiness: {
      ready_for_distrokid_dry_run: true,
      blocking_missing_fields: [],
    },
  });
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'blocked', 'DistroKid login required. Complete login in the browser, then resume.', {
    runId: 'preview_blocked_run',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: `output/release-packages/${songId}/distrokid-run/run-log.json`,
    code: 'distrokid_login_required',
    active: true,
  });

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');

  assert.ok(previewStage);
  assert.equal(previewStage.status, 'blocked');
  assert.match(previewStage.detail, /Complete login in the browser, then resume/i);
  assert.equal(previewStage.actions[0].label, 'Complete login in browser, then resume preview');
  assert.equal(previewStage.actions[0].enabled, false);
  assert.ok(previewStage.actions.some(action => action.label === 'Stop / cancel run' && action.enabled));
});

test('blocked fill validation preview is not reported as successful', () => {
  const songId = createSong('Blocked Fill Validation Single');
  const logPath = writePreviewRunArtifacts(songId, {
    filledCount: 8,
    skippedCount: 2,
    errorCount: 1,
    finalStatus: 'blocked',
    errors: [
      { field: 'distrokid_form_validation', code: 'blocked_fill_validation', error: 'DistroKid form validation failed. Expected album title "Blocked Fill Validation Single", rendered 21/21 track groups, filled 0/21 track titles.' },
    ],
  });
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'blocked', 'DistroKid form validation failed after fill.', {
    runId: 'blocked_fill_validation_run',
    command: 'node scripts/distrokid/upload-release.mjs --dry-run',
    latest_run_log_path: logPath,
    code: 'blocked_fill_validation',
  });

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');

  assert.ok(previewStage);
  assert.equal(previewStage.status, 'blocked');
  assert.equal(previewStage.outcome, 'failed');
  assert.match(previewStage.detail, /form validation failed/i);
  assert.equal(cockpit.nextActions.find(action => action.key === 'approve_live_submit')?.enabled, false);
});

test('mocked release cockpit acceptance covers single lifecycle actions', async () => {
  const songId = createSong('Acceptance Cockpit Single');
  writeReadySongFiles(songId);
  const outletId = seedEmailOutlet(uniqueId('COCKPIT_OUTLET'));

  let cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(validateReleaseAction('readiness', cockpit).ok, true);
  assert.throws(() => validateReleaseAction('preview', cockpit), /DistroKid preview blocked/);

  const pkg = await buildReleasePackageForCockpit('single', songId);
  assert.equal(pkg.ok, true);
  cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.lifecycle.current, 'approved_for_distribution');
  assert.equal(cockpit.packageState.ready, true);
  assert.equal(cockpit.stages.find(stage => stage.key === 'distrokid_preview')?.actions[0]?.enabled, true);

  assert.throws(() => validateReleaseAction('live_submit', cockpit), /No latest DistroKid preview run exists|Latest DistroKid preview has not passed/);
  const preview = await runDistroKidSongAutomation(songId, { mode: 'preview' });
  assert.equal(preview.ok, true);
  logReleaseCockpitEvent('single', songId, 'distrokid_preview', 'complete', 'Acceptance preview complete.', preview);
  cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.lifecycle.current, 'distrokid_previewed');
  assert.throws(() => validateReleaseAction('live_submit', cockpit), /explicit confirmation/);

  const live = await runDistroKidSongAutomation(songId, {
    mode: 'live',
    confirm: true,
    releaseUrl: 'https://distrokid.com/release/cockpit-single',
  });
  assert.equal(live.ok, true);
  cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.lifecycle.current, 'submitted_to_distrokid');
  assert.equal(getDistroKidJob(songId).status, 'submitted_pending_hyperfollow');

  const hyperfollow = await captureHyperFollowLink(songId, {
    hyperfollowUrl: 'https://distrokid.com/hyperfollow/pancakerobot/cockpit-single',
  });
  assert.equal(hyperfollow.status, 'captured');
  cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.lifecycle.current, 'hyperfollow_ready');

  const outreach = createOutreachRun({
    song_ids: [songId],
    outlet_ids: [outletId],
    dry_run: true,
  });
  assert.equal(outreach.campaign_count, 1);
});

test('mocked release cockpit acceptance covers canonical album package and logs', async () => {
  const first = createSong('Acceptance Album One');
  const second = createSong('Acceptance Album Two');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_ACCEPT'),
    album_title: 'Acceptance Album',
    release_date: '2026-07-10',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [first, second]);
  writeReadyAlbumFiles(albumId, [first, second]);

  let cockpit = buildReleaseCockpitViewModel('album', albumId);
  assert.equal(validateReleaseAction('readiness', cockpit).ok, true);
  const pkg = await buildReleasePackageForCockpit('album', albumId);
  assert.equal(pkg.ok, true);
  const manifest = getCanonicalReleaseManifest('album', albumId);
  assert.equal(manifest.schema_version, 'distrokid-album-release-package-v1');
  assert.equal(Object.hasOwn(manifest, 'song_id'), false);
  assert.equal(manifest.album_id, albumId);
  assert.equal(manifest.release_id, albumId);
  assert.deepEqual(manifest.readiness.ordered_tracks, [first, second]);
  assert.equal(manifest.tracks.length, 2);
  assert.equal(manifest.canonical_distrokid_upload_payload.tracks.length, 2);
  assert.ok(manifest.inherited_album_media.primary_image);
  assert.ok(manifest.tracks.every(track => track.song_id));
  assert.ok(manifest.tracks.every(track => track.audio_file));
  assert.ok(manifest.cover_art);

  cockpit = buildReleaseCockpitViewModel('album', albumId);
  assert.equal(cockpit.packageState.ready, true);
  const preview = await runDistroKidAlbumAutomation(albumId, { mode: 'preview' });
  assert.equal(preview.ok, true);
  logReleaseCockpitEvent('album', albumId, 'distrokid_preview', 'complete', 'Acceptance preview complete.', preview);
  assert.equal(buildReleaseCockpitViewModel('album', albumId).logs[0].action, 'distrokid_preview');
});

test('album media stage falls back to canonical package media when live album asset directory is missing', async () => {
  const first = createSong('Canonical Media Fallback One');
  const second = createSong('Canonical Media Fallback Two');
  const albumId = createAlbum({
    id: uniqueId('COCKPIT_ALBUM_MEDIA_FALLBACK'),
    album_title: 'Canonical Media Fallback Album',
    release_date: '2026-07-22',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [first, second]);
  writeReadyAlbumFiles(albumId, [first, second]);

  const pkg = await buildReleasePackageForCockpit('album', albumId);
  assert.equal(pkg.ok, true);

  fs.rmSync(path.join(repoRoot, 'output', 'albums', albumId), { recursive: true, force: true });

  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  const mediaStage = cockpit.stages.find(stage => stage.key === 'media');

  assert.ok(cockpit.releaseAssetState.primaryImage);
  assert.equal(cockpit.releaseAssetState.primaryImage.source, 'canonical_package_media');
  assert.equal(mediaStage?.status, 'complete');
  assert.equal(mediaStage?.issues.length, 0);
  assert.equal(cockpit.distrokidArtwork.blocked, false);
  assert.match(cockpit.distrokidArtwork.path || '', new RegExp(`output/release-packages/${albumId}/cover-art`));
});

test('album header artwork renders brand image when album media is missing', async t => {
  const songId = createSong('Header Brand Fallback Song', { brand_profile_id: 'test-header-brand-fallback' });
  const albumId = uniqueId('COCKPIT_ALBUM_HEADER_BRAND');
  albumIds.add(albumId);
  createAlbum({
    id: albumId,
    album_title: 'Header Brand Fallback Album',
    release_date: '2026-08-11',
    brand_profile_id: 'test-header-brand-fallback',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  assignSongsToAlbum(albumId, [songId]);

  const brandMediaDir = path.join(repoRoot, 'config', 'brand-media', 'test-header-brand-fallback');
  fs.mkdirSync(brandMediaDir, { recursive: true });
  fs.writeFileSync(path.join(brandMediaDir, 'default-image.png'), 'fake-header-brand-image');

  const server = await startServer();
  t.after(() => {
    server.close();
    fs.rmSync(brandMediaDir, { recursive: true, force: true });
  });

  const html = await fetch(`http://127.0.0.1:${server.address().port}/releases/album/${albumId}`).then(res => res.text());
  assert.match(html, /data-release-header-art/);
  assert.match(html, /data-release-header-art-source="brand_media"/);
  assert.match(html, /\/brand-media\/test-header-brand-fallback\/default-image\.png/);
});

test('album header artwork prefers canonical package artwork over brand image', async t => {
  const songId = createSong('Header Canonical Artwork Song');
  const albumId = uniqueId('COCKPIT_ALBUM_HEADER_CANONICAL');
  albumIds.add(albumId);
  createAlbum({
    id: albumId,
    album_title: 'Header Canonical Artwork Album',
    release_date: '2026-08-12',
    brand_profile_id: 'default',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  assignSongsToAlbum(albumId, [songId]);
  writeReadyAlbumFiles(albumId, [songId]);
  await buildReleasePackageForCockpit('album', albumId);
  fs.rmSync(path.join(repoRoot, 'output', 'albums', albumId), { recursive: true, force: true });

  const server = await startServer();
  t.after(() => server.close());

  const html = await fetch(`http://127.0.0.1:${server.address().port}/releases/album/${albumId}`).then(res => res.text());
  assert.match(html, /data-release-header-art-source="canonical_package_media"/);
  assert.match(html, new RegExp(`/media/release-packages/${albumId}/cover-art\\.png`));
  assert.doesNotMatch(html, /\/brand-media\/default\/default-image\.png/);
});

test('album header artwork renders a placeholder instead of a broken image when no media is available', async t => {
  const songId = createSong('Header Placeholder Song', { brand_profile_id: 'test-header-placeholder' });
  const albumId = uniqueId('COCKPIT_ALBUM_HEADER_PLACEHOLDER');
  albumIds.add(albumId);
  createAlbum({
    id: albumId,
    album_title: 'Header Placeholder Album',
    release_date: '2026-08-13',
    brand_profile_id: 'test-header-placeholder',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  assignSongsToAlbum(albumId, [songId]);

  const server = await startServer();
  t.after(() => server.close());

  const html = await fetch(`http://127.0.0.1:${server.address().port}/releases/album/${albumId}`).then(res => res.text());
  assert.match(html, /data-release-header-placeholder/);
  assert.doesNotMatch(html, /data-release-header-art/);
});

test('distrokidArtwork uses album primary image when present', () => {
  const songId = createSong('Artwork Album Primary Song');
  const albumId = uniqueId('COCKPIT_ALBUM_ARTWORK_PRIMARY');
  albumIds.add(albumId);
  createAlbum({
    id: albumId,
    album_title: 'Artwork Primary Album',
    release_date: '2026-08-01',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  assignSongsToAlbum(albumId, [songId]);
  writeAlbumImage(albumId);

  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  assert.equal(cockpit.distrokidArtwork.blocked, false);
  assert.equal(cockpit.distrokidArtwork.source, 'album_media');
  assert.ok(cockpit.distrokidArtwork.path);
  assert.ok(fs.existsSync(cockpit.distrokidArtwork.path));
  assert.ok(cockpit.distrokidArtwork.ext);
});

test('distrokidArtwork uses brand default image when album art missing', () => {
  const songId = createSong('Artwork Brand Fallback Song', { brand_profile_id: 'test-artwork-brand-fallback' });
  const albumId = uniqueId('COCKPIT_ALBUM_ARTWORK_BRAND');
  albumIds.add(albumId);
  createAlbum({
    id: albumId,
    album_title: 'Brand Fallback Artwork Album',
    release_date: '2026-08-02',
    brand_profile_id: 'test-artwork-brand-fallback',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  assignSongsToAlbum(albumId, [songId]);

  const brandMediaDir = path.join(repoRoot, 'config', 'brand-media', 'test-artwork-brand-fallback');
  const brandDefaultPath = path.join(brandMediaDir, 'default-image.png');
  fs.mkdirSync(brandMediaDir, { recursive: true });
  fs.writeFileSync(brandDefaultPath, 'fake-brand-default-image');
  try {
    const cockpit = buildReleaseCockpitViewModel('album', albumId);
    assert.equal(cockpit.distrokidArtwork.blocked, false);
    assert.equal(cockpit.distrokidArtwork.source, 'brand_media');
    assert.ok(cockpit.distrokidArtwork.path);
  } finally {
    fs.rmSync(brandMediaDir, { recursive: true, force: true });
  }
});

test('distrokidArtwork is blocked when no album image and no brand default', () => {
  const songId = createSong('Artwork Blocked Song', { brand_profile_id: 'test-artwork-no-brand' });
  const albumId = uniqueId('COCKPIT_ALBUM_ARTWORK_BLOCKED');
  albumIds.add(albumId);
  createAlbum({
    id: albumId,
    album_title: 'No Artwork Album',
    release_date: '2026-08-03',
    brand_profile_id: 'test-artwork-no-brand',
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  assignSongsToAlbum(albumId, [songId]);

  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  assert.equal(cockpit.distrokidArtwork.blocked, true);
  assert.equal(cockpit.distrokidArtwork.path, null);
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');
  assert.ok(previewStage.issues.some(issue => /artwork not resolved/i.test(issue)));
});

test('distrokidArtwork is blocked when resolved path does not exist on disk', () => {
  const artwork = resolveDistroKidArtwork({
    primaryImage: { path: '/nonexistent/path/does-not-exist.png', source: 'album_media' },
  });
  assert.equal(artwork.blocked, true);
  assert.equal(artwork.path, null);
});

test('distrokid artwork download route returns deterministic filename', async t => {
  const songId = createSong('Artwork Download Single', { brand_profile_id: 'test-artwork-download-brand' });

  const server = await startServer();
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const blockedRes = await fetch(`${baseUrl}/releases/single/${songId}/assets/distrokid-artwork/download`);
  assert.equal(blockedRes.status, 409);

  const artworkPath = path.join(repoRoot, 'output', 'songs', songId, 'reference', 'base-image.png');
  fs.mkdirSync(path.dirname(artworkPath), { recursive: true });
  fs.writeFileSync(artworkPath, 'fake-artwork-for-download');

  const res = await fetch(`${baseUrl}/releases/single/${songId}/assets/distrokid-artwork/download`);
  assert.equal(res.status, 200);
  const disposition = res.headers.get('content-disposition');
  assert.ok(disposition, 'content-disposition header should be present');
  assert.match(disposition, new RegExp(`${songId}-distrokid-artwork\\.png`));
});

test('distrokid payload download route returns canonical JSON with absolute paths', async t => {
  const songId = createSong('Payload Download Single');
  writeReadySongFiles(songId);
  await buildReleasePackageForCockpit('single', songId);

  const server = await startServer();
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${baseUrl}/releases/single/${songId}/assets/distrokid-payload/download`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', new RegExp(`${songId}-distrokid-payload\\.json`));

  const payload = await res.json();
  assert.equal(payload.releaseId, songId);
  assert.equal(payload.trackCount, 1);
  assert.equal(path.isAbsolute(payload.artworkPath), true);
  assert.equal(path.isAbsolute(payload.tracks[0].audioPath), true);
  assert.equal(typeof payload.tracks[0].lyrics, 'string');
});
