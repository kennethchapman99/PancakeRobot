import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { upsertSong } from '../src/shared/db.js';
import { scanSongBaseImage, getSongBaseImageDir } from '../src/shared/song-catalog-marketing.js';
import { getSongMarketingKit, saveSongMarketingKit } from '../src/shared/song-marketing-kit.js';
import { clearSongBaseImage } from '../src/shared/song-release-assets-service.js';

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

test('clearSongBaseImage deletes disk files and clears release-base-image state', () => {
  const songId = uniqueSongId('CLEAR_BASE_IMAGE');
  upsertSong({ id: songId, title: 'Clear Base Image Test' });

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
