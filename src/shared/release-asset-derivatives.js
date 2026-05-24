import fs from 'fs';
import path from 'path';
import { createCanvas, loadImage } from 'canvas';

export const RELEASE_ASSET_TARGETS = Object.freeze([
  { key: 'spotify', label: 'Spotify / DSP Cover', fileName: 'spotify-cover-3000x3000.png', width: 3000, height: 3000 },
  { key: 'youtube', label: 'YouTube Thumbnail', fileName: 'youtube-thumbnail-1280x720.png', width: 1280, height: 720 },
  { key: 'instagram_square', label: 'Instagram Square', fileName: 'instagram-square-1080x1080.png', width: 1080, height: 1080, subdir: 'instagram' },
  { key: 'instagram_vertical', label: 'Instagram Story / Reel', fileName: 'instagram-vertical-1080x1920.png', width: 1080, height: 1920, subdir: 'instagram' },
  { key: 'facebook', label: 'Facebook Post', fileName: 'facebook-post-1200x630.png', width: 1200, height: 630 },
]);

function mediaUrlFromOutputPath(absPath, outputRoot) {
  const rel = path.relative(outputRoot, absPath).replace(/\\/g, '/');
  return `/media/${rel}`;
}

async function renderDerivative(sourcePath, outputPath, width, height) {
  const source = await loadImage(sourcePath);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const coverScale = Math.max(width / source.width, height / source.height);
  const coverW = source.width * coverScale;
  const coverH = source.height * coverScale;
  ctx.drawImage(source, (width - coverW) / 2, (height - coverH) / 2, coverW, coverH);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

export async function buildReleaseDerivatives({
  entityType,
  entityId,
  title,
  artist,
  sourceImagePath,
  sourceImageFingerprint = null,
  outputDir,
  outputRoot = path.join(process.cwd(), 'output'),
  provider = 'manual',
}) {
  if (!sourceImagePath || !fs.existsSync(sourceImagePath)) throw new Error('Primary image file was not found.');
  fs.mkdirSync(outputDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const assets = [];

  for (const target of RELEASE_ASSET_TARGETS) {
    const targetDir = target.subdir ? path.join(outputDir, target.subdir) : outputDir;
    const outputPath = path.join(targetDir, target.fileName);
    await renderDerivative(sourceImagePath, outputPath, target.width, target.height);
    assets.push({
      id: `${entityType}_${target.key}`,
      name: target.fileName,
      label: target.label,
      type: 'image',
      kind: 'image',
      status: 'generated',
      platform: target.key,
      format: target.fileName,
      dimensions: { width: target.width, height: target.height },
      path: outputPath,
      pathOrUrl: outputPath,
      filePath: path.relative(process.cwd(), outputPath).replace(/\\/g, '/'),
      publicUrl: mediaUrlFromOutputPath(outputPath, outputRoot),
      sourceArtworkUsed: true,
      promptUsed: `Derived from primary image ${path.relative(process.cwd(), sourceImagePath).replace(/\\/g, '/')}`,
    });
  }

  const metadata = {
    entity_type: entityType,
    entity_id: entityId,
    song_id: entityType === 'single' ? entityId : null,
    album_id: entityType === 'album' ? entityId : null,
    title,
    artist,
    generated_at: generatedAt,
    provider,
    base_image_source: provider,
    base_image_path: path.relative(process.cwd(), sourceImagePath).replace(/\\/g, '/'),
    primary_image_fingerprint: sourceImageFingerprint,
    generated_assets: assets,
    qa_warnings: [],
    qa_failures: [],
    dashboard_url: entityType === 'single'
      ? `/media/marketing-ready/${encodeURIComponent(entityId)}/index.html`
      : `/media/albums/${encodeURIComponent(entityId)}/assets/index.html`,
  };
  fs.writeFileSync(path.join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(outputDir, 'index.html'), renderPreviewHtml({ title, artist, assets, generatedAt }));
  return { ok: true, entityType, entityId, outputDir, metadata, assets };
}

function renderPreviewHtml({ title, artist, assets, generatedAt }) {
  const cards = assets.map(asset => `<article class="card"><h2>${asset.label}</h2><img src="${asset.publicUrl}" alt="${asset.label}"><p>${asset.dimensions.width}x${asset.dimensions.height}</p><code>${asset.filePath}</code></article>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Release Assets - ${title}</title><style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#18181b}header{padding:28px;background:#18181b;color:white}main{padding:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:18px}.card{background:white;border:1px solid #e4e4e7;border-radius:8px;padding:14px}img{width:100%;max-height:420px;object-fit:contain;background:#111827}code{display:block;margin-top:8px;font-size:12px;word-break:break-all;color:#52525b}p{color:#71717a}</style></head><body><header><h1>${title}</h1><p>${artist || ''} · ${generatedAt}</p></header><main>${cards}</main></body></html>`;
}
