/**
 * Marketing pack post-processing, manifest, preview, and ZIP packaging.
 */

import fs from 'fs';
import archiver from 'archiver';
import { basename, dirname, join, relative } from 'path';

const RENAME_MAP = new Map([
  ['instagram/ig-reel-hook.mp4', 'instagram/instagram_reel_hook_1080x1920_15s.mp4'],
  ['instagram/ig-reel-lyrics.mp4', 'instagram/instagram_reel_lyrics_1080x1920_15s.mp4'],
  ['instagram/ig-reel-character.mp4', 'instagram/instagram_reel_character_1080x1920_15s.mp4'],
  ['instagram/ig-story-new-song.mp4', 'instagram/instagram_story_new_song_1080x1920_15s.mp4'],
  ['instagram/ig-feed-announcement-1080x1350.png', 'instagram/instagram_feed_announcement_1080x1350.png'],
  ['instagram/ig-square-post-1080x1080.png', 'instagram/instagram_square_post_1080x1080.png'],
  ['instagram/ig-reel-cover.jpg', 'instagram/instagram_reel_cover_1080x1920.jpg'],
  ['tiktok/tiktok-hook.mp4', 'tiktok/tiktok_hook_1080x1920_15s.mp4'],
  ['tiktok/tiktok-lyric-karaoke.mp4', 'tiktok/tiktok_lyric_karaoke_1080x1920_15s.mp4'],
  ['tiktok/tiktok-character-loop.mp4', 'tiktok/tiktok_character_loop_1080x1920_10s.mp4'],
  ['tiktok/tiktok-cover.jpg', 'tiktok/tiktok_cover_1080x1920.jpg'],
]);

const COPY_FILES = [
  ['captions.md', 'captions_instagram.md'],
  ['tiktok/tiktok-caption-options.md', 'captions_tiktok.md'],
  ['hashtags.md', 'hashtags_social.md'],
  ['upload-checklist.md', 'upload_checklist.md'],
];

function exists(path) {
  return path && fs.existsSync(path);
}

function ensureDir(path) {
  fs.mkdirSync(path, { recursive: true });
}

function rel(root, path) {
  return path ? relative(root, path) : null;
}

function outputRel(assets, path) {
  return path ? relative(assets.outputDir, path) : null;
}

function fileSize(path) {
  try { return fs.statSync(path).size; }
  catch { return null; }
}

