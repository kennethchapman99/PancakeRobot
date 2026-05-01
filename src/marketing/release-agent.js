/**
 * Marketing Release Agent
 * Builds Instagram + TikTok launch packs for an approved song.
 * Phase 1 is manual posting only: no platform publishing APIs are called.
 */

import fs from 'fs';
import { join, relative } from 'path';
import { collectMarketingAssets } from './asset-collector.js';
import { findMarketingHook } from './hook-finder.js';
import { generateCaptions } from './captions.js';
import { renderMarketingAssets } from './video-renderer.js';
import { runMarketingQA } from './qa.js';
import { generateUploadChecklist } from './upload-checklist.js';

function rel(root, path) {
  return path ? relative(root, path) : null;
}

function assetUrl(songId, relativePath) {
  return `/media/marketing-ready/${encodeURIComponent(songId)}/${relativePath}`;
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeDashboard(assets, metadata, renderResult, qaReport) {
  const videoCards = (renderResult.generated || [])
    .filter(item => item.type === 'video')
    .map(item => {
      const p = rel(assets.outputDir, item.path);
      return `<div class="card"><h3>${item.name}</h3><video controls src="${assetUrl(assets.songId, p)}"></video><code>${p}</code></div>`;
    }).join('\n');

  const imageCards = (renderResult.generated || [])
    .filter(item => item.type === 'image')
    .map(item => {
      const p = rel(assets.outputDir, item.path);
      return `<div class="card"><h3>${item.name}</h3><img src="${assetUrl(assets.songId, p)}" alt="${item.name}"><code>${p}</code></div>`;
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
    <div class="meta">${assets.handle} · Instagram + TikTok release pack · Manual posting only</div>
    <div class="actions">
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

export async function buildMarketingReleasePack(songId, options = {}) {
  const assets = collectMarketingAssets(songId, options);
  const hook = await findMarketingHook(assets, options);
  const captions = generateCaptions(assets);
  const renderResult = await renderMarketingAssets(assets, hook);
  const qaReport = await runMarketingQA(assets, renderResult, hook, captions);
  generateUploadChecklist(assets, hook, captions, qaReport, renderResult);

  const metadata = {
    song_id: assets.songId,
    title: assets.title,
    artist: assets.artist,
    handle: assets.handle,
    cta: assets.cta,
    hyperfollow_url: assets.hyperfollowUrl || null,
    generated_at: new Date().toISOString(),
    hook_start_sec: hook.hook_start_sec,
    hook_end_sec: hook.hook_end_sec,
    hook_duration_sec: hook.hook_duration_sec,
    hook_rationale: hook.rationale,
    source_audio_path: assets.relative.audioPath,
    source_cover_path: assets.relative.coverPath,
    source_character_path: assets.relative.characterPath,
    output_dir: assets.relative.outputDir,
    generated_assets: (renderResult.generated || []).map(item => ({ ...item, path: rel(assets.repoRoot, item.path) })),
    skipped_assets: renderResult.skipped || [],
    qa_status: qaReport.passed ? 'pass' : 'needs_review',
    qa_warnings: qaReport.warnings || [],
    qa_failures: qaReport.failures || [],
    manual_posting_required: true,
    instagram_autopublish: false,
    tiktok_autopublish: false,
    dashboard_url: `/media/marketing-ready/${assets.songId}/index.html`,
  };

  writeJson(join(assets.outputDir, 'metadata.json'), metadata);
  writeDashboard(assets, metadata, renderResult, qaReport);

  return {
    ok: qaReport.passed,
    songId: assets.songId,
    title: assets.title,
    outputDir: assets.outputDir,
    dashboardUrl: metadata.dashboard_url,
    metadata,
    qaReport,
  };
}
