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

function seedAlbum({ releaseDate = '2026-09-01', audio = true, artwork = true, trackCount = 1, audioLayout = 'root', imported = false } = {}) {
  const ids = [];
  for (let i = 0; i < trackCount; i++) {
    const songId = uniqueId('SETUPSONG');
    ids.push(songId);
    songIds.add(songId);
    upsertSong({
      id: songId,
      title: `Setup ${i + 1}`,
      brand_profile_id: imported ? 'imported-test' : 'default',
      release_date: releaseDate,
      pipeline_stage: imported ? 'imported' : 'album_track_generated',
      is_test: true,
    });
    if (audio) writeSongAsset(songId, audioLayout === 'nested' ? `audio/setup-${i + 1}.mp3` : 'audio.mp3', 'fake-audio');
    if (artwork && i === 0) writeSongAsset(songId, 'reference/base-image.png', 'fake-art');
  }
  const albumId = createAlbum({
    id: uniqueId('SETUPALBUM'),
    album_title: 'Setup Album',
    release_date: releaseDate,
    number_of_songs: trackCount,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  assignSongsToAlbum(albumId, ids);
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
  assert.ok(preset.inputSchema.properties.releaseId);
  assert.ok(preset.inputSchema.properties.albumId);
  assert.ok(albumProps.id);
  assert.ok(albumProps.releaseId);
  assert.ok(albumProps.title);
  assert.ok(albumProps.artistName);
  assert.ok(albumProps.releaseDate);
  assert.ok(albumProps.coverArtPath);
  assert.ok(preset.inputSchema.properties.tracks);
  assert.ok(trackProps.title);
  assert.ok(trackProps.audioPath);
  assert.ok(trackProps.explicit);
  assert.equal(preset.derivedVariables.numberOfSongs, 'tracks.length');
  assert.ok(preset.bindingHints.some(hint => hint.path === 'releaseId'));
  assert.ok(preset.bindingHints.some(hint => hint.path === 'album.releaseDate'));
  assert.ok(preset.requiredAssets.some(asset => asset.path === 'album.coverArtPath'));
  assert.ok(preset.requiredAssets.some(asset => asset.path === 'tracks[].audioPath'));
});

test('workflow context maps album release payload including releaseDate, artwork, audio, and tracks.length', () => {
  const albumId = seedAlbum();
  const cockpit = buildReleaseCockpitViewModel('album', albumId);
  const context = buildDistroKidAlbumWorkflowContext({ cockpit, releaseId: albumId });
  assert.equal(context.samplePayload.releaseId, albumId);
  assert.equal(context.samplePayload.albumId, albumId);
  assert.equal(context.samplePayload.album.id, albumId);
  assert.equal(context.samplePayload.album.releaseId, albumId);
  assert.equal(context.samplePayload.album.title, 'Setup Album');
  assert.equal(context.samplePayload.album.releaseDate, '2026-09-01');
  assert.ok(context.samplePayload.album.coverArtPath);
  assert.equal(context.samplePayload.tracks.length, 1);
  assert.ok(context.samplePayload.tracks[0].audioPath.endsWith('audio.mp3'));
  assert.equal(context.samplePayload.derived.numberOfSongs, context.samplePayload.tracks.length);
  assert.equal(context.validation.ok, true);
});

test('workflow context exposes valid audioPath for generated and imported multi-track releases', () => {
  for (const trackCount of [1, 3, 10, 20]) {
    const generatedAlbumId = seedAlbum({ trackCount, audioLayout: 'nested' });
    const generated = buildDistroKidAlbumWorkflowContext({
      cockpit: buildReleaseCockpitViewModel('album', generatedAlbumId),
      releaseId: generatedAlbumId,
    });
    assert.equal(generated.samplePayload.tracks.length, trackCount);
    assert.equal(generated.validation.ok, true, generated.validation.errors.join('; '));
    generated.samplePayload.tracks.forEach((track, index) => {
      assert.ok(track.audioPath, `generated ${trackCount} tracks[${index}].audioPath missing`);
      assert.ok(fs.existsSync(track.audioPath), `generated ${trackCount} tracks[${index}].audioPath missing on disk`);
    });

    const importedAlbumId = seedAlbum({ trackCount, imported: true });
    const imported = buildDistroKidAlbumWorkflowContext({
      cockpit: buildReleaseCockpitViewModel('album', importedAlbumId),
      releaseId: importedAlbumId,
    });
    assert.equal(imported.samplePayload.tracks.length, trackCount);
    assert.equal(imported.validation.ok, true, imported.validation.errors.join('; '));
    imported.samplePayload.tracks.forEach((track, index) => {
      assert.ok(track.audioPath, `imported ${trackCount} tracks[${index}].audioPath missing`);
      assert.ok(fs.existsSync(track.audioPath), `imported ${trackCount} tracks[${index}].audioPath missing on disk`);
    });
  }
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
  assert.equal(built.spec.releaseId, albumId);
  assert.equal(built.spec.recordingSetup.tabs[0].url, 'http://localhost:3737/releases/album/{releaseId}');
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
    assert.match(html, /releaseId/);
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