function assetUrl(songId, relativePath) {
  return `/media/marketing-ready/${encodeURIComponent(songId)}/${String(relativePath).split('/').map(encodeURIComponent).join('/')}`;
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inferType(filename) {
  if (/\.mp4$/i.test(filename)) return 'video';
  if (/\.(png|jpg|jpeg|webp)$/i.test(filename)) return 'image';
  if (/\.json$/i.test(filename)) return 'json';
  if (/\.html$/i.test(filename)) return 'html';
  return 'text';
}

function inferResolution(filename) {
  return filename.match(/(\d{3,4}x\d{3,4})/)?.[1] || null;
}

function inferPurpose(filename) {
  const f = filename.toLowerCase();
  if (f.includes('reel_hook') || f.includes('tiktok_hook')) return 'Best first hook-led launch video';
  if (f.includes('lyrics') || f.includes('karaoke')) return 'Lyric / karaoke variant for a second post';
  if (f.includes('character')) return 'Character-led variant for visual continuity';
  if (f.includes('story')) return 'Instagram Story launch asset';
  if (f.includes('feed')) return 'Instagram feed announcement asset';
  if (f.includes('square')) return 'Square post asset';
  if (f.includes('cover')) return 'Platform cover image';
  if (f.includes('caption')) return 'Paste-ready social captions';
  if (f.includes('hashtag')) return 'Reusable social hashtag set';
  if (f.includes('checklist')) return 'Manual upload checklist and posting order';
  if (f.includes('metadata')) return 'Structured manifest for UI and agents';
  if (f.includes('preview')) return 'Standalone visual preview';
  if (f === 'readme.txt') return 'Posting order and pack overview';
  return 'Marketing pack asset';
}

function normalizeGeneratedAssets(assets, renderResult) {
  for (const item of renderResult.generated || []) {
    const oldRelative = outputRel(assets, item.path);
    const newRelative = RENAME_MAP.get(oldRelative);
    if (!newRelative) continue;

    const oldPath = join(assets.outputDir, oldRelative);
    const newPath = join(assets.outputDir, newRelative);
    if (!exists(oldPath)) continue;

    ensureDir(dirname(newPath));
    if (exists(newPath)) fs.unlinkSync(newPath);
    fs.renameSync(oldPath, newPath);
    item.path = newPath;
    item.name = basename(newPath);
    item.filename = basename(newPath);
    item.resolution = item.resolution || inferResolution(newPath);
    item.purpose = item.purpose || inferPurpose(newPath);
  }
}

function writeCopyAliases(assets) {
  for (const [sourceRel, destRel] of COPY_FILES) {
    const source = join(assets.outputDir, sourceRel);
    const dest = join(assets.outputDir, destRel);
    if (!exists(source)) continue;
    ensureDir(dirname(dest));
    fs.copyFileSync(source, dest);
  }
}

export function applyHeroArtToAssets(assets, heroArt) {
  const heroSquare = heroArt?.hero?.square || null;
  const heroPortrait = heroArt?.hero?.portrait || null;
  if (heroSquare) {
    assets.source.heroSquarePath = heroSquare;
    assets.source.copiedCover = heroSquare;
    assets.relative.heroSquarePath = rel(assets.repoRoot, heroSquare);
  }
  if (heroPortrait) {
    assets.source.heroPortraitPath = heroPortrait;
    assets.source.copiedCharacter = heroPortrait;
    assets.relative.heroPortraitPath = rel(assets.repoRoot, heroPortrait);
  }
}

function sourceReadiness(assets) {
  return {
    final_audio_present: Boolean(assets.source.copiedAudio || assets.source.audioPath),
    cover_art_present: Boolean(assets.source.copiedCover || assets.source.coverPath),
    character_asset_present: Boolean(assets.source.copiedCharacter || assets.source.characterPath),
    hyperfollow_link_present: Boolean(assets.hyperfollowUrl),
  };
}

function assetRecord(assets, item) {
  const relativePath = outputRel(assets, item.path);
  const filename = item.filename || item.name || basename(item.path);
  return {
    platform: item.platform || 'copy',
    group: item.platform === 'instagram' ? 'Instagram' : item.platform === 'tiktok' ? 'TikTok' : 'Copy / metadata',
    type: item.type || inferType(filename),
    name: filename,
    filename,
    path: rel(assets.repoRoot, item.path),
    relative_path: relativePath,
    url: assetUrl(assets.songId, relativePath),
    resolution: item.resolution || inferResolution(filename),
    purpose: item.purpose || inferPurpose(filename),
    size_bytes: fileSize(item.path),
  };
}

function fileRecord(assets, relativePath, group = 'Copy / metadata') {
  const path = join(assets.outputDir, relativePath);
  if (!exists(path)) return null;
  const filename = basename(path);
  return {
    platform: group === 'Source visuals' ? 'source' : 'copy',
    group,
    type: inferType(filename),
    name: filename,
    filename,
    path: rel(assets.repoRoot, path),
    relative_path: relativePath,
    url: assetUrl(assets.songId, relativePath),
    resolution: inferResolution(filename),
    purpose: inferPurpose(filename),
    size_bytes: fileSize(path),
  };
}

function sourceVisualRecords(assets, heroArt) {
  const fromHero = (heroArt.generated || []).map(item => fileRecord(assets, item.relative_path, 'Source visuals')).filter(Boolean);
  if (fromHero.length) return fromHero;
  return ['source/hero_square_3000x3000.png', 'source/hero_portrait_1080x1920.png', 'source/hero_landscape_1920x1080.png']
    .map(path => fileRecord(assets, path, 'Source visuals'))
    .filter(Boolean);
}

function buildAssetGroups(assets, renderResult, heroArt) {
  const generated = (renderResult.generated || []).map(item => assetRecord(assets, item));
  return {
    source_visuals: sourceVisualRecords(assets, heroArt),
    instagram: generated.filter(item => item.platform === 'instagram'),
    tiktok: generated.filter(item => item.platform === 'tiktok'),
    copy_metadata: [
      'captions_instagram.md',
      'captions_tiktok.md',
      'hashtags_social.md',
      'upload_checklist.md',
      'marketing_pack_metadata.json',
      'marketing_pack_preview.html',
      'README.txt',
    ].map(path => fileRecord(assets, path)).filter(Boolean),
  };
}

function writeReadme(assets, metadata) {
  const readme = `Pancake Robot Marketing Pack

Song: ${assets.title}
Song ID: ${assets.songId}
Generated: ${metadata.generated_at}
Manual posting only. No Instagram or TikTok autoposting has been performed.

Best posting order:
1. Instagram Reel: instagram/instagram_reel_hook_1080x1920_15s.mp4
2. TikTok: tiktok/tiktok_hook_1080x1920_15s.mp4
3. Instagram Story: instagram/instagram_story_new_song_1080x1920_15s.mp4
4. Instagram Feed: instagram/instagram_feed_announcement_1080x1350.png
5. Secondary variants: lyric/karaoke and character-loop posts

Copy files:
- captions_instagram.md
- captions_tiktok.md
- hashtags_social.md
- upload_checklist.md

Preview:
- marketing_pack_preview.html

Manifest:
- marketing_pack_metadata.json
`;
  fs.writeFileSync(join(assets.outputDir, 'README.txt'), readme);
}

function assetCardHtml(item) {
  const preview = item.type === 'video'
    ? `<video controls src="${htmlEscape(item.url)}"></video>`
    : item.type === 'image'
      ? `<img src="${htmlEscape(item.url)}" alt="${htmlEscape(item.filename)}">`
      : `<div class="file-icon">${htmlEscape(String(item.type || 'file').toUpperCase())}</div>`;
  const copyButton = ['text', 'json', 'html'].includes(item.type)
    ? `<button onclick="copyAsset('${htmlEscape(item.url)}')">Copy</button>`
    : '';
  return `<div class="card">
    ${preview}
    <h3>${htmlEscape(item.filename)}</h3>
    <p>${htmlEscape(item.purpose || '')}</p>
    <code>${htmlEscape(item.relative_path)}</code>
    <div class="card-actions"><a href="${htmlEscape(item.url)}" download>Download</a>${copyButton}</div>
  </div>`;
}

function sectionHtml(title, items) {
  const cards = (items || []).map(assetCardHtml).join('\n');
  return `<section class="section"><h2>${htmlEscape(title)}</h2><div class="grid">${cards || '<div class="panel">No assets generated yet.</div>'}</div></section>`;
}

function writePreview(assets, metadata, qaReport) {
  const groups = metadata.asset_groups || {};
  const failures = (qaReport.failures || []).map(item => `<li>${htmlEscape(item)}</li>`).join('') || '<li>None</li>';
  const warnings = [...(qaReport.warnings || []), ...(metadata.hero_art?.warnings || [])]
    .map(item => `<li>${htmlEscape(item)}</li>`).join('') || '<li>None</li>';
  const readiness = Object.entries(metadata.source_readiness || {})
    .map(([key, value]) => `<li><strong>${htmlEscape(key.replace(/_/g, ' '))}:</strong> ${value ? 'yes' : 'no'}</li>`)
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Marketing Pack — ${htmlEscape(assets.title)}</title>
  <style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f8fafc; color:#18181b; }
    header { padding:32px; background:#18181b; color:white; }
    main { padding:28px; }
    h1 { margin:8px 0 0; font-size:32px; }
    .meta { margin-top:8px; color:#d4d4d8; }
    .actions { margin-top:18px; display:flex; gap:10px; flex-wrap:wrap; }
    .btn, .card-actions a, .card-actions button { display:inline-block; background:#f59e0b; color:#18181b; padding:10px 14px; border-radius:10px; font-weight:700; text-decoration:none; border:0; cursor:pointer; }
    .section { margin-top:28px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:18px; }
    .card, .panel { background:white; border:1px solid #e4e4e7; border-radius:16px; padding:14px; box-shadow:0 1px 2px rgba(0,0,0,0.04); }
    .card h3 { font-size:14px; margin:10px 0 6px; }
    .card p { color:#52525b; font-size:13px; min-height:34px; }
    video, img { width:100%; border-radius:12px; background:#111827; max-height:560px; object-fit:contain; }
    code { display:block; margin-top:10px; font-size:12px; white-space:normal; color:#52525b; }
    .status { display:inline-flex; padding:5px 10px; border-radius:999px; font-size:12px; font-weight:700; background:${qaReport.passed ? '#d1fae5' : '#fee2e2'}; color:${qaReport.passed ? '#047857' : '#b91c1c'}; }
    .cols { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:16px; }
    li { margin:6px 0; }
    .file-icon { min-height:180px; display:flex; align-items:center; justify-content:center; border-radius:12px; background:#f4f4f5; font-weight:900; color:#71717a; }
    .card-actions { margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; }
  </style>
</head>
<body>
  <header>
    <div class="status">${qaReport.passed ? 'QA PASS' : 'NEEDS REVIEW'}</div>
    <h1>${htmlEscape(assets.title)}</h1>
    <div class="meta">${htmlEscape(assets.handle)} · Instagram + TikTok release pack · Manual posting only</div>
    <div class="actions">
      <a class="btn" href="upload_checklist.md">Upload checklist</a>
      <a class="btn" href="captions_instagram.md">Instagram captions</a>
      <a class="btn" href="captions_tiktok.md">TikTok captions</a>
      <a class="btn" href="marketing_pack_metadata.json">Metadata</a>
      <a class="btn" href="${htmlEscape(metadata.zip?.filename || '#')}">Download ZIP</a>
    </div>
  </header>
  <main>
    <div class="cols">
      <div class="panel"><h2>Status</h2><p><strong>Pack:</strong> ${htmlEscape(metadata.pack_status)}</p><p><strong>QA:</strong> ${htmlEscape(metadata.qa_status)}</p><p><strong>Hero provider:</strong> ${htmlEscape(metadata.hero_art?.provider_used || 'n/a')}</p></div>
      <div class="panel"><h2>Readiness</h2><ul>${readiness}</ul></div>
      <div class="panel"><h2>QA failures</h2><ul>${failures}</ul></div>
      <div class="panel"><h2>Warnings</h2><ul>${warnings}</ul></div>
    </div>
    ${sectionHtml('Source visuals', groups.source_visuals)}
    ${sectionHtml('Instagram assets', groups.instagram)}
    ${sectionHtml('TikTok assets', groups.tiktok)}
    ${sectionHtml('Copy / metadata', groups.copy_metadata)}
  </main>
  <script>
    async function copyAsset(url) {
      const text = await fetch(url).then(r => r.text());
      await navigator.clipboard.writeText(text);
      alert('Copied');
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(join(assets.outputDir, 'marketing_pack_preview.html'), html);
  fs.writeFileSync(join(assets.outputDir, 'index.html'), html);
}

async function createZipPackage(assets) {
  const zipFilename = `marketing-pack-${assets.songId}.zip`;
  const zipPath = join(assets.outputDir, zipFilename);
  if (exists(zipPath)) fs.unlinkSync(zipPath);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    for (const entry of fs.readdirSync(assets.outputDir)) {
      if (entry === zipFilename || entry === '.working') continue;
      const fullPath = join(assets.outputDir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) archive.directory(fullPath, entry);
      else archive.file(fullPath, { name: entry });
    }

    archive.finalize();
  });

  return {
    filename: zipFilename,
    path: zipPath,
    relative_path: zipFilename,
    url: assetUrl(assets.songId, zipFilename),
    size_bytes: fileSize(zipPath),
  };
}

export async function finalizeMarketingPack({ assets, hook, renderResult, qaReport, heroArt }) {
  normalizeGeneratedAssets(assets, renderResult);
  writeCopyAliases(assets);

  let metadata = {
    song_id: assets.songId,
    title: assets.title,
    artist: assets.artist,
    handle: assets.handle,
    cta: assets.cta,
    hyperfollow_url: assets.hyperfollowUrl || null,
    pack_status: 'built',
    generated_at: new Date().toISOString(),
    last_built_at: new Date().toISOString(),
    hook_start_sec: hook.hook_start_sec,
    hook_end_sec: hook.hook_end_sec,
    hook_duration_sec: hook.hook_duration_sec,
    hook_rationale: hook.rationale,
    source_audio_path: assets.relative.audioPath,
    source_cover_path: assets.relative.coverPath,
    source_character_path: assets.relative.characterPath,
    output_dir: assets.relative.outputDir,
    source_readiness: sourceReadiness(assets),
    hero_art: {
      enabled: heroArt.enabled,
      provider_requested: heroArt.provider,
      fallback_provider: heroArt.fallback_provider,
      provider_used: heroArt.provider_used,
      fallback_used: heroArt.fallback_used,
      reference_path: heroArt.reference_path,
      warnings: heroArt.warnings || [],
      prompts: heroArt.prompts,
      files: (heroArt.generated || []).map(item => ({
        key: item.key,
        filename: item.filename,
        path: rel(assets.repoRoot, item.path),
        relative_path: item.relative_path,
        resolution: item.resolution,
        provider_used: item.provider_used,
        purpose: item.purpose,
      })),
    },
    generated_assets: (renderResult.generated || []).map(item => assetRecord(assets, item)),
    skipped_assets: renderResult.skipped || [],
    qa_status: qaReport.passed ? 'pass' : 'needs_review',
    qa_warnings: qaReport.warnings || [],
    qa_failures: qaReport.failures || [],
    manual_posting_required: true,
    instagram_autopublish: false,
    tiktok_autopublish: false,
    dashboard_url: `/media/marketing-ready/${assets.songId}/marketing_pack_preview.html`,
    preview_url: `/media/marketing-ready/${assets.songId}/marketing_pack_preview.html`,
  };

  writeReadme(assets, metadata);
  metadata.asset_groups = buildAssetGroups(assets, renderResult, heroArt);
  metadata.zip = {
    filename: `marketing-pack-${assets.songId}.zip`,
    path: rel(assets.repoRoot, join(assets.outputDir, `marketing-pack-${assets.songId}.zip`)),
    relative_path: `marketing-pack-${assets.songId}.zip`,
    url: `/media/marketing-ready/${assets.songId}/marketing-pack-${assets.songId}.zip`,
    size_bytes: null,
  };

  fs.writeFileSync(join(assets.outputDir, 'marketing_pack_metadata.json'), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(join(assets.outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  writePreview(assets, metadata, qaReport);

  const zip = await createZipPackage(assets);
  metadata.zip = { ...zip, path: rel(assets.repoRoot, zip.path) };
  metadata.asset_groups = buildAssetGroups(assets, renderResult, heroArt);
  fs.writeFileSync(join(assets.outputDir, 'marketing_pack_metadata.json'), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(join(assets.outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  writePreview(assets, metadata, qaReport);

  return metadata;
}
