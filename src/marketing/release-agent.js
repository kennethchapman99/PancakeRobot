/**
 * Marketing Release Agent
 * Builds Instagram + TikTok launch packs for an approved song.
 * Phase 1 is manual posting only: no platform publishing APIs are called.
 */

import fs from 'fs';
import { basename, join, relative } from 'path';
import { collectMarketingAssets } from './asset-collector.js';
import { findMarketingHook } from './hook-finder.js';
import { generateCaptions } from './captions.js';
import { renderMarketingAssets } from './video-renderer.js';
import { runMarketingQA } from './qa.js';
import { generateUploadChecklist } from './upload-checklist.js';
import { getOrCreateReleaseMarketing, syncReleaseMarketingAssetPack } from '../shared/marketing-releases.js';
import { getSongMarketingKit, saveSongMarketingKit, syncSongMarketingKitFromPack } from '../shared/song-marketing-kit.js';
import { scanSongBaseImage } from '../shared/song-catalog-marketing.js';
import { buildReleaseAssetManifest, normalizeReleaseAssetManifest } from '../shared/release-asset-manifest.js';

function rel(root, path) {
  return path ? relative(root, path) : null;
}

function assetUrl(songId, relativePath) {
  return `/media/marketing-ready/${encodeURIComponent(songId)}/${relativePath}`;
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path) {
  if (!path || !fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function manifestAssetKey(asset = {}) {
  return String(
    asset.format
      || asset.filePath
      || asset.path
      || asset.pathOrUrl
      || asset.publicUrl
      || asset.name
      || asset.label
      || asset.id
      || ''
  )
    .trim()
    .toLowerCase();
}

function mediaAssetExists(asset = {}) {
  const pathValue = asset.path || asset.filePath || asset.pathOrUrl || null;
  return Boolean(pathValue && fs.existsSync(pathValue));
}

function mergeManifestAssets(existingAssets = [], nextAssets = []) {
  const merged = new Map();

  for (const asset of existingAssets) {
    if (!asset) continue;
    if (!mediaAssetExists(asset)) continue;
    merged.set(manifestAssetKey(asset), asset);
  }

  for (const asset of nextAssets) {
    if (!asset) continue;
    merged.set(manifestAssetKey(asset), asset);
  }

  return Array.from(merged.values());
}

function writeDashboard(assets, metadata, renderResult, qaReport) {
  const assetVersion = encodeURIComponent(metadata.generatedAt || metadata.generated_at || '');
  const videoCards = (renderResult.generated || [])
    .filter(item => item.type === 'video')
    .map(item => {
      const p = rel(assets.outputDir, item.path);
      return `<div class="card"><h3>${item.name}</h3><video controls src="${assetUrl(assets.songId, p)}?v=${assetVersion}"></video><code>${p}</code></div>`;
    }).join('\n');

  const imageCards = (renderResult.generated || [])
    .filter(item => item.type === 'image')
    .map(item => {
      const p = rel(assets.outputDir, item.path);
      return `<div class="card"><h3>${item.name}</h3><img src="${assetUrl(assets.songId, p)}?v=${assetVersion}" alt="${item.name}"><code>${p}</code></div>`;
    }).join('\n');

  const skipped = (renderResult.skipped || [])
    .map(item => `<li>${item.name}: ${item.reason}</li>`).join('') || '<li>None</li>';
  const failures = (qaReport.failures || [])
    .map(item => `<li>${item}</li>`).join('') || '<li>None</li>';
  const warnings = (qaReport.warnings || [])
    .map(item => `<li>${item}</li>`).join('') || '<li>None</li>';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Marketing Pack — ${assets.title}</title>
  <style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f8fafc; color:#18181b; }
    header { padding:32px; background:#18181b; color:white; }
    main { padding:28px; }
    h1 { margin:0; font-size:32px; }
    .meta { margin-top:8px; color:#d4d4d8; }
    .actions { margin-top:18px; display:flex; gap:10px; flex-wrap:wrap; }
    .btn { display:inline-block; background:#f59e0b; color:#18181b; padding:10px 14px; border-radius:10px; font-weight:700; text-decoration:none; }
    .section { margin-top:28px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:18px; }
    .card { background:white; border:1px solid #e4e4e7; border-radius:16px; padding:14px; box-shadow:0 1px 2px rgba(0,0,0,0.04); }
    .card h3 { font-size:14px; margin:0 0 10px; }
    video, img { width:100%; border-radius:12px; background:#111827; max-height:560px; object-fit:contain; }
    code { display:block; margin-top:10px; font-size:12px; white-space:normal; color:#52525b; }
    .status { display:inline-flex; padding:5px 10px; border-radius:999px; font-size:12px; font-weight:700; background:${qaReport.passed ? '#d1fae5' : '#fee2e2'}; color:${qaReport.passed ? '#047857' : '#b91c1c'}; }
    .cols { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:16px; }
    .panel { background:white; border:1px solid #e4e4e7; border-radius:16px; padding:16px; }
    li { margin:6px 0; }
  </style>
</head>
<body>
  <header>
    <div class="status">${qaReport.passed ? 'QA PASS' : 'NEEDS REVIEW'}</div>
    <h1>${assets.title}</h1>
    <div class="meta">${metadata.socialHandle || assets.handle} · Instagram + TikTok release pack · Manual posting only</div>
    <div class="actions">
      <a class="btn" href="${metadata.release_kit_url || `/release-kit/${assets.songId}?preview=1`}">Preview Release Kit</a>
      <a class="btn" href="upload-checklist.md">Upload checklist</a>
      <a class="btn" href="captions.md">Captions</a>
      <a class="btn" href="metadata.json">Metadata</a>
      <a class="btn" href="marketing-qa-report.json">QA report</a>
    </div>
  </header>
  <main>
    <div class="cols">
      <div class="panel"><h2>Hook</h2><p>${metadata.hook_start_sec}s → ${metadata.hook_end_sec}s (${metadata.hook_duration_sec}s)</p><p>${metadata.hook_rationale}</p></div>
      <div class="panel"><h2>Skipped video exports</h2><ul>${skipped}</ul></div>
      <div class="panel"><h2>QA failures</h2><ul>${failures}</ul></div>
      <div class="panel"><h2>QA warnings</h2><ul>${warnings}</ul></div>
    </div>
    <section class="section"><h2>Videos</h2><div class="grid">${videoCards || '<div class="panel">No MP4s generated yet. Usually this means final audio is missing or ffmpeg is not installed.</div>'}</div></section>
    <section class="section"><h2>Images</h2><div class="grid">${imageCards || '<div class="panel">No images generated.</div>'}</div></section>
  </main>
</body>
</html>`;

  fs.writeFileSync(join(assets.outputDir, 'index.html'), html);
}

const CORE_RELEASE_ASSET_FORMATS = [
  'ig-square-post-1080x1080.png',
  'ig-feed-announcement-1080x1350.png',
  'tiktok-cover.jpg',
  'outreach-hero-1600x900.png',
  'ig-reel-cover.jpg',
  'no-text-variation.png',
];

function assertCoreReleaseAssetsPresent(manifestAssets, { partialRegeneration = false, requiredFormats = CORE_RELEASE_ASSET_FORMATS } = {}) {
  const availableFormats = new Set(
    (manifestAssets || [])
      .filter(asset => ['image', 'square_cover', 'lyric_card', 'email_banner', 'vertical_video'].includes(asset.type) || /\.(png|jpe?g)$/i.test(String(asset.path || asset.pathOrUrl || asset.filePath || '')))
      .map(asset => String(asset.format || asset.filePath || asset.path || asset.pathOrUrl || '').split('/').pop().toLowerCase())
      .filter(Boolean)
  );
  const missing = requiredFormats.filter(format => !availableFormats.has(format.toLowerCase()));
  if (missing.length) {
    const scope = partialRegeneration ? 'after merging with the existing asset set' : 'for the release build';
    throw new Error(`[RELEASE] Missing core release assets ${scope}: ${missing.join(', ')}`);
  }
}

export async function buildMarketingReleasePack(songId, options = {}) {
  const {
    mode = null,
    renderVideos = true,
    requireApprovalBeforeVideo = false,
  } = options;

  const captionsOnly = mode === 'captions_checklist_only';
  const releaseMarketing = getOrCreateReleaseMarketing(songId);
  const preservedMarketingLinks = getSongMarketingKit(songId).marketing_links || {};
  let marketingKitSyncError = null;
  const sourceArtworkPath = options.sourceArtworkPath
    || releaseMarketing.asset_pack?.sourceArtworkPath
    || null;

  const assets = collectMarketingAssets(songId, { ...options, sourceArtworkPath });
  if (!assets.baseImagePath && sourceArtworkPath && fs.existsSync(sourceArtworkPath)) {
    assets.baseImagePath = sourceArtworkPath;
    assets.hasBaseImage = true;
  }

  // Inject base image path if one exists
  if (options.useBaseImage !== false) {
    const scannedBaseImage = scanSongBaseImage(songId);
    if (scannedBaseImage?.path) {
      assets.baseImagePath = scannedBaseImage.path;
      assets.hasBaseImage = true;
      console.error('[RELEASE] Base image:', assets.baseImagePath);
      if (!fs.existsSync(assets.baseImagePath)) {
        throw new Error(`[RELEASE] Base image path set but file does not exist: ${assets.baseImagePath}`);
      }
    }
  }
  if (!assets.hasBaseImage) {
    console.error('[RELEASE] Base image: none');
  }

  const shouldRegenerateArt = options.regenerateBaseArt === true || options.regenerateBaseArt === 'true';
  console.error('[RELEASE] regenerateBaseArt:', shouldRegenerateArt);
  if (shouldRegenerateArt) {
    console.error('[RELEASE] Base art regeneration requested. No image generator configured — using existing base image.');
    // Future: call generateBaseArt(assets) here when a provider is configured.
  } else if (assets.hasBaseImage) {
    console.error('[RELEASE] Using uploaded base image as-is (regenerate not requested)');
  }

  const hook = await findMarketingHook(assets, options);
  const captions = generateCaptions(assets);

  let renderResult = { generated: [], skipped: [] };
  if (!captionsOnly) {
    const renderOptions = { ...options };
    if (renderVideos === false) renderOptions.skipVideos = true;
    if (requireApprovalBeforeVideo) renderOptions.requireApprovalBeforeVideo = true;
    renderResult = await renderMarketingAssets(assets, hook, renderOptions);
  } else {
    renderResult.skipped.push({ name: 'All media', reason: 'mode=captions_checklist_only' });
  }

  const qaReport = await runMarketingQA(assets, renderResult, hook, captions);
  generateUploadChecklist(assets, hook, captions, qaReport, renderResult);

  const manifestAssets = [
    ...buildManifestAssets(renderResult.generated || [], assets),
    ...buildSupportingManifestAssets(assets, captionsOnly),
  ];
  const existingMetadata = readJson(join(assets.outputDir, 'metadata.json'));
  const existingManifest = normalizeReleaseAssetManifest(songId, existingMetadata);
  const isPartialRegeneration = Array.isArray(options.formats) && options.formats.length > 0;
  const currentMediaAssets = manifestAssets.filter(asset => /\.(png|jpe?g|mp4|mov|webm)$/i.test(String(asset.path || asset.pathOrUrl || '')));
  const currentSupportingAssets = manifestAssets.filter(asset => !currentMediaAssets.includes(asset));
  const mergedManifestAssets = isPartialRegeneration
    ? [
        ...mergeManifestAssets(
          (existingManifest.assets || []).filter(asset => ['image', 'video'].includes(asset.kind)),
          currentMediaAssets
        ),
        ...currentSupportingAssets,
      ]
    : manifestAssets;
  if (!captionsOnly) {
    const requestedFormats = Array.isArray(options.formats) ? options.formats.filter(Boolean) : [];
    const requiredFormats = isPartialRegeneration && requestedFormats.length > 0
      ? requestedFormats
      : CORE_RELEASE_ASSET_FORMATS;
    assertCoreReleaseAssetsPresent(mergedManifestAssets, {
      partialRegeneration: isPartialRegeneration,
      requiredFormats,
    });
  }

  const generatedAt = new Date().toISOString();
  const releaseKitUrl = `/release-kit/${encodeURIComponent(assets.songId)}?preview=1`;
  const baseImageSource = assets.hasBaseImage ? 'uploaded' : assets.sourceArtworkPath ? 'fallback' : 'none';
  const baseImagePath = assets.baseImagePath || assets.sourceArtworkPath || null;
  const manifest = buildReleaseAssetManifest({
    songId: assets.songId,
    releaseId: releaseMarketing.id,
    title: assets.title,
    artist: assets.artist,
    brand: assets.artist,
    socialHandle: assets.handle,
    generatedAt,
    baseImage: baseImagePath ? {
      path: rel(assets.repoRoot, baseImagePath),
      publicUrl: assets.relative.copiedCover ? assetUrl(assets.songId, rel(assets.outputDir, assets.source.copiedCover)) : null,
    } : null,
    baseImageSource,
    dashboardUrl: `/media/marketing-ready/${assets.songId}/index.html`,
    releaseKitUrl,
    generatedAssets: mergedManifestAssets.map(item => ({
      ...item,
      publicUrl: item.path ? assetUrl(assets.songId, rel(assets.outputDir, item.path)) : null,
    })),
    qaStatus: qaReport.passed ? 'pass' : 'needs_review',
    qaWarnings: qaReport.warnings || [],
    qaFailures: qaReport.failures || [],
    mode: mode || 'default',
  });

  const metadata = {
    song_id: assets.songId,
    songId: assets.songId,
    release_id: releaseMarketing.id,
    releaseId: releaseMarketing.id,
    title: assets.title,
    artist: assets.artist,
    handle: assets.handle,
    socialHandle: manifest.socialHandle,
    cta: assets.cta,
    hyperfollow_url: assets.hyperfollowUrl || null,
    generated_at: generatedAt,
    generatedAt,
    mode: mode || 'default',
    provider: options.provider || options.imageProvider || process.env.MARKETING_IMAGE_PROVIDER || 'none',
    base_image_source: baseImageSource,
    base_image_path: baseImagePath ? rel(assets.repoRoot, baseImagePath) : null,
    source_artwork_path: assets.sourceArtworkPath ? rel(assets.repoRoot, assets.sourceArtworkPath) : null,
    requested_formats: options.formats || null,
    hook_start_sec: hook.hook_start_sec,
    hook_end_sec: hook.hook_end_sec,
    hook_duration_sec: hook.hook_duration_sec,
    hook_rationale: hook.rationale,
    source_audio_path: assets.relative.audioPath,
    source_cover_path: assets.relative.coverPath,
    source_character_path: assets.relative.characterPath,
    output_dir: assets.relative.outputDir,
    generated_assets: mergedManifestAssets.map(item => ({
      ...item,
      path: item.path ? rel(assets.repoRoot, item.path) : null,
      filePath: item.filePath || (item.path ? rel(assets.repoRoot, item.path) : null),
      pathOrUrl: item.pathOrUrl || (item.path ? rel(assets.repoRoot, item.path) : null),
      publicUrl: item.publicUrl || (item.path ? assetUrl(assets.songId, rel(assets.outputDir, item.path)) : null),
    })),
    skipped_assets: renderResult.skipped || [],
    qa_status: qaReport.passed ? 'pass' : 'needs_review',
    qa_warnings: qaReport.warnings || [],
    qa_failures: qaReport.failures || [],
    manual_posting_required: true,
    instagram_autopublish: false,
    tiktok_autopublish: false,
    dashboard_url: `/media/marketing-ready/${assets.songId}/index.html`,
    release_kit_url: releaseKitUrl,
    assets: manifest.assets,
  };

  writeJson(join(assets.outputDir, 'metadata.json'), metadata);
  writeDashboard(assets, metadata, renderResult, qaReport);
  try {
    const synced = syncSongMarketingKitFromPack(songId, { marketingPack: { meta: metadata } });
    saveSongMarketingKit(songId, {
      marketing_links: preservedMarketingLinks,
      marketing_assets: synced.marketing_assets,
    });
  } catch (error) {
    marketingKitSyncError = error instanceof Error ? error.message : String(error);
    console.error(`[RELEASE] Marketing kit sync failed for ${songId}: ${marketingKitSyncError}`);
    if (typeof options.onMarketingKitSyncError === 'function') {
      options.onMarketingKitSyncError(error);
    }
  }
  syncReleaseMarketingAssetPack(songId, {
    sourceArtworkPath: assets.sourceArtworkPath || assets.baseImagePath || assets.source.coverPath || null,
    sourceArtworkLocked: options.sourceArtworkLocked !== false,
    socialHandle: manifest.socialHandle,
    generatedAt: metadata.generated_at,
    assets: metadata.generated_assets,
  });

  return {
    ok: qaReport.passed,
    songId: assets.songId,
    title: assets.title,
    outputDir: assets.outputDir,
    dashboardUrl: metadata.dashboard_url,
    metadata,
    qaReport,
    marketingKitSyncError,
    coreAssets: CORE_RELEASE_ASSET_FORMATS.map(format => ({
      format,
      present: mergedManifestAssets.some(asset => String(asset.format || asset.filePath || '').toLowerCase() === format.toLowerCase()),
    })),
  };
}

function buildManifestAssets(generatedAssets, assets) {
  return generatedAssets.map(item => {
    const type = inferAssetType(item);
    const sourceArtworkUsed = usesSourceArtwork(item, assets);
    return {
      id: `asset_${item.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
      type,
      status: 'generated',
      name: item.name,
      format: basename(item.path || item.name || ''),
      platform: item.platform || null,
      path: item.path,
      pathOrUrl: item.path,
      promptUsed: assets.baseImagePath || assets.sourceArtworkPath
        ? `Rendered with source artwork ${rel(assets.repoRoot, assets.baseImagePath || assets.sourceArtworkPath)}`
        : 'Rendered without explicit source artwork',
      sourceArtworkUsed,
    };
  });
}

function buildSupportingManifestAssets(assets, captionsOnly) {
  return [
    {
      id: 'caption_set',
      type: 'document',
      label: 'Caption Seed',
      format: 'captions.md',
      status: 'generated',
      path: join(assets.outputDir, 'captions.md'),
      pathOrUrl: join(assets.outputDir, 'captions.md'),
      promptUsed: 'Generated from release caption templates',
      sourceArtworkUsed: false,
    },
    {
      id: 'spotify_pitch',
      type: 'document',
      label: 'Upload Checklist',
      format: 'upload-checklist.md',
      status: captionsOnly ? 'skipped' : 'generated',
      path: join(assets.outputDir, 'upload-checklist.md'),
      pathOrUrl: join(assets.outputDir, 'upload-checklist.md'),
      promptUsed: 'Generated from upload checklist builder',
      sourceArtworkUsed: false,
    },
    {
      id: 'qa_report',
      type: 'metadata',
      label: 'QA Report',
      format: 'marketing-qa-report.json',
      status: 'generated',
      path: join(assets.outputDir, 'marketing-qa-report.json'),
      pathOrUrl: join(assets.outputDir, 'marketing-qa-report.json'),
      promptUsed: 'Generated from marketing QA checks',
      sourceArtworkUsed: false,
    },
    {
      id: 'release_asset_manifest',
      type: 'metadata',
      label: 'Release Asset Manifest',
      format: 'metadata.json',
      status: 'generated',
      path: join(assets.outputDir, 'metadata.json'),
      pathOrUrl: join(assets.outputDir, 'metadata.json'),
      promptUsed: 'Generated from release asset manifest builder',
      sourceArtworkUsed: false,
    },
    {
      id: 'static_pack_preview',
      type: 'preview',
      label: 'Static Pack Preview',
      format: 'index.html',
      status: 'generated',
      path: join(assets.outputDir, 'index.html'),
      pathOrUrl: join(assets.outputDir, 'index.html'),
      promptUsed: 'Generated from static pack dashboard renderer',
      sourceArtworkUsed: false,
    },
  ];
}

function inferAssetType(item) {
  const name = String(item.name || '').toLowerCase();
  if (name.includes('square')) return 'square_cover';
  if (name.includes('story') || name.includes('reel') || name.includes('tiktok') || name.endsWith('.mp4')) return 'vertical_video';
  if (name.includes('lyric')) return 'lyric_card';
  return 'email_banner';
}

function usesSourceArtwork(item, assets) {
  const sourceArtwork = assets.baseImagePath || assets.sourceArtworkPath;
  if (!sourceArtwork) return false;
  if (item.type === 'video') return true;
  return ['fullBleedHero', 'lyricsCard', 'characterHero', 'storyCTA'].some(layout => String(item.name || '').toLowerCase().includes(layout.toLowerCase().replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)))
    || /\.(png|jpe?g)$/i.test(String(item.path || ''));
}
