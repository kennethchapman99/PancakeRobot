import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  createVisualLibraryAsset,
  getAlbum,
  getSong,
  listVisualLibraryAssets,
  recordVisualLibraryUsage,
} from './db.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VISUAL_LIBRARY_ROOT = path.join(REPO_ROOT, 'output', 'visual-library');
const CATEGORY_DIRS = Object.freeze({
  mp4: 'videos',
  mov: 'videos',
  webm: 'videos',
  gif: 'gifs',
  png: 'images',
  jpg: 'images',
  jpeg: 'images',
  webp: 'images',
  thumbnail: 'thumbnails',
});

export function ensureVisualLibrary() {
  for (const dir of ['videos', 'gifs', 'images', 'thumbnails']) {
    fs.mkdirSync(path.join(VISUAL_LIBRARY_ROOT, dir), { recursive: true });
  }
  syncVisualLibraryManifest();
  return VISUAL_LIBRARY_ROOT;
}

export function importVisualLibraryAsset({
  sourcePath,
  tags = [],
  assetType = null,
  aspectRatio = null,
  durationSeconds = null,
  source = 'manual',
  rightsStatus = 'owned_generated',
  metadata = {},
} = {}) {
  const cleanSource = path.resolve(String(sourcePath || ''));
  if (!cleanSource || !fs.existsSync(cleanSource)) throw new Error(`Visual asset not found: ${sourcePath}`);
  ensureVisualLibrary();
  const ext = path.extname(cleanSource).slice(1).toLowerCase();
  const detectedType = assetType || detectAssetType(ext);
  const category = CATEGORY_DIRS[ext] || (detectedType === 'gif' ? 'gifs' : detectedType === 'mp4' ? 'videos' : 'images');
  const basename = path.basename(cleanSource);
  const destName = `${Date.now().toString(36)}-${basename.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const destPath = path.join(VISUAL_LIBRARY_ROOT, category, destName);
  fs.copyFileSync(cleanSource, destPath);
  const normalizedTags = normalizeTags(tags);
  const asset = createVisualLibraryAsset({
    file_path: path.relative(REPO_ROOT, destPath),
    asset_type: detectedType,
    aspect_ratio: aspectRatio,
    duration_seconds: durationSeconds,
    album_tags: normalizedTags,
    song_tags: normalizedTags,
    mood_tags: normalizedTags,
    source,
    rights_status: rightsStatus,
    metadata: {
      original_path: cleanSource,
      imported_filename: basename,
      ...metadata,
    },
  });
  syncVisualLibraryManifest();
  return asset;
}

export function recommendVisualAssets({ releaseType, releaseId, songId = null, platform = null, usageContext = null, limit = 5 } = {}) {
  const release = resolveReleaseEntity(releaseType, releaseId, songId);
  const releaseTags = buildReleaseTags(release);
  const scored = listVisualLibraryAssets().map(asset => ({
    asset,
    score: scoreAsset(asset, releaseTags, { platform, usageContext }),
  }));
  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.asset.created_at).localeCompare(String(a.asset.created_at)))
    .slice(0, Math.max(1, Number(limit) || 5))
    .map(item => ({
      ...item.asset,
      score: item.score,
      recommended_for: { releaseType, releaseId, songId, platform, usageContext },
    }));
}

export function selectReusableAssetOrSuggestCustomVideo({ releaseType, releaseId, songId = null, platform = null, usageContext = null } = {}) {
  const recommendations = recommendVisualAssets({ releaseType, releaseId, songId, platform, usageContext, limit: 1 });
  if (recommendations.length) {
    return {
      mode: 'reusable_asset',
      asset: recommendations[0],
      needsKenTask: null,
    };
  }
  return {
    mode: 'needs_custom_video_decision',
    asset: null,
    needsKenTask: {
      task_key: 'request_custom_video',
      title: 'Request custom video',
      reason: 'No good reusable visual asset matched this release campaign.',
      suggested_action: 'Decide whether to request custom video generation.',
      owner: 'ken',
      status: 'needs_ken',
      blocking: false,
    },
  };
}

export function noteVisualAssetUsage({ assetId, releaseType, releaseId, songId = null, platform = null, usageContext = null } = {}) {
  return recordVisualLibraryUsage({
    asset_id: assetId,
    release_type: releaseType,
    release_id: releaseId,
    song_id: songId,
    platform,
    usage_context: usageContext,
  });
}

export function syncVisualLibraryManifest() {
  ensureLibraryDirsOnly();
  const manifestPath = path.join(VISUAL_LIBRARY_ROOT, 'manifest.json');
  const assets = listVisualLibraryAssets();
  fs.writeFileSync(manifestPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    asset_count: assets.length,
    assets,
  }, null, 2));
  return manifestPath;
}

function ensureLibraryDirsOnly() {
  for (const dir of ['videos', 'gifs', 'images', 'thumbnails']) {
    fs.mkdirSync(path.join(VISUAL_LIBRARY_ROOT, dir), { recursive: true });
  }
}

function detectAssetType(ext) {
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'mp4';
  if (ext === 'gif') return 'gif';
  return 'image';
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(values.map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean))];
}

function resolveReleaseEntity(releaseType, releaseId, songId) {
  if (String(releaseType || '').toLowerCase() === 'album') {
    const album = getAlbum(releaseId);
    if (!album) throw new Error(`Album not found: ${releaseId}`);
    return { type: 'album', album, song: songId ? getSong(songId) : null };
  }
  const song = getSong(songId || releaseId);
  if (!song) throw new Error(`Song not found: ${songId || releaseId}`);
  return { type: 'single', song, album: song.album_id ? getAlbum(song.album_id) : null };
}

function buildReleaseTags(release) {
  const raw = [
    release.album?.album_title,
    release.album?.album_theme,
    release.song?.title,
    release.song?.topic,
    ...(release.song?.keywords || []),
    ...(release.song?.mood_tags || []),
  ];
  return new Set(normalizeTags(raw));
}

function scoreAsset(asset, releaseTags, { platform, usageContext }) {
  let score = 0;
  const candidateTags = new Set([
    ...normalizeTags(asset.album_tags),
    ...normalizeTags(asset.song_tags),
    ...normalizeTags(asset.mood_tags),
    ...normalizeTags(asset.scene_tags),
  ]);
  for (const tag of releaseTags) {
    if (candidateTags.has(tag)) score += 10;
  }
  if (platform === 'youtube' && asset.aspect_ratio === '16x9') score += 4;
  if (['instagram', 'facebook'].includes(String(platform || '').toLowerCase()) && ['1x1', '9x16'].includes(asset.aspect_ratio)) score += 4;
  if (usageContext && candidateTags.has(String(usageContext).toLowerCase())) score += 3;
  if (asset.safe_for_kids) score += 2;
  return score;
}
