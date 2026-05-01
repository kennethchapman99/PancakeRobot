/** Song-detail Marketing Pack panel. */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const OUTPUT_ROOT = join(REPO_ROOT, process.env.MARKETING_OUTPUT_DIR || 'output/marketing-ready');
const KEY = Symbol.for('pancakeRobot.marketingSongDetailPanel');

const exists = p => Boolean(p && fs.existsSync(p));
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const statSize = p => { try { return fs.statSync(p).size; } catch { return null; } };
const outDir = id => join(OUTPUT_ROOT, id);
const mediaUrl = (id, rel) => `/media/marketing-ready/${encodeURIComponent(id)}/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
const typeFor = n => /\.mp4$/i.test(n) ? 'video' : /\.(png|jpe?g|webp)$/i.test(n) ? 'image' : /\.json$/i.test(n) ? 'json' : /\.html$/i.test(n) ? 'html' : 'text';
const resFor = n => n.match(/(\d{3,4}x\d{3,4})/)?.[1] || null;

function purposeFor(name) {
  const f = name.toLowerCase();
  if (f.includes('hook')) return 'Best first hook-led launch post';
  if (f.includes('lyrics') || f.includes('karaoke')) return 'Lyric / karaoke variant';
  if (f.includes('character')) return 'Character continuity variant';
  if (f.includes('story')) return 'Instagram Story launch asset';
  if (f.includes('feed')) return 'Instagram feed announcement';
  if (f.includes('square')) return 'Square post asset';
  if (f.includes('cover')) return 'Platform cover image';
  if (f.includes('caption')) return 'Paste-ready caption copy';
  if (f.includes('hashtag')) return 'Reusable hashtags';
  if (f.includes('checklist')) return 'Manual posting checklist';
  if (f.includes('metadata')) return 'Structured manifest';
  if (f.includes('preview')) return 'Standalone preview';
  return 'Marketing pack asset';
}

function manifest(id) {
  return readJson(join(outDir(id), 'marketing_pack_metadata.json')) || readJson(join(outDir(id), 'metadata.json'));
}

function normalize(id, item) {
  const rel = item.relative_path || item.path || item.filename || item.name;
  const filename = item.filename || item.name || String(rel).split('/').pop();
  return { ...item, filename, name: filename, type: item.type || typeFor(filename), resolution: item.resolution || resFor(filename), purpose: item.purpose || purposeFor(filename), relative_path: rel, url: item.url || mediaUrl(id, rel) };
}

function scan(id, dir, platform, group) {
  const root = join(outDir(id), dir);
  if (!exists(root)) return [];
  return fs.readdirSync(root).map(name => {
    const full = join(root, name);
    try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
    return normalize(id, { platform, group, filename: name, relative_path: `${dir}/${name}`, size_bytes: statSize(full) });
  }).filter(Boolean);
}

function copyFiles(id) {
  return ['captions_instagram.md', 'captions_tiktok.md', 'hashtags_social.md', 'upload_checklist.md', 'marketing_pack_metadata.json', 'marketing_pack_preview.html', 'README.txt']
    .map(name => exists(join(outDir(id), name)) ? normalize(id, { platform: 'copy', group: 'Copy / metadata', filename: name, relative_path: name, size_bytes: statSize(join(outDir(id), name)) }) : null)
    .filter(Boolean);
}

function groups(id, m) {
  const g = m?.asset_groups || {};
  return {
    source_visuals: (g.source_visuals?.length ? g.source_visuals : scan(id, 'source', 'source', 'Source visuals')).map(a => normalize(id, a)),
    instagram: (g.instagram?.length ? g.instagram : scan(id, 'instagram', 'instagram', 'Instagram')).map(a => normalize(id, a)),
    tiktok: (g.tiktok?.length ? g.tiktok : scan(id, 'tiktok', 'tiktok', 'TikTok')).map(a => normalize(id, a)),
    copy_metadata: (g.copy_metadata?.length ? g.copy_metadata : copyFiles(id)).map(a => normalize(id, a)),
  };
}

function readiness(id, m) {
  if (m?.source_readiness) return m.source_readiness;
  const songDir = join(REPO_ROOT, 'output/songs', id);
  const distDir = join(REPO_ROOT, 'output/distribution-ready', id);
  const meta = readJson(join(distDir, 'metadata.json')) || readJson(join(songDir, 'metadata.json')) || {};
  const audio = exists(join(distDir, 'upload-this.mp3')) || exists(join(distDir, 'upload-this.wav')) || exists(join(songDir, 'audio.mp3')) || exists(join(songDir, 'audio.wav'));
  const cover = exists(join(distDir, 'cover-art-3000x3000.png')) || exists(join(distDir, 'apple-music-cover.png')) || exists(join(distDir, 'youtube-thumbnail.png'));
  const character = exists(process.env.MARKETING_CHARACTER_ASSET) || exists(join(REPO_ROOT, 'assets/pancake-robot-character.png')) || exists(join(REPO_ROOT, 'assets/pancake-robot-avatar.png')) || exists(join(REPO_ROOT, 'src/web/public/logo.png')) || cover;
  const link = meta.hyperfollow_url || meta.hyperfollow || meta.streaming_link || meta.link_in_bio_url;
  return { final_audio_present: Boolean(audio), cover_art_present: Boolean(cover), character_asset_present: Boolean(character), hyperfollow_link_present: Boolean(link) };
}

function needsRebuild(id, m) {
  if (!m?.generated_at) return false;
  const builtAt = new Date(m.generated_at).getTime();
  return [
    join(REPO_ROOT, 'output/distribution-ready', id, 'upload-this.mp3'),
    join(REPO_ROOT, 'output/distribution-ready', id, 'upload-this.wav'),
    join(REPO_ROOT, 'output/distribution-ready', id, 'cover-art-3000x3000.png'),
    join(REPO_ROOT, 'output/songs', id, 'lyrics.md'),
    join(REPO_ROOT, 'output/songs', id, 'lyrics-clean.txt'),
    process.env.MARKETING_CHARACTER_ASSET,
  ].some(p => { try { return fs.statSync(p).mtimeMs > builtAt; } catch { return false; } });
}

function summary(id) {
  const m = manifest(id);
  const zip = `marketing-pack-${id}.zip`;
  const zipPath = join(outDir(id), zip);
  const packStatus = !m ? 'not_built' : needsRebuild(id, m) ? 'needs_rebuild' : 'built';
  return { song_id: id, title: m?.title || id, pack_status: packStatus, qa_status: m?.qa_status || 'not_run', last_built_at: m?.last_built_at || m?.generated_at || null, source_readiness: readiness(id, m), zip_available: exists(zipPath), zip_url: exists(zipPath) ? mediaUrl(id, zip) : null, preview_url: exists(join(outDir(id), 'marketing_pack_preview.html')) ? mediaUrl(id, 'marketing_pack_preview.html') : m?.dashboard_url || null, asset_groups: groups(id, m), manual_posting_required: true, instagram_autopublish: false, tiktok_autopublish: false };
}

function panelScript(id) {
  return `<script>(function(){
const songId=${JSON.stringify(id)};const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));const label=s=>s==='not_built'?'Not built':s==='needs_rebuild'?'Needs rebuild':'Built';const fmt=v=>v?new Date(v).toLocaleString():'—';
function preview(a){if(a.type==='video')return '<video controls class="w-full rounded-lg bg-zinc-900" style="max-height:320px" src="'+esc(a.url)+'"></video>';if(a.type==='image')return '<img class="w-full rounded-lg bg-zinc-100 object-contain" style="max-height:320px" src="'+esc(a.url)+'" alt="'+esc(a.filename)+'">';return '<div class="rounded-lg bg-zinc-100 text-zinc-500 font-bold flex items-center justify-center" style="height:120px">'+esc((a.type||'file').toUpperCase())+'</div>';}
function card(a){const copy=['text','json','html'].includes(a.type);return '<div class="border border-zinc-200 rounded-xl p-3 bg-white">'+preview(a)+'<div class="font-semibold text-sm text-zinc-800 mt-3 break-all">'+esc(a.filename)+'</div><div class="text-xs text-zinc-400 mt-1">'+esc([a.platform,a.resolution].filter(Boolean).join(' · '))+'</div><div class="text-xs text-zinc-500 mt-2">'+esc(a.purpose||'')+'</div><div class="flex gap-2 mt-3 flex-wrap"><a class="text-xs bg-zinc-900 text-white rounded-lg px-3 py-1.5" download href="'+esc(a.url)+'">Download</a>'+(copy?'<button class="text-xs bg-amber-500 text-white rounded-lg px-3 py-1.5" data-copy-url="'+esc(a.url)+'">Copy</button>':'')+'</div></div>';}
function group(t,items){return items&&items.length?'<div class="mt-5"><h3 class="text-sm font-bold text-zinc-700 mb-3">'+esc(t)+'</h3><div class="grid grid-cols-1 md:grid-cols-2 gap-3">'+items.map(card).join('')+'</div></div>':'';}
function render(d){const r=Object.entries(d.source_readiness||{}).map(([k,v])=>'<span class="text-xs rounded-lg px-2.5 py-1 '+(v?'bg-emerald-50 text-emerald-700':'bg-zinc-100 text-zinc-400')+'">'+(v?'✓ ':'○ ')+esc(k.replace(/_/g,' '))+'</span>').join(' ');const g=d.asset_groups||{};document.getElementById('marketing-pack-panel').innerHTML='<section class="bg-white border border-zinc-200 rounded-2xl p-5 mb-6"><div class="flex items-start justify-between gap-4 mb-4"><div><div class="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Marketing Pack</div><h2 class="text-lg font-bold text-zinc-900 mt-1">Instagram + TikTok launch assets</h2></div><div class="flex gap-2 flex-wrap"><button id="marketing-build-btn" class="bg-amber-500 hover:bg-amber-600 text-white font-bold px-4 py-2 rounded-xl text-sm">'+(d.pack_status==='built'?'Rebuild Pack':'Build Marketing Pack')+'</button>'+(d.preview_url?'<a class="bg-zinc-900 text-white font-bold px-4 py-2 rounded-xl text-sm" target="_blank" href="'+esc(d.preview_url)+'">Open Preview</a>':'')+(d.zip_url?'<a class="bg-zinc-100 text-zinc-700 font-bold px-4 py-2 rounded-xl text-sm" download href="'+esc(d.zip_url)+'">Download ZIP</a>':'')+'</div></div><div class="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4"><div class="rounded-xl bg-zinc-50 p-3"><div class="text-xs text-zinc-400">Pack status</div><div class="font-bold text-sm">'+esc(label(d.pack_status))+'</div></div><div class="rounded-xl bg-zinc-50 p-3"><div class="text-xs text-zinc-400">QA status</div><div class="font-bold text-sm">'+esc(d.qa_status)+'</div></div><div class="rounded-xl bg-zinc-50 p-3"><div class="text-xs text-zinc-400">Last built</div><div class="font-bold text-sm">'+esc(fmt(d.last_built_at))+'</div></div><div class="rounded-xl bg-zinc-50 p-3"><div class="text-xs text-zinc-400">ZIP</div><div class="font-bold text-sm">'+(d.zip_available?'Available':'Not built')+'</div></div></div><div class="flex gap-2 flex-wrap mb-2">'+r+'</div><div id="marketing-job-log" class="hidden mt-4 rounded-xl bg-zinc-950 text-green-300 font-mono text-xs p-3 whitespace-pre-wrap max-h-48 overflow-auto"></div>'+group('Source visuals',g.source_visuals)+group('Instagram assets',g.instagram)+group('TikTok assets',g.tiktok)+group('Copy / metadata',g.copy_metadata)+'</section>';document.getElementById('marketing-build-btn')?.addEventListener('click',build);document.querySelectorAll('[data-copy-url]').forEach(b=>b.addEventListener('click',async()=>{await navigator.clipboard.writeText(await fetch(b.getAttribute('data-copy-url')).then(r=>r.text()));b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200);}));}
function log(line){const b=document.getElementById('marketing-job-log');if(!b)return;b.classList.remove('hidden');b.textContent+=line+'\\n';b.scrollTop=b.scrollHeight;}async function load(){render(await fetch('/api/marketing/'+encodeURIComponent(songId)+'/summary').then(r=>r.json()));}
async function build(){const btn=document.getElementById('marketing-build-btn');if(btn){btn.disabled=true;btn.textContent='Building...';}const res=await fetch('/api/marketing/'+encodeURIComponent(songId)+'/build',{method:'POST'});const data=await res.json();if(!data.ok){log('Failed: '+(data.error||'unknown'));return;}log('Starting marketing pack build...');const es=new EventSource('/api/marketing/stream/'+encodeURIComponent(data.jobId));es.addEventListener('log',e=>log(JSON.parse(e.data).message));es.addEventListener('complete',async()=>{es.close();log('Complete. Refreshing assets...');await load();});es.addEventListener('error',()=>{es.close();log('Build failed.');});}
function mount(){if(document.getElementById('marketing-pack-panel'))return;const parent=document.querySelector('[x-data="songDetail()"]')||document.body;const panel=document.createElement('div');panel.id='marketing-pack-panel';panel.innerHTML='<section class="bg-white border border-zinc-200 rounded-2xl p-5 mb-6 text-sm text-zinc-500">Loading Marketing Pack...</section>';parent.insertBefore(panel,parent.children[2]||parent.firstChild);load().catch(err=>{panel.innerHTML='<section class="bg-red-50 border border-red-200 rounded-2xl p-5 mb-6 text-sm text-red-700">Marketing Pack failed to load: '+esc(err.message)+'</section>';});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();})();</script>`;
}

function inject(html, song) {
  if (!song?.id || html.includes('marketing-pack-panel')) return html;
  const script = panelScript(song.id);
  return html.includes('</body>') ? html.replace('</body>', `${script}\n</body>`) : `${html}\n${script}`;
}

function register(app, originalGet, originalUse) {
  if (app[KEY]) return;
  app[KEY] = true;
  originalUse.call(app, (req, res, next) => {
    const render = res.render.bind(res);
    res.render = function patchedRender(view, locals, callback) {
      let renderLocals = locals || {};
      let cb = callback;
      if (typeof locals === 'function') { cb = locals; renderLocals = {}; }
      if (view !== 'songs/detail') return render(view, renderLocals, cb);
      return render(view, renderLocals, (err, html) => {
        if (err) { if (cb) return cb(err); return next(err); }
        const out = inject(html, renderLocals.song);
        if (cb) return cb(null, out);
        return res.send(out);
      });
    };
    next();
  });
  originalGet.call(app, '/api/marketing/:songId/summary', (req, res) => {
    try { res.json(summary(req.params.songId)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
}

const originalGet = express.application.get;
const originalUse = express.application.use;
let registering = false;
express.application.get = function patchedGet(path, ...handlers) {
  if (!registering && typeof path === 'string') { registering = true; try { register(this, originalGet, originalUse); } finally { registering = false; } }
  return originalGet.call(this, path, ...handlers);
};
express.application.use = function patchedUse(...args) {
  if (!registering) { registering = true; try { register(this, originalGet, originalUse); } finally { registering = false; } }
  return originalUse.call(this, ...args);
};
