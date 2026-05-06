import fs from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { getReleaseLinks } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
const OUTPUT_DIR = join(ROOT_DIR, 'output');
const DEFAULT_BASE_IMAGES_DIR = join(ROOT_DIR, 'base images');

function toMediaUrl(absPath) {
  return '/media/' + absPath.replace(OUTPUT_DIR, '').replace(/\\/g, '/').replace(/^\//, '');
}

function exists(path) {
  return Boolean(path) && fs.existsSync(path);
}

function tryReadJson(path) {
  try {
    return exists(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}

function listFiles(dir, matcher) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .filter(matcher)
    .map(name => {
      const path = join(dir, name);
      return {
        name,
        path,
        relative_path: relative(ROOT_DIR, path),
        url: toMediaUrl(path),
      };
    });
}

function filterVisibleThumbnailFiles(files) {
  const finals = new Set(
    files
      .filter(file => file.name.endsWith('-final.png'))
      .map(file => file.name.replace(/-final\.png$/, ''))
  );

  return files.filter(file => {
    if (!file.name.endsWith('-base.png')) return true;
    const stem = file.name.replace(/-base\.png$/, '');
    return !finals.has(stem);
  });
}

function relativeOutputPathToUrl(relativePath) {
  if (!relativePath) return null;
  const normalized = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.startsWith('output/')) return `/media/${normalized.slice('output/'.length)}`;
  return `/${normalized}`;
}

export function scanSongBaseImage(songId) {
  const refDir = join(OUTPUT_DIR, 'songs', songId, 'reference');
  const files = listFiles(refDir, name => name.startsWith('base-image'));
  return files[0] ? { ...files[0], songId } : null;
}

export function resolveDefaultBaseImage(songId) {
  if (!exists(DEFAULT_BASE_IMAGES_DIR)) return null;

  const files = fs.readdirSync(DEFAULT_BASE_IMAGES_DIR)
    .filter(name => /\.(png|jpe?g|webp)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  if (!files.length) return null;

  const key = String(songId || '');
  const index = stableIndexForKey(key, files.length);
  const name = files[index];
  const assetPath = join(DEFAULT_BASE_IMAGES_DIR, name);

  return {
    name,
    path: assetPath,
    url: `/base-images/${encodeURIComponent(name)}`,
    relative_path: relative(ROOT_DIR, assetPath),
  };
}

export function scanMarketingPack(songId) {
  const packDir = join(OUTPUT_DIR, 'marketing-ready', songId);
  const metaPath = join(packDir, 'metadata.json');
  const dashboardPath = join(packDir, 'index.html');
  const meta = tryReadJson(metaPath);
  const songDir = join(OUTPUT_DIR, 'songs', songId);
  const distDir = join(OUTPUT_DIR, 'distribution-ready', songId);
  const songMeta = tryReadJson(join(songDir, 'metadata.json'));
  const releaseLinks = getReleaseLinks(songId);
  const hasAudio = exists(join(distDir, 'upload-this.mp3')) || exists(join(songDir, 'audio.mp3'));
  const hasCover = exists(distDir) && fs.readdirSync(distDir).some(name => /\.(png|jpe?g)$/i.test(name));
  const hasCharacter = Boolean(process.env.MARKETING_CHARACTER_ASSET && exists(process.env.MARKETING_CHARACTER_ASSET));
  const baseImage = scanSongBaseImage(songId);
  const hasLink = Boolean(releaseLinks.length || songMeta?.hyperfollow_url || songMeta?.streaming_link);

  return {
    exists: exists(packDir),
    status: meta ? 'built' : 'not_built',
    dashboardUrl: exists(dashboardPath) ? `/media/marketing-ready/${songId}/index.html` : null,
    readiness: {
      finalAudio: hasAudio,
      coverArt: hasCover,
      characterAsset: hasCharacter,
      baseImagePresent: Boolean(baseImage),
      linkPresent: hasLink,
    },
    meta,
  };
}

export function getSongCatalogMarketingSummary(songId, options = {}) {
  const releaseLinks = options.releaseLinks || getReleaseLinks(songId);
  const songDir = join(OUTPUT_DIR, 'songs', songId);
  const baseImage = scanSongBaseImage(songId);
  const marketingPack = scanMarketingPack(songId);
  const generatedAssets = Array.isArray(marketingPack.meta?.generated_assets) ? marketingPack.meta.generated_assets : [];

  const socialImages = generatedAssets
    .filter(asset => asset.type === 'image')
    .map(asset => ({
      label: asset.name || asset.path,
      path: asset.path,
      url: relativeOutputPathToUrl(asset.path),
      platform: asset.platform || null,
      type: 'image',
    }))
    .filter(asset => asset.url);

  const socialClips = generatedAssets
    .filter(asset => asset.type === 'video')
    .map(asset => ({
      label: asset.name || asset.path,
      path: asset.path,
      url: relativeOutputPathToUrl(asset.path),
      platform: asset.platform || null,
      type: 'video',
    }))
    .filter(asset => asset.url);

  const warnings = [];
  if (!releaseLinks.length) warnings.push('No store or streaming links captured yet.');
  if (!baseImage && !resolveDefaultBaseImage(songId)) warnings.push('No base image uploaded in Song Catalog.');
  if (!marketingPack.dashboardUrl) warnings.push('Marketing pack has not been built from the Song Catalog pipeline yet.');
  if (marketingPack.dashboardUrl && !socialImages.length) warnings.push('Marketing pack exists, but no rendered social images were surfaced.');
  if (marketingPack.dashboardUrl && !socialClips.length) warnings.push('Marketing pack exists, but no rendered social clips were surfaced.');

  for (const issue of marketingPack.meta?.qa_failures || []) warnings.push(`QA failure: ${issue}`);
  for (const issue of marketingPack.meta?.qa_warnings || []) warnings.push(`QA warning: ${issue}`);

  return {
    songId: songId,
    dashboardUrl: marketingPack.dashboardUrl,
    songDetailUrl: `/songs/${encodeURIComponent(songId)}`,
    releaseLinks: releaseLinks.map(link => ({ label: link.platform, url: link.url, type: 'store' })),
    baseImage,
    thumbnails: [],
    socialImages,
    socialClips,
    surfacedAssets: [
      ...(marketingPack.dashboardUrl ? [{ label: 'Pack preview', url: marketingPack.dashboardUrl, type: 'page' }] : []),
      { label: 'Song Catalog', url: `/songs/${encodeURIComponent(songId)}`, type: 'page' },
      ...(baseImage ? [{ label: 'Base image', url: baseImage.url, type: 'base_image' }] : []),
      ...socialImages.map(asset => ({
        label: asset.label,
        url: asset.url,
        type: 'social_image',
        platform: asset.platform || null,
      })),
      ...socialClips.map(asset => ({
        label: asset.label,
        url: asset.url,
        type: 'social_clip',
        platform: asset.platform || null,
      })),
    ],
    counts: {
      releaseLinks: releaseLinks.length,
      thumbnails: 0,
      socialImages: socialImages.length,
      socialClips: socialClips.length,
    },
    warnings: [...new Set(warnings)],
  };
}

function stableIndexForKey(key, length) {
  if (!length) return 0;
  const total = Array.from(key).reduce((sum, char, index) => sum + (char.charCodeAt(0) * (index + 1)), 0);
  return Math.abs(total) % length;
}
