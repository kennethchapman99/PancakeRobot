import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-automation-setup-wizard').slug;
process.env.PANCAKE_DISTROKID_AUTOMATION_STUB = '1';

const repoRoot = path.resolve(import.meta.dirname, '..');
const songIds = new Set();
const albumIds = new Set();

test.after(() => cleanupTestOutputArtifacts({ songIds: [...songIds], albumIds: [...albumIds] }));

const { upsertSong, createAlbum, assignSongsToAlbum } = await import('../src/shared/db.js');
const { app } = await import('../src/web/server.js');
const {
  buildDistroKidAlbumWorkflowContext,
  getDistroKidAlbumSubmitPreset,
  validateDistroKidAlbumWorkflowContext,
} = await import('../src/shared/automation-workflow-presets.js');
const { createMagicReleaseCampaign } = await import('../src/shared/magic-release.js');
const { buildReleaseCockpitViewModel } = await import('../src/shared/release-cockpit.js');
const { buildBrowsyRecordingSpecForTask } = await import('../src/shared/magic-release-browsy-recordings.js');

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function writeSongAsset(songId, relativePath, content = 'test') {
  const filePath = path.join(repoRoot, 'output', 'songs', songId, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function seedAlbum({ releaseDate = '2026-09-01', audio = true, artwork = true } = {}) {
  const songId = uniqueId('SETUPSONG');
  songIds.add(songId);
  upsertSong({ id: songId, title: `Setup ${songId}`, brand_profile_id: 'default', release_date: releaseDate, is_test: true });
  if (audio) writeSongAsset(songId, 'audio.mp3', 'fake-audio');
  if (artwork) writeSongAsset(songId, 'reference/base-image.png', 'fake-art');
  const albumId = createAlbum({
    id: uniqueId('SETUPALBUM'),
    album_title: 'Setup Album',
    release_date: releaseDate,
    number_of_songs: 1,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, [songId]);
  return albumId;
}

function startServer() {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('DistroKid Album Submit preset exposes required variables/assets and derived numberOfSongs', () => {
  const preset = getDistroKidAlbumSubmitPreset();
  assert.equal(preset.workflowId, 'distrokid-album-submit');
  assert.equal(preset.workflowName, 'DistroKid Album Submit');
  assert.equal(preset.sourceApp, 'pancake-robot');
  const albumProps = preset.inputSchema.properties.album.properties;
  const trackProps = preset.inputSchema.properties.tracks.items.properties;
  assert.ok(albumProps.title);
  assert.ok(albumProps.artistName);
  assert.ok(albumProps.releaseDate);
  assert.ok(albumProps.coverArtPath);
  assert.ok(preset.inputSchema.properties.tracks);
  assert.ok(trackProps.title);
  assert.ok(trackProps.audioPath);
  assert.ok(trackProps.explicit);
  assert.equal(preset.derivedVariables.numberOfSongs, 'tracks.length');
  assert.ok(preset.bindingHints.some(hint => hint.path === 'album.releaseDate'));
  assert.ok(preset.requiredAssets.some(asset => asset.path === 'album.coverArtPath'));
  assert.ok(preset.requiredAssets.some(asset => asset.path === 'tracks[].audioPath'));
});

test('workflow context maps album release payload including releaseDate, artwork, audio, and tracks.length', () => {
  const albumId = seedAlbum();
  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  const context = buildDistroKidAlbumWorkflowContext({ cockpit, releaseId: albumId });
  assert.equal(context.samplePayload.album.title, 'Setup Album');
  assert.equal(context.samplePayload.album.releaseDate, '2026-09-01');
  assert.ok(context.samplePayload.album.coverArtPath);
  assert.equal(context.samplePayload.tracks.length, 1);
  assert.ok(context.samplePayload.tracks[0].audioPath.endsWith('audio.mp3'));
  assert.equal(context.samplePayload.derived.numberOfSongs, context.samplePayload.tracks.length);
  assert.equal(context.validation.ok, true);
});

test('setup validation blocks missing release date, about:blank target, artwork, and track audio', () => {
  const valid = buildDistroKidAlbumWorkflowContext({ cockpit: buildReleaseCockpitViewModel('album', seedAlbum()) });
  assert.equal(validateDistroKidAlbumWorkflowContext({ ...valid, targetUrl: 'about:blank' }).ok, false);
  const missingReleaseDate = structuredClone(valid);
  missingReleaseDate.samplePayload.album.releaseDate = '';
  assert.match(validateDistroKidAlbumWorkflowContext(missingReleaseDate).errors.join(' '), /album\.releaseDate/);
  const missingArt = structuredClone(valid);
  missingArt.samplePayload.album.coverArtPath = '';
  assert.match(validateDistroKidAlbumWorkflowContext(missingArt).errors.join(' '), /album\.coverArtPath/);
  const missingAudio = structuredClone(valid);
  missingAudio.samplePayload.tracks[0].audioPath = '';
  assert.match(validateDistroKidAlbumWorkflowContext(missingAudio).errors.join(' '), /tracks\[0\]\.audioPath/);
});

test('recording launch spec sends full workflow context to Browsy before recorder launch', () => {
  const albumId = seedAlbum();
  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  const context = buildDistroKidAlbumWorkflowContext({ cockpit, releaseId: albumId });
  const state = createMagicReleaseCampaign({ releaseType: 'album', releaseId: albumId });
  const task = state.tasks.find(item => item.task_key === 'distrokid_submit_dry_run');
  const built = buildBrowsyRecordingSpecForTask({ campaign: state.campaign, task, workflowContext: context });
  assert.equal(built.spec.workflowRef, 'pancake-robot.distrokid-album-submit');
  assert.equal(built.spec.workflowId, 'distrokid-album-submit');
  assert.equal(built.spec.workflowName, 'DistroKid Album Submit');
  assert.equal(built.spec.sourceApp, 'pancake-robot');
  assert.equal(built.spec.targetUrl, 'https://distrokid.com/new/');
  assert.ok(built.spec.inputSchema);
  assert.ok(built.spec.requiredAssets.length >= 2);
  assert.equal(built.spec.samplePayload.album.releaseDate, '2026-09-01');
  assert.ok(built.spec.bindingHints.some(hint => hint.path === 'tracks[].audioPath'));
});

test('Automation Setup Wizard renders variables and sample payload before launch', async () => {
  const albumId = seedAlbum();
  const server = await startServer();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/releases/album/${encodeURIComponent(albumId)}/automation-setup`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Automation Setup Wizard/);
    assert.match(html, /DistroKid Album Submit/);
    assert.match(html, /album\.releaseDate/);
    assert.match(html, /album\.coverArtPath/);
    assert.match(html, /tracks\[\]\.audioPath/);
    assert.match(html, /derived\.numberOfSongs/);
    assert.match(html, /2026-09-01/);
    assert.match(html, /audio\.mp3/);
    assert.doesNotMatch(html, /Start Recording Browser/);
  } finally {
    server.close();
  }
});
