import fs from 'fs';
import path from 'path';
import assert from 'assert/strict';
import { createAlbum, upsertSong } from '../shared/db.js';
import { selectSongPrimaryImage, buildSongReleaseAssets, DEFAULT_RELEASE_ASSET_FORMATS } from '../shared/song-release-assets-service.js';
import { buildReleaseDerivatives } from '../shared/release-asset-derivatives.js';

const ROOT = process.cwd();
const fixture = path.join(ROOT, 'base images', 'base_image1.png');

function pngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, `${filePath} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const songId = `SMOKE_RELEASE_ASSETS_${suffix}`;
upsertSong({ id: songId, title: 'Release Asset Smoke Test', topic: 'release asset smoke test', status: 'draft' });
selectSongPrimaryImage(songId, fixture, { generationSource: 'smoke_fixture' });
const songPack = await buildSongReleaseAssets(songId, {
  formats: DEFAULT_RELEASE_ASSET_FORMATS,
  renderVideos: false,
});
assert.equal(songPack.ok, true);

const expectedSongFiles = [
  ['spotify-cover-3000x3000.png', { width: 3000, height: 3000 }],
  ['youtube-thumbnail-1280x720.png', { width: 1280, height: 720 }],
  ['instagram/instagram-square-1080x1080.png', { width: 1080, height: 1080 }],
  ['instagram/instagram-vertical-1080x1920.png', { width: 1080, height: 1920 }],
  ['facebook-post-1200x630.png', { width: 1200, height: 630 }],
];
for (const [rel, dims] of expectedSongFiles) {
  assert.deepEqual(pngDimensions(path.join(ROOT, 'output', 'marketing-ready', songId, rel)), dims);
}

const albumId = createAlbum({
  id: `ALBUM_SMOKE_RELEASE_ASSETS_${suffix}`,
  album_title: 'Release Asset Smoke Album',
  number_of_songs: 1,
  status: 'complete',
});
const albumDir = path.join(ROOT, 'output', 'albums', albumId);
const albumRefDir = path.join(albumDir, 'reference');
fs.mkdirSync(albumRefDir, { recursive: true });
const albumPrimary = path.join(albumRefDir, 'primary-image.png');
fs.copyFileSync(fixture, albumPrimary);
await buildReleaseDerivatives({
  entityType: 'album',
  entityId: albumId,
  title: 'Release Asset Smoke Album',
  artist: 'Pancake Robot',
  sourceImagePath: albumPrimary,
  outputDir: path.join(albumDir, 'assets'),
});
for (const [rel, dims] of expectedSongFiles) {
  assert.deepEqual(pngDimensions(path.join(albumDir, 'assets', rel)), dims);
}

console.log(JSON.stringify({
  ok: true,
  songId,
  albumId,
  songPreview: `/media/marketing-ready/${songId}/index.html`,
  albumPreview: `/media/albums/${albumId}/assets/index.html`,
}, null, 2));
