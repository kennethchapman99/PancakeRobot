/**
 * Social asset manifest — tracks generated/uploaded visual assets per song.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');

export const SOCIAL_FORMATS = [
  'youtube_landscape',
  'spotify_square',
  'apple_music_square',
  'ig_feed_1080x1350',
  'ig_square_1080x1080',
  'ig_reel_cover',
  'ig_story',
  'tiktok_cover',
  'ig_reel_hook',
  'ig_reel_lyrics',
  'ig_reel_character',
  'ig_story_new_song',
  'tiktok_hook',
  'tiktok_lyric',
  'tiktok_loop',
];

export function getSocialAssetsDir(songId) {
  return path.join(REPO_ROOT, 'output/songs', songId, 'social-assets');
}

export function getGeneratedDir(songId) {
  return path.join(getSocialAssetsDir(songId), 'generated');
}

export function getManifestPath(songId) {
  return path.join(getSocialAssetsDir(songId), 'visual-manifest.json');
}

export function getReferenceDir(songId) {
  return path.join(REPO_ROOT, 'output/songs', songId, 'reference');
}

export function loadManifest(songId) {
  const p = getManifestPath(songId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function saveManifest(songId, manifest) {
  const dir = getSocialAssetsDir(songId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getManifestPath(songId), JSON.stringify(manifest, null, 2));
}

export function createManifest(songId, options = {}) {
  return {
    song_id: songId,
    provider: options.provider || 'openai',
    model: options.model || null,
    generated_at: new Date().toISOString(),
    source_references: options.source_references || [],
    requested_formats: options.requested_formats || SOCIAL_FORMATS,
    base_image: {
      source: options.base_image_source || 'none',
      path: options.base_image_path || null,
      active: options.base_image_active !== false,
    },
    assets: (options.requested_formats || SOCIAL_FORMATS).map(format => ({
      format,
      status: 'pending',
      approved: false,
      path: null,
      generated_at: null,
      error: null,
    })),
  };
}

export function updateManifestAsset(manifest, format, update) {
  const asset = manifest.assets.find(a => a.format === format);
  if (asset) Object.assign(asset, update);
  return manifest;
}
