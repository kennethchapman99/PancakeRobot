import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeReleaseAssetManifest,
  normalizeSocialHandle,
  resolveCanonicalSocialHandle,
} from './release-asset-manifest.js';

test('resolveCanonicalSocialHandle prefers release overrides and normalizes legacy handle', () => {
  const brandProfile = {
    social: {
      instagram_url: 'https://instagram.com/pancakerobotmusic',
      tiktok_url: 'https://tiktok.com/@pancakerobotmusic',
    },
  };

  assert.equal(
    resolveCanonicalSocialHandle({
      brandProfile,
      marketingLinks: { instagram_url: 'https://instagram.com/pancakerobot' },
    }),
    '@pancakerobotmusic'
  );

  assert.equal(
    resolveCanonicalSocialHandle({
      brandProfile,
      socialHandle: '@releaseoverride',
      marketingLinks: { instagram_url: 'https://instagram.com/pancakerobotmusic' },
    }),
    '@releaseoverride'
  );
});

test('normalizeReleaseAssetManifest upgrades legacy metadata into canonical manifest fields', () => {
  const manifest = normalizeReleaseAssetManifest('SONG_TEST', {
    song_id: 'SONG_TEST',
    release_id: 'REL_TEST',
    title: 'Test Song',
    artist: 'Pancake Robot',
    handle: '@pancakerobot',
    generated_at: '2026-05-06T12:00:00.000Z',
    dashboard_url: '/media/marketing-ready/SONG_TEST/index.html',
    generated_assets: [
      {
        id: 'square_asset',
        type: 'square_cover',
        name: 'ig-square-post-1080x1080.png',
        path: 'output/marketing-ready/SONG_TEST/instagram/ig-square-post-1080x1080.png',
      },
    ],
  });

  assert.equal(manifest.songId, 'SONG_TEST');
  assert.equal(manifest.releaseId, 'REL_TEST');
  assert.equal(manifest.socialHandle, '@pancakerobotmusic');
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].publicUrl, '/media/marketing-ready/SONG_TEST/instagram/ig-square-post-1080x1080.png');
  assert.equal(manifest.assets[0].kind, 'image');
  assert.deepEqual(manifest.assets[0].dimensions, { width: 1080, height: 1080 });
});

test('normalizeSocialHandle falls back to canonical brand handle', () => {
  assert.equal(normalizeSocialHandle(''), '@pancakerobotmusic');
  assert.equal(normalizeSocialHandle('@pancakerobot'), '@pancakerobotmusic');
});

