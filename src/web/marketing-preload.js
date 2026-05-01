/**
 * Marketing dashboard bridge.
 *
 * Keeps the main web server file untouched by registering Marketing Release Agent
 * routes before the app's normal routes are added. This exposes a lightweight
 * dashboard and a run/stream API for manual Instagram + TikTok asset packs.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import express from 'express';
import { buildMarketingReleasePack } from '../marketing/release-agent.js';
import { getAllSongs } from '../shared/db.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const OUTPUT_ROOT = join(REPO_ROOT, process.env.MARKETING_OUTPUT_DIR || 'output/marketing-ready');
const MARKETING_ROUTES_KEY = Symbol.for('pancakeRobot.marketingRoutesRegistered');

const marketingJobs = new Map();

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return null; }
}

function listMarketingPacks() {
  if (!fs.existsSync(OUTPUT_ROOT)) return [];
  return fs.readdirSync(OUTPUT_ROOT)
    .map(name => {
      const dir = join(OUTPUT_ROOT, name);
      if (!fs.statSync(dir).isDirectory()) return null;
      const meta = readJson(join(dir, 'metadata.json')) || {};
      return {
        songId: name,
        title: meta.title || name,
        qa: meta.qa_status || 'unknown',
        generatedAt: meta.generated_at || null,
        dashboardUrl: `/media/marketing-ready/${encodeURIComponent(name)}/index.html`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
}

function renderMarketingDashboard() {
  const packs = listMarketingPacks();
  const songs = getAllSongs().slice(0, 80);
  const packIds = new Set(packs.map(p => p.songId));

  const packRows = packs.length ? packs.map(pack => `
    <tr>
      <td><strong>${htmlEscape(pack.title)}</strong><div class="muted">${htmlEscape(pack.songId)}</div></td>
      <td><span class="badge ${pack.qa === 'pass' ? 'ok' : 'warn'}">${htmlEscape(pack.qa)}</span></td>
      <td>${htmlEscape(pack.generatedAt || '-')}</td>
      <td><a class="btn small" href="${pack.dashboardUrl}">Open pack</a></td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty">No marketing packs generated yet.</td></tr>';

  const songCards = songs.map(song => {
    const hasPack = packIds.has(song.id);
    return `<div class="song-card">
      <div>
        <h3>${htmlEscape(song.title || song.topic || song.id)}</h3>
        <p>${htmlEscape(song.id)} · ${htmlEscape(song.status || 'draft')}</p>
      </div>
      <div class="actions">
        ${hasPack ? `<a class="btn secondary" href="/media/marketing-ready/${encodeURIComponent(song.id)}/index.html">Open</a>` : ''}
        <button class="btn" onclick="buildPack('${htmlEscape(song.id)}')">${hasPack ? 'Rebuild' : 'Build pack'}</button>
      </div>
    </div>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Marketing — Pancake Robot</title>
  <style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#f8fafc; color:#18181b; }
    header { padding:32px; background:#18181b; color:white; }
    main { padding:28px; max-width:1180px; margin:auto; }
    h1 { margin:0; font-size:34px; }
    h2 { margin-top:30px; }
    .muted, p { color:#71717a; }
    .hero-actions { margin-top:16px; display:flex; gap:10px; flex-wrap:wrap; }
    .btn { border:0; border-radius:10px; background:#f59e0b; color:#18181b; font-weight:800; padding:9px 13px; text-decoration:none; cursor:pointer; display:inline-block; }
    .btn.secondary { background:#e4e4e7; color:#18181b; }
    .btn.small { font-size:13px; padding:7px 10px; }
    .panel { background:white; border:1px solid #e4e4e7; border-radius:16px; padding:18px; box-shadow:0 1px 2px rgba(0,0,0,0.04); }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; border-bottom:1px solid #e4e4e7; padding:12px; font-size:14px; vertical-align:middle; }
    th { color:#52525b; }
    .badge { display:inline-flex; padding:4px 9px; border-radius:999px; font-size:12px; font-weight:800; }
    .badge.ok { background:#d1fae5; color:#047857; }
    .badge.warn { background:#fef3c7; color:#b45309; }
    .songs { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:14px; }
    .song-card { background:white; border:1px solid #e4e4e7; border-radius:16px; padding:16px; display:flex; justify-content:space-between; gap:14px; align-items:center; }
    .song-card h3 { margin:0 0 6px; font-size:15px; }
    .song-card p { margin:0; font-size:12px; }
    .actions { display:flex; gap:8px; flex-shrink:0; }
    .empty { color:#71717a; text-align:center; padding:30px; }
    #job { margin-top:16px; white-space:pre-wrap; background:#18181b; color:#f4f4f5; border-radius:14px; padding:14px; display:none; max-height:340px; overflow:auto; }
  </style>
</head>
<body>
  <header>
    <h1>Marketing Release Agent</h1>
    <p>Builds Instagram + TikTok assets. Manual posting only for now.</p>
    <div class="hero-actions">
      <a class="btn" href="/songs">Song catalog</a>
      <a class="btn secondary" href="/">Dashboard</a>
    </div>
  </header>
  <main>
    <section class="panel">
      <h2 style="margin-top:0">Generated packs</h2>
      <table>
        <thead><tr><th>Song</th><th>QA</th><th>Generated</th><th></th></tr></thead>
        <tbody>${packRows}</tbody>
      </table>
      <div id="job"></div>
    </section>
    <h2>Build / rebuild pack</h2>
    <div class="songs">${songCards || '<div class="panel empty">No songs found yet.</div>'}</div>
  </main>
  <script>
    function log(line) {
      const box = document.getElementById('job');
      box.style.display = 'block';
      box.textContent += line + '\n';
      box.scrollTop = box.scrollHeight;
    }
    async function buildPack(songId) {
      document.getElementById('job').textContent = '';
      log('Starting marketing pack for ' + songId + '...');
      const res = await fetch('/api/marketing/' + encodeURIComponent(songId) + '/build', { method:'POST' });
      const data = await res.json();
      if (!data.ok) { log('Failed to start: ' + (data.error || 'unknown error')); return; }
      const es = new EventSource('/api/marketing/stream/' + encodeURIComponent(data.jobId));
      es.addEventListener('log', e => log(JSON.parse(e.data).message));
      es.addEventListener('complete', e => {
        const payload = JSON.parse(e.data);
        log('Complete. Opening pack...');
        es.close();
        window.location.href = payload.dashboardUrl;
      });
      es.addEventListener('error', e => { log('Error building marketing pack.'); es.close(); });
    }
  </script>
</body>
</html>`;
}

function registerMarketingRoutes(app, originalGet, originalPost) {
  if (app[MARKETING_ROUTES_KEY]) return;
  app[MARKETING_ROUTES_KEY] = true;

  originalGet.call(app, '/marketing', (req, res) => {
    res.type('html').send(renderMarketingDashboard());
  });

  originalPost.call(app, '/api/marketing/:songId/build', (req, res) => {
    const { songId } = req.params;
    const jobId = `marketing_${Date.now().toString(36)}`;
    const job = { status:'running', logs:[], result:null, error:null };
    marketingJobs.set(jobId, job);

    Promise.resolve().then(async () => {
      job.logs.push(`[MARKETING] Building pack for ${songId}`);
      const result = await buildMarketingReleasePack(songId);
      job.result = result;
      job.status = 'done';
      job.logs.push(`[MARKETING] Output: ${result.outputDir}`);
      job.logs.push(`[MARKETING] Dashboard: ${result.dashboardUrl}`);
    }).catch(err => {
      job.status = 'error';
      job.error = err.message;
      job.logs.push(`[MARKETING] Failed: ${err.message}`);
    });

    res.json({ ok:true, jobId });
  });

  originalGet.call(app, '/api/marketing/stream/:jobId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let index = 0;
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const tick = () => {
      const job = marketingJobs.get(req.params.jobId);
      if (!job) { send('error', { message:'Job not found' }); return res.end(); }
      while (index < job.logs.length) send('log', { message: job.logs[index++] });
      if (job.status === 'done') { send('complete', { dashboardUrl: job.result.dashboardUrl, outputDir: job.result.outputDir }); return res.end(); }
      if (job.status === 'error') { send('error', { message: job.error }); return res.end(); }
      setTimeout(tick, 400);
    };
    tick();
  });
}

const originalGet = express.application.get;
const originalPost = express.application.post;
let registering = false;

express.application.get = function patchedGet(path, ...handlers) {
  if (!registering && typeof path === 'string') {
    registering = true;
    try { registerMarketingRoutes(this, originalGet, originalPost); }
    finally { registering = false; }
  }
  return originalGet.call(this, path, ...handlers);
};

express.application.post = function patchedPost(path, ...handlers) {
  if (!registering && typeof path === 'string') {
    registering = true;
    try { registerMarketingRoutes(this, originalGet, originalPost); }
    finally { registering = false; }
  }
  return originalPost.call(this, path, ...handlers);
};
