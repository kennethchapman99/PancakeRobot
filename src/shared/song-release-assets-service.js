import fs from 'fs';
import path from 'path';
import { getSong } from './db.js';
import { buildMarketingReleasePack } from '../marketing/release-agent.js';
import { getSongBaseImageDir, scanMarketingPack, scanSongBaseImage } from './song-catalog-marketing.js';
import { getSongMarketingKit, saveSongMarketingKit, syncSongMarketingKitFromPack } from './song-marketing-kit.js';

const GENERATED_ASSET_FIELDS = [
  'square_post_url',
  'vertical_post_url',
  'portrait_post_url',
  'outreach_banner_url',
  'cover_safe_promo_url',
  'no_text_variation_url',
];
export const DEFAULT_RELEASE_ASSET_FORMATS = Object.freeze([
  'ig-square-post-1080x1080.png',
  'ig-feed-announcement-1080x1350.png',
  'tiktok-cover.jpg',
  'outreach-hero-1600x900.png',
  'ig-reel-cover.jpg',
  'no-text-variation.png',
]);
const serviceHooks = {
  buildMarketingReleasePack: null,
};

function requireSong(songId) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  return song;
}

function pickGeneratedAssets(marketingAssets = {}) {
  return Object.fromEntries(GENERATED_ASSET_FIELDS.map(field => [field, marketingAssets[field] || '']));
}

function buildWarningFromImageSource(imageSource = {}) {
  if (!imageSource?.source_label) return '';
  return `Release-specific base image cleared. Now using: ${imageSource.source_label}.`;
}

export function getSongReleaseAssetState(songId, options = {}) {
  requireSong(songId);

  const marketingPack = options.marketingPack || scanMarketingPack(songId);
  const marketingKit = options.marketingKit || getSongMarketingKit(songId, { marketingPack });

  return {
    ok: true,
    songId,
    dashboardUrl: marketingPack.dashboardUrl || null,
    manifest: marketingPack.manifest || null,
    generatedAssets: pickGeneratedAssets(marketingKit.marketing_assets),
    marketingAssets: marketingKit.marketing_assets,
    imageSource: marketingKit.image_source,
    qaWarnings: marketingPack.meta?.qa_warnings || [],
    qaFailures: marketingPack.meta?.qa_failures || [],
  };
}

export function clearSongBaseImage(songId, options = {}) {
  requireSong(songId);

  const refDir = getSongBaseImageDir(songId);
  const deletedFiles = [];
  if (fs.existsSync(refDir)) {
    for (const name of fs.readdirSync(refDir)) {
      if (!/^base-image\.[A-Za-z0-9]+$/i.test(name)) continue;
      const absPath = path.join(refDir, name);
      fs.unlinkSync(absPath);
      deletedFiles.push(absPath);
    }
  }

  const currentKit = getSongMarketingKit(songId);
  const assetPatch = {
    ...currentKit.marketing_assets,
    base_image_url: '',
    generated_at: '',
    generation_source: currentKit.marketing_assets.generation_source === 'release_base_image'
      ? ''
      : currentKit.marketing_assets.generation_source,
  };

  if (options.clearGeneratedAssets !== false) {
    for (const field of GENERATED_ASSET_FIELDS) assetPatch[field] = '';
  }

  const refreshedKit = saveSongMarketingKit(songId, { marketing_assets: assetPatch });
  const rescannedBaseImage = scanSongBaseImage(songId);
  const imageSource = refreshedKit.image_source;
  const warning = !rescannedBaseImage && imageSource?.generation_source !== 'release_base_image'
    ? buildWarningFromImageSource(imageSource)
    : '';

  return {
    ok: true,
    songId,
    deletedFiles,
    imageSource,
    marketingAssets: refreshedKit.marketing_assets,
    warning,
  };
}

export async function buildSongReleaseAssets(songId, options = {}) {
  requireSong(songId);

  const normalizedOptions = {
    mode: 'render_from_existing_visuals',
    renderVideos: false,
    formats: DEFAULT_RELEASE_ASSET_FORMATS,
    ...options,
  };
  const builder = options.builder || serviceHooks.buildMarketingReleasePack || buildMarketingReleasePack;
  const result = await builder(songId, normalizedOptions);
  const marketingPack = scanMarketingPack(songId);
  const marketingKit = syncSongMarketingKitFromPack(songId, { marketingPack });
  const state = getSongReleaseAssetState(songId, { marketingPack, marketingKit });
  const syncWarning = result.marketingKitSyncError
    ? `Marketing kit sync warning: ${result.marketingKitSyncError}`
    : null;

  return {
    ok: result.ok,
    songId,
    dashboardUrl: state.dashboardUrl,
    generatedAssets: state.generatedAssets,
    marketingAssets: state.marketingAssets,
    imageSource: state.imageSource,
    qaWarnings: syncWarning ? [...state.qaWarnings, syncWarning] : state.qaWarnings,
    qaFailures: state.qaFailures,
  };
}

export function setSongReleaseAssetsServiceHooks(hooks = {}) {
  serviceHooks.buildMarketingReleasePack = hooks.buildMarketingReleasePack || null;
}
