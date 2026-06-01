import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// This suite requires better-sqlite3 (via db.js) and canvas (via song-release-assets-service.js →
// image-provider.js).  Both are native modules that must be compiled for the running Node.js
// version.  When tests are executed with the system node instead of the project-pinned v22.22.2
// the modules were compiled for a different NODE_MODULE_VERSION and dlopen fails.  Guard every
// test so the suite degrades to "skipped" rather than crashing the entire run.
const require = createRequire(import.meta.url);
let nativeSkipReason = false;
for (const mod of ['better-sqlite3', 'canvas']) {
  try {
    require(mod);
  } catch (err) {
    nativeSkipReason = `native module '${mod}' unavailable in this Node runtime: ${err.message.split('\n')[0]}`;
    break;
  }
}

// Dynamic imports so the file loads even when native modules are missing
let upsertSong, createAlbum;
let scanSongBaseImage, getSongBaseImageDir;
let getSongMarketingKit, saveSongMarketingKit;
let buildSongReleaseAssets, clearSongBaseImage, ensureReleaseAssetDerivatives, getReleaseAssetOwner, getReleaseAssetState, setPrimaryImage;
let getImageProvider;
let cleanupTestOutputArtifacts;

if (!nativeSkipReason) {
  ({ upsertSong, createAlbum } = await import('../src/shared/db.js'));
  ({ scanSongBaseImage, getSongBaseImageDir } = await import('../src/shared/song-catalog-marketing.js'));
  ({ getSongMarketingKit, saveSongMarketingKit } = await import('../src/shared/song-marketing-kit.js'));
  ({ buildSongReleaseAssets, clearSongBaseImage, ensureReleaseAssetDerivatives, getReleaseAssetOwner, getReleaseAssetState, setPrimaryImage } = await import('../src/shared/song-release-assets-service.js'));
  ({ getImageProvider } = await import('../src/visuals/image-provider.js'));
  ({ cleanupTestOutputArtifacts } = await import('../src/shared/test-db-artifacts.js'));
}

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

test('clearSongBaseImage deletes disk files and clears release-base-image state', { skip: nativeSkipReason }, t => {
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
  assert.equal(refreshedKit.image_source.generation_source, 'brand_default_image');
  assert.equal(refreshedKit.image_source.source_label, 'Brand default image');
  assert.equal(result.warning, 'Release-specific base image cleared. Now using: Brand default image.');
});

test('Cloudflare image provider is hidden from the canonical image path unless legacy flag is set', { skip: nativeSkipReason }, () => {
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

test('standalone song uses canonical release asset derivatives and refreshes when primary image changes', { skip: nativeSkipReason }, async t => {
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

test('album track inherits album release assets and blocks song-level primary image edits', { skip: nativeSkipReason }, async t => {
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
