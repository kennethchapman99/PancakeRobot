import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createAlbum, upsertSong } from '../src/shared/db.js';
import { scanSongBaseImage, getSongBaseImageDir } from '../src/shared/song-catalog-marketing.js';
import { getSongMarketingKit, saveSongMarketingKit } from '../src/shared/song-marketing-kit.js';
import {
  buildSongReleaseAssets,
  clearSongBaseImage,
  ensureReleaseAssetDerivatives,
  getReleaseAssetOwner,
  getReleaseAssetState,
  setPrimaryImage,
} from '../src/shared/song-release-assets-service.js';
import { getImageProvider } from '../src/visuals/image-provider.js';
import { cleanupTestOutputArtifacts } from '../src/shared/test-db-artifacts.js';

function uniqueSongId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function writeBaseImage(songId, ext = 'png') {
  const refDir = getSongBaseImageDir(songId);
  fs.mkdirSync(refDir, { recursive: true });
  const filePath = path.join(refDir, `base-image.${ext}`);
  fs.writeFileSync(filePath, 'fake-image');
  return filePath;
}

function fixtureImagePath(name = 'base_image1.png') {
  return path.join(process.cwd(), 'base images', name);
}

test('clearSongBaseImage deletes disk files and clears release-base-image state', t => {
  const songId = uniqueSongId('CLEAR_BASE_IMAGE');
  t.after(() => cleanupTestOutputArtifacts({ songIds: [songId] }));
  upsertSong({ id: songId, title: 'Clear Base Image Test', is_test: true });

  const first = writeBaseImage(songId, 'png');
  const second = writeBaseImage(songId, 'webp');
  saveSongMarketingKit(songId, {
    marketing_assets: {
      base_image_url: scanSongBaseImage(songId)?.url || '',
      generation_source: 'release_base_image',
      square_post_url: '/media/old-square.png',
      vertical_post_url: '/media/old-vertical.jpg',
      portrait_post_url: '/media/old-portrait.png',
      outreach_banner_url: '/media/old-banner.png',
      cover_safe_promo_url: '/media/old-cover.jpg',
      no_text_variation_url: '/media/old-notext.png',
      generated_at: new Date().toISOString(),
    },
  });

  const result = clearSongBaseImage(songId);
  const refreshedKit = getSongMarketingKit(songId);

  assert.equal(result.ok, true);
  assert.deepEqual(new Set(result.deletedFiles), new Set([first, second]));
  assert.equal(scanSongBaseImage(songId), null);
  assert.equal(refreshedKit.marketing_assets.base_image_url, '');
  assert.equal(refreshedKit.marketing_assets.square_post_url, '');
  assert.equal(refreshedKit.marketing_assets.vertical_post_url, '');
  assert.notEqual(refreshedKit.image_source.generation_source, 'release_base_image');
  assert.equal(refreshedKit.image_source.generation_source, 'default_base_image_pool');
  assert.match(refreshedKit.image_source.source_label, /Default base image/i);
  assert.match(result.warning, /Now using: Default base image library/i);
});

test('Cloudflare image provider is hidden from the canonical image path unless legacy flag is set', () => {
  const oldProvider = process.env.MARKETING_IMAGE_PROVIDER;
  const oldFlag = process.env.PANCAKE_ENABLE_LEGACY_CLOUDFLARE_IMAGE;
  process.env.MARKETING_IMAGE_PROVIDER = 'cloudflare';
  delete process.env.PANCAKE_ENABLE_LEGACY_CLOUDFLARE_IMAGE;
  try {
    assert.throws(() => getImageProvider(), /Unknown image provider: cloudflare/);
  } finally {
    if (oldProvider === undefined) delete process.env.MARKETING_IMAGE_PROVIDER;
    else process.env.MARKETING_IMAGE_PROVIDER = oldProvider;
    if (oldFlag === undefined) delete process.env.PANCAKE_ENABLE_LEGACY_CLOUDFLARE_IMAGE;
    else process.env.PANCAKE_ENABLE_LEGACY_CLOUDFLARE_IMAGE = oldFlag;
  }
});

test('standalone song uses canonical release asset derivatives and refreshes when primary image changes', async t => {
  const songId = uniqueSongId('SONG_CANONICAL_ASSETS');
  t.after(() => cleanupTestOutputArtifacts({ songIds: [songId] }));
  upsertSong({ id: songId, title: 'Canonical Song Assets', is_test: true });

  setPrimaryImage('song', songId, fixtureImagePath('base_image1.png'));
  const first = await ensureReleaseAssetDerivatives('song', songId);
  assert.equal(first.assets.length, 5);
  assert.equal(first.derivativesStale, false);
  assert.ok(first.dashboardUrl);

  const firstFingerprint = first.primaryImageFingerprint;
  setPrimaryImage('song', songId, fixtureImagePath('base_image2.png'));
  const stale = getReleaseAssetState('song', songId);
  assert.equal(stale.derivativesStale, true);
  assert.notEqual(stale.primaryImageFingerprint, firstFingerprint);

  const rebuilt = await buildSongReleaseAssets(songId);
  assert.equal(rebuilt.ok, true);
  const current = getReleaseAssetState('song', songId);
  assert.equal(current.derivativesStale, false);
  assert.equal(current.metadata.primary_image_fingerprint, current.primaryImageFingerprint);
});

test('album track inherits album release assets and blocks song-level primary image edits', async t => {
  const albumId = createAlbum({
    id: uniqueSongId('ALBUM_INHERIT_ASSETS'),
    album_title: 'Inherited Asset Album',
    number_of_songs: 1,
    status: 'complete',
    is_test: true,
  });
  const songId = uniqueSongId('SONG_ALBUM_TRACK');
  t.after(() => cleanupTestOutputArtifacts({ songIds: [songId], albumIds: [albumId] }));
  upsertSong({ id: songId, title: 'Album Track', album_id: albumId, track_number: 1, is_test: true });

  setPrimaryImage('album', albumId, fixtureImagePath('base_image1.png'));
  await ensureReleaseAssetDerivatives('song', songId);

  const owner = getReleaseAssetOwner('song', songId);
  assert.equal(owner.type, 'album');
  assert.equal(owner.id, albumId);

  const state = getReleaseAssetState('song', songId);
  assert.equal(state.inheritedFrom.id, albumId);
  assert.equal(state.assets.length, 5);
  assert.equal(state.derivativesStale, false);
  assert.throws(() => setPrimaryImage('song', songId, fixtureImagePath('base_image2.png')), /inherits release assets from album/i);

  setPrimaryImage('album', albumId, fixtureImagePath('base_image2.png'));
  const staleInherited = getReleaseAssetState('song', songId);
  assert.equal(staleInherited.derivativesStale, true);
});
