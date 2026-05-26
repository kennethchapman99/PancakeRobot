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
  getCanonicalReleaseManifest,
  listReleaseCockpitEntries,
  logReleaseCockpitEvent,
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

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  assert.equal(releaseAudio.status, 'needs_selection');
  assert.equal(releaseAudio.requiresSelection, true);
  assert.ok(releaseAudio.candidates.length >= 3);

  let cockpit = buildReleaseCockpitViewModel('single', songId);
  assert.equal(cockpit.stages.find(stage => stage.key === 'audio')?.status, 'blocked');
  assert.ok(cockpit.blockers.some(blocker => /choose release audio master/i.test(blocker)));
  assert.equal(cockpit.nextActions.find(action => action.key === 'package')?.enabled, false);
  assert.throws(() => validateReleaseAction('package', cockpit), /choose release audio master/i);

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
  assert.match(releaseModel, /Run live submit automation/);
  assert.match(releaseModel, /Build outreach campaign/);
  assert.match(releaseModel, /Send outreach \/ social tasks/);
  assert.match(releaseModel, /HyperFollow capture/);
  assert.match(releaseModel, /Approve live submit/);
  assert.match(releaseModel, /Generate \/ refresh release assets/);
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
    error: 'ReferenceError: Cannot access finished before initialization',
  });

  const cockpit = buildReleaseCockpitViewModel('single', songId);
  const previewStage = cockpit.stages.find(stage => stage.key === 'distrokid_preview');

  assert.ok(previewStage);
  assert.equal(previewStage.status, 'failed');
  assert.match(previewStage.detail, /ReferenceError/);
  assert.equal(previewStage.latestRun?.runId, 'preview_test_run');
  assert.match(previewStage.latestRun?.logPath || '', /run-log\.json$/);
  assert.ok(previewStage.actions.some(action => action.label === 'Run DistroKid preview automation'));
  assert.equal(cockpit.runHistory[0].runId, 'preview_test_run');
  assert.equal(cockpit.runHistory[0].status, 'failed');
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

  assert.throws(() => validateReleaseAction('live_submit', cockpit), /DistroKid preview has not been completed/);
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
  assert.deepEqual(manifest.readiness.ordered_tracks, [first, second]);
  assert.equal(manifest.tracks.length, 2);
  assert.equal(manifest.canonical_distrokid_upload_payload.tracks.length, 2);
  assert.ok(manifest.inherited_album_media.primary_image);

  cockpit = buildReleaseCockpitViewModel('album', albumId);
  assert.equal(cockpit.packageState.ready, true);
  const preview = await runDistroKidAlbumAutomation(albumId, { mode: 'preview' });
  assert.equal(preview.ok, true);
  logReleaseCockpitEvent('album', albumId, 'distrokid_preview', 'complete', 'Acceptance preview complete.', preview);
  assert.equal(buildReleaseCockpitViewModel('album', albumId).logs[0].action, 'distrokid_preview');
});
