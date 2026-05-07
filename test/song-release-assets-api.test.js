import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { upsertSong } from '../src/shared/db.js';
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

const EXPECTED_FORMATS = [
  'ig-square-post-1080x1080.png',
  'ig-feed-announcement-1080x1350.png',
  'tiktok-cover.jpg',
  'outreach-hero-1600x900.png',
  'ig-reel-cover.jpg',
  'no-text-variation.png',
];

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
  upsertSong({ id: songId, title: 'API Clear Base Image' });

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

test('POST /api/songs/:id/release-assets/build returns JSON and populates the six expected marketing asset URL fields', async t => {
  const songId = uniqueSongId('API_BUILD_RELEASE');
  upsertSong({ id: songId, title: 'API Build Release Assets' });

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
    'portrait_post_url',
    'outreach_banner_url',
    'cover_safe_promo_url',
    'no_text_variation_url',
  ]) {
    assert.ok(body.marketingAssets[field], `expected ${field} to be populated`);
  }
});

test('POST /api/songs/:id/status queues release asset generation automatically when marked submitted to DistroKid', async t => {
  const songId = uniqueSongId('API_STATUS_AUTO_BUILD');
  upsertSong({ id: songId, title: 'API Status Auto Build' });

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
