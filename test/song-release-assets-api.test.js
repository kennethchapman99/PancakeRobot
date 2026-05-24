import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createAlbum, upsertSong } from '../src/shared/db.js';
import { app } from '../src/web/server.js';
import {
  getSongBaseImageDir,
  scanSongBaseImage,
} from '../src/shared/song-catalog-marketing.js';
import {
  getSongMarketingKit,
  saveSongMarketingKit,
} from '../src/shared/song-marketing-kit.js';
import {
  setSongReleaseAssetsServiceHooks,
} from '../src/shared/song-release-assets-service.js';
import { cleanupTestOutputArtifacts } from '../src/shared/test-db-artifacts.js';

const EXPECTED_FORMATS = [
  'spotify-cover-3000x3000.png',
  'youtube-thumbnail-1280x720.png',
  'instagram-square-1080x1080.png',
  'instagram-vertical-1080x1920.png',
  'facebook-post-1200x630.png',
];

function fixtureImageBuffer() {
  return fs.readFileSync(path.join(process.cwd(), 'base images', 'base_image1.png'));
}

function uniqueSongId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function startServer() {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

function writeMetadata(songId) {
  const outputDir = path.join(process.cwd(), 'output', 'marketing-ready', songId);
  fs.mkdirSync(outputDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const generated_assets = EXPECTED_FORMATS.map(format => ({
    name: format,
    path: `output/marketing-ready/${songId}/${format}`,
  }));
  fs.writeFileSync(path.join(outputDir, 'metadata.json'), JSON.stringify({
    song_id: songId,
    generated_at: generatedAt,
    generated_assets,
    qa_warnings: [],
    qa_failures: [],
    dashboard_url: `/media/marketing-ready/${songId}/index.html`,
  }, null, 2));
}

test('POST /api/songs/:id/base-image/clear returns JSON and never redirects', async t => {
  const songId = uniqueSongId('API_CLEAR_BASE');
  t.after(() => cleanupTestOutputArtifacts({ songIds: [songId] }));
  upsertSong({ id: songId, title: 'API Clear Base Image', is_test: true });

  const refDir = getSongBaseImageDir(songId);
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(path.join(refDir, 'base-image.png'), 'fake-image');
  saveSongMarketingKit(songId, {
    marketing_assets: {
      base_image_url: scanSongBaseImage(songId)?.url || '',
      generation_source: 'release_base_image',
    },
  });

  const server = await startServer();
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/songs/${songId}/base-image/clear`, {
    method: 'POST',
    redirect: 'manual',
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/i);
  assert.equal(body.ok, true);
  assert.equal(body.songId, songId);
  assert.equal(scanSongBaseImage(songId), null);
  assert.equal(getSongMarketingKit(songId).marketing_assets.base_image_url, '');
});

test('POST /api/songs/:id/base-image accepts PNG uploads and rejects unsupported files', async t => {
  const songId = uniqueSongId('API_UPLOAD_BASE');
  t.after(() => cleanupTestOutputArtifacts({ songIds: [songId] }));
  upsertSong({ id: songId, title: 'API Upload Base Image', is_test: true });

  const server = await startServer();
  t.after(() => server.close());

  const badForm = new FormData();
  badForm.append('base_image', new Blob(['not image'], { type: 'text/plain' }), 'bad.txt');
  const badRes = await fetch(`http://127.0.0.1:${server.address().port}/api/songs/${songId}/base-image`, {
    method: 'POST',
    body: badForm,
  });
  assert.equal(badRes.status, 400);

  const form = new FormData();
  form.append('base_image', new Blob([fixtureImageBuffer()], { type: 'image/png' }), 'cover.png');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/songs/${songId}/base-image`, {
    method: 'POST',
    body: form,
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(scanSongBaseImage(songId)?.name, 'base-image.png');
  assert.match(getSongMarketingKit(songId).marketing_assets.base_image_url, /base-image\.png$/);
});

test('POST /api/songs/:id/release-assets/generate-image fails gracefully without OpenAI key', async t => {
  const songId = uniqueSongId('API_OPENAI_MISSING');
  t.after(() => cleanupTestOutputArtifacts({ songIds: [songId] }));
  upsertSong({ id: songId, title: 'API OpenAI Missing Key', is_test: true });
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  });

  const server = await startServer();
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/songs/${songId}/release-assets/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'bright robot album art' }),
  });
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'missing_openai_key');
});

test('POST /api/songs/:id/release-assets/build returns JSON and populates the expected platform asset URL fields', async t => {
  const songId = uniqueSongId('API_BUILD_RELEASE');
  t.after(() => cleanupTestOutputArtifacts({ songIds: [songId] }));
  upsertSong({ id: songId, title: 'API Build Release Assets', is_test: true });

  setSongReleaseAssetsServiceHooks({
    async buildMarketingReleasePack(targetSongId) {
      writeMetadata(targetSongId);
      return {
        ok: true,
        songId: targetSongId,
        dashboardUrl: `/media/marketing-ready/${targetSongId}/index.html`,
        qaReport: { warnings: [], failures: [] },
        marketingKitSyncError: null,
      };
    },
  });
  t.after(() => setSongReleaseAssetsServiceHooks({}));

  const server = await startServer();
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/songs/${songId}/release-assets/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formats: EXPECTED_FORMATS }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/i);
  assert.equal(body.ok, true);
  for (const field of [
    'square_post_url',
    'vertical_post_url',
    'outreach_banner_url',
    'cover_safe_promo_url',
    'no_text_variation_url',
  ]) {
    assert.ok(body.marketingAssets[field], `expected ${field} to be populated`);
  }
});

test('album asset endpoints upload primary image, generate derivatives, and expose download route', async t => {
  const albumId = createAlbum({
    id: uniqueSongId('ALBUM_ASSET_API'),
    brand_profile_id: 'pancake_robot',
    album_title: 'Album Asset API',
    number_of_songs: 1,
    status: 'complete',
    is_test: true,
  });
  t.after(() => cleanupTestOutputArtifacts({ albumIds: [albumId] }));

  const server = await startServer();
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const form = new FormData();
  form.append('base_image', new Blob([fixtureImageBuffer()], { type: 'image/png' }), 'album.png');
  const uploadRes = await fetch(`${baseUrl}/api/albums/${albumId}/primary-image`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
  });
  assert.equal(uploadRes.status, 200);

  const buildRes = await fetch(`${baseUrl}/api/albums/${albumId}/release-assets/build`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  const buildBody = await buildRes.json();
  assert.equal(buildRes.status, 200);
  assert.equal(buildBody.ok, true);
  assert.equal(buildBody.albumAssets.assets.length, 5);
  assert.deepEqual(
    buildBody.albumAssets.assets.map(asset => asset.dimensions),
    [
      { width: 3000, height: 3000 },
      { width: 1280, height: 720 },
      { width: 1080, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 1200, height: 630 },
    ]
  );

  const downloadRes = await fetch(`${baseUrl}/api/albums/${albumId}/release-assets/download`);
  assert.equal(downloadRes.status, 200);
  assert.match(downloadRes.headers.get('content-type') || '', /zip|octet-stream/i);
});

test('album preview automatically builds current derivatives after primary image upload', async t => {
  const albumId = createAlbum({
    id: uniqueSongId('ALBUM_PREVIEW_AUTO'),
    brand_profile_id: 'pancake_robot',
    album_title: 'Album Preview Auto',
    number_of_songs: 1,
    status: 'complete',
    is_test: true,
  });
  t.after(() => cleanupTestOutputArtifacts({ albumIds: [albumId] }));

  const server = await startServer();
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const form = new FormData();
  form.append('base_image', new Blob([fixtureImageBuffer()], { type: 'image/png' }), 'album.png');
  const uploadRes = await fetch(`${baseUrl}/api/albums/${albumId}/primary-image`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
  });
  assert.equal(uploadRes.status, 200);

  const stateBefore = await (await fetch(`${baseUrl}/api/albums/${albumId}/release-assets/state`)).json();
  assert.equal(stateBefore.albumAssets.derivativesStale, true);

  const previewRes = await fetch(`${baseUrl}/api/albums/${albumId}/release-assets/preview`, { redirect: 'manual' });
  assert.equal(previewRes.status, 302);
  assert.match(previewRes.headers.get('location') || '', /\/media\/albums\/.*\/assets\/index\.html/);

  const stateAfter = await (await fetch(`${baseUrl}/api/albums/${albumId}/release-assets/state`)).json();
  assert.equal(stateAfter.albumAssets.derivativesStale, false);
  assert.equal(stateAfter.albumAssets.assets.length, 5);
  assert.equal(stateAfter.albumAssets.metadata.primary_image_fingerprint, stateAfter.albumAssets.primaryImageFingerprint);
});

test('album OpenAI image endpoint fails gracefully without OpenAI key', async t => {
  const albumId = createAlbum({
    id: uniqueSongId('ALBUM_OPENAI_MISSING'),
    album_title: 'Album OpenAI Missing',
    number_of_songs: 1,
    status: 'complete',
    is_test: true,
  });
  t.after(() => cleanupTestOutputArtifacts({ albumIds: [albumId] }));
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  });

  const server = await startServer();
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/albums/${albumId}/release-assets/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'bright robot album cover' }),
  });
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'missing_openai_key');
});

test('POST /api/songs/:id/status queues release asset generation automatically when marked submitted to DistroKid', async t => {
  const songId = uniqueSongId('API_STATUS_AUTO_BUILD');
  t.after(() => cleanupTestOutputArtifacts({ songIds: [songId] }));
  upsertSong({ id: songId, title: 'API Status Auto Build', is_test: true });

  setSongReleaseAssetsServiceHooks({
    async buildMarketingReleasePack(targetSongId) {
      writeMetadata(targetSongId);
      return {
        ok: true,
        songId: targetSongId,
        dashboardUrl: `/media/marketing-ready/${targetSongId}/index.html`,
        qaReport: { warnings: [], failures: [] },
        marketingKitSyncError: null,
      };
    },
  });
  t.after(() => setSongReleaseAssetsServiceHooks({}));

  const server = await startServer();
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/songs/${songId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'submitted to DistroKid' }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.releaseAssetsBuild?.jobId, 'string');

  await new Promise(resolve => setTimeout(resolve, 50));

  const stateRes = await fetch(`http://127.0.0.1:${server.address().port}/api/songs/${songId}/release-assets/state`);
  const stateBody = await stateRes.json();
  assert.equal(stateRes.status, 200);
  assert.ok(stateBody.marketingAssets.square_post_url);
  assert.ok(stateBody.marketingAssets.no_text_variation_url);
});
