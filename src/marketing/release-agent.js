/**
 * Marketing Release Agent
 * Builds Instagram + TikTok launch packs for an approved song.
 * Manual posting only: no platform publishing APIs are called.
 */

import { collectMarketingAssets } from './asset-collector.js';
import { findMarketingHook } from './hook-finder.js';
import { generateCaptions } from './captions.js';
import { renderMarketingAssets } from './video-renderer.js';
import { runMarketingQA } from './qa.js';
import { generateUploadChecklist } from './upload-checklist.js';
import { generateHeroArt } from './hero-art.js';
import { applyHeroArtToAssets, finalizeMarketingPack } from './packaging.js';

export async function buildMarketingReleasePack(songId, options = {}) {
  const assets = collectMarketingAssets(songId, options);

  const heroArt = await generateHeroArt(assets, options);
  applyHeroArtToAssets(assets, heroArt);

  const hook = await findMarketingHook(assets, options);
  const captions = generateCaptions(assets);
  const renderResult = await renderMarketingAssets(assets, hook);
  const qaReport = await runMarketingQA(assets, renderResult, hook, captions);
  generateUploadChecklist(assets, hook, captions, qaReport, renderResult);

  const metadata = await finalizeMarketingPack({
    assets,
    hook,
    renderResult,
    qaReport,
    heroArt,
  });

  return {
    ok: qaReport.passed,
    songId: assets.songId,
    title: assets.title,
    outputDir: assets.outputDir,
    dashboardUrl: metadata.dashboard_url,
    previewUrl: metadata.preview_url,
    zipUrl: metadata.zip?.url || null,
    metadata,
    qaReport,
  };
}
