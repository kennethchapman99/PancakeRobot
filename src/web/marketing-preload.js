import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import {
  getMarketingSetupItems,
  updateMarketingSetupItem,
  getMarketingTargets,
  upsertMarketingTarget,
  updateMarketingTarget,
  getMarketingAgentRuns,
  getMarketingAgentLogs,
  getMarketingSummary,
  getMarketingCampaigns,
  getMarketingTargetStats,
  getReleaseMatches,
} from '../shared/marketing-db.js';
import { runMarketingResearchImport, runDraftCampaignPlanner } from '../agents/marketing-manager.js';
import { getMarketingContext } from '../shared/marketing-context.js';
import { loadBrandProfile, getActiveProfileId } from '../shared/brand-profile.js';
import { getInboxMessages } from '../shared/marketing-inbox-db.js';
import { getAllSongs, getReleaseLinks } from '../shared/db.js';

const BRAND_PROFILE = loadBrandProfile();
const __dirname_mkt = dirname(fileURLToPath(import.meta.url));
const SCAN_RESULTS_PATH = join(__dirname_mkt, '../../output/marketing/gmail-scan-results.json');

const require = createRequire(import.meta.url);
const express = require('express');
const originalHandle = express.application.handle;

express.application.handle = function marketingHandle(req, res, done) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (pathname === '/marketing' || pathname.startsWith('/marketing/') || pathname.startsWith('/api/marketing')) {
    routeMarketing(req, res).catch((error) => {
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(error.stack || error.message);
    });
    return;
  }
  return originalHandle.call(this, req, res, done);
};

async function routeMarketing(req, res) {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  if (pathname === '/api/marketing/summary' && req.method === 'GET') return sendJson(res, { ok: true, summary: getMarketingSummary() });
  if (pathname === '/api/marketing/context' && req.method === 'GET') return sendJson(res, { ok: true, context: getMarketingContext() });
  if (pathname === '/api/marketing/targets' && req.method === 'GET') return sendJson(res, { ok: true, targets: getMarketingTargets(Object.fromEntries(url.searchParams.entries())) });
  if (pathname === '/api/marketing/campaigns' && req.method === 'GET') return sendJson(res, { ok: true, campaigns: getMarketingCampaigns(25) });
  if (pathname === '/api/marketing/inbox' && req.method === 'GET') {
    try { return sendJson(res, { ok: true, messages: getInboxMessages(50), summary: getInboxSummary() }); } catch { return sendJson(res, { ok: true, messages: [], summary: null }); }
  }
  const matchesMatch = pathname.match(/^\/api\/marketing\/matches\/([^/]+)$/);
  if (matchesMatch && req.method === 'GET') return sendJson(res, { ok: true, matches: getReleaseMatches(matchesMatch[1], getActiveProfileId()) });
  if (pathname === '/api/marketing/target-stats' && req.method === 'GET') return sendJson(res, { ok: true, stats: getMarketingTargetStats(getActiveProfileId()) });

  const logsMatch = pathname.match(/^\/api\/marketing\/runs\/([^/]+)\/logs$/);
  if (logsMatch && req.method === 'GET') return sendJson(res, { ok: true, logs: getMarketingAgentLogs(logsMatch[1]) });

  if (pathname === '/api/marketing/agents/research-import' && req.method === 'POST') {
    const result = await runMarketingResearchImport();
    return sendJson(res, { ok: result.status !== 'error', result });
  }

  if (pathname === '/api/marketing/agents/draft-campaign' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = await runDraftCampaignPlanner({ focusSongId: body.focus_song_id || null });
    return sendJson(res, { ok: result.status === 'done', result });
  }

  if (pathname === '/api/marketing/agents/inbox-scan' && req.method === 'POST') {
    try {
      const { runInboxScan } = await import('../agents/marketing-inbox-agent.js');
      const body = await parseBody(req);
      const result = await runInboxScan({ dryRun: body.dry_run !== 'false' && body.dry_run !== false });
      return sendJson(res, { ok: true, result });
    } catch (err) { return sendJson(res, { ok: false, error: err.message }); }
  }

  if (pathname === '/api/marketing/agents/target-import' && req.method === 'POST') {
    try {
      const { importTargetsFromFile } = await import('../agents/marketing-target-agent.js');
      const sourcePath = process.env.MARKETING_RESEARCH_SOURCE_PATH;
      if (!sourcePath) return sendJson(res, { ok: false, error: 'MARKETING_RESEARCH_SOURCE_PATH not set' });
      const result = await importTargetsFromFile(sourcePath, { brandProfileId: getActiveProfileId() });
      return sendJson(res, { ok: true, result });
    } catch (err) { return sendJson(res, { ok: false, error: err.message }); }
  }

  if (pathname === '/api/marketing/agents/release-target-match' && req.method === 'POST') {
    try {
      const { matchTargetsForRelease } = await import('../agents/marketing-target-agent.js');
      const body = await parseBody(req);
      if (!body.song_id) return sendJson(res, { ok: false, error: 'song_id required' });
      const result = await matchTargetsForRelease(body.song_id, { brandProfileId: getActiveProfileId() });
      return sendJson(res, { ok: true, result });
    } catch (err) { return sendJson(res, { ok: false, error: err.message }); }
  }

  if (pathname === '/api/marketing/agents/release-plan' && req.method === 'POST') {
    try {
      const { buildReleasePlan } = await import('../agents/release-planner-agent.js');
      const body = await parseBody(req);
      if (!body.song_id) return sendJson(res, { ok: false, error: 'song_id required' });
      const result = await buildReleasePlan(body.song_id, { brandProfileId: getActiveProfileId() });
      return sendJson(res, { ok: true, result });
    } catch (err) { return sendJson(res, { ok: false, error: err.message }); }
  }

  if (pathname === '/api/marketing/agents/promotion-run' && req.method === 'POST') {
    try {
      const { runSafePromotion } = await import('../agents/release-planner-agent.js');
      const body = await parseBody(req);
      if (!body.song_id) return sendJson(res, { ok: false, error: 'song_id required' });
      const result = await runSafePromotion(body.song_id, { brandProfileId: getActiveProfileId() });
      return sendJson(res, { ok: true, result });
    } catch (err) { return sendJson(res, { ok: false, error: err.message }); }
  }

  if (pathname === '/marketing' && req.method === 'GET') {
    return sendHtml(res, renderMarketingPage({
      message: url.searchParams.get('message') || '',
      error: url.searchParams.get('error') || '',
    }));
  }

  const setupMatch = pathname.match(/^\/marketing\/setup\/([^/]+)$/);
  if (setupMatch && req.method === 'POST') {
    const body = await parseBody(req);
    updateMarketingSetupItem(decodeURIComponent(setupMatch[1]), {
      status: body.status || 'not_started',
      value: body.value || '',
      notes: body.notes || '',
    });
    return redirect(res, '/marketing?message=Setup%20saved');
  }

  if (pathname === '/marketing/targets' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      upsertMarketingTarget({ ...body, status: 'needs_review', recommendation: body.recommendation || 'manual_review' });
      return redirect(res, '/marketing?message=Target%20added');
    } catch (error) {
      return redirect(res, `/marketing?error=${encodeURIComponent(error.message)}`);
    }
  }

  const targetStatusMatch = pathname.match(/^\/marketing\/targets\/([^/]+)\/status$/);
  if (targetStatusMatch && req.method === 'POST') {
    const body = await parseBody(req);
    updateMarketingTarget(decodeURIComponent(targetStatusMatch[1]), { status: body.status || 'needs_review', notes: body.notes || '' });
    return redirect(res, '/marketing?message=Target%20updated');
  }

  if (pathname === '/marketing/agents/research-import' && req.method === 'POST') {
    const result = await runMarketingResearchImport();
    return redirect(res, `/marketing?message=${encodeURIComponent(`Import ${result.status}; imported ${result.imported}; skipped ${result.skipped}`)}`);
  }

  if (pathname === '/marketing/agents/draft-campaign' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = await runDraftCampaignPlanner({ focusSongId: body.focus_song_id || null });
    const message = result.status === 'done'
      ? `Draft campaign created: ${result.campaign_id}`
      : `Campaign planner ${result.status}`;
    return redirect(res, `/marketing?message=${encodeURIComponent(message)}`);
  }

  if (pathname === '/marketing/agents/inbox-scan' && req.method === 'POST') {
    try {
      const { runInboxScan } = await import('../agents/marketing-inbox-agent.js');
      const result = await runInboxScan({ dryRun: false });
      return redirect(res, `/marketing?message=${encodeURIComponent(`Inbox scan done: fetched ${result.fetched}, saved ${result.saved}`)}`);
    } catch (err) {
      return redirect(res, `/marketing?error=${encodeURIComponent(err.message)}`);
    }
  }

  res.statusCode = 404;
  return sendHtml(res, shell('Marketing', '<main class="p-8">Marketing route not found.</main>'));
}

function renderMarketingPage({ message, error }) {
  const social = BRAND_PROFILE.social || {};

  // ── Card 1: Gmail Reply Candidates ──
  let gmailCandidates = [];
  try {
    const raw = fs.readFileSync(SCAN_RESULTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    gmailCandidates = (parsed.messages || []).filter(m => m.classification === 'safe_reply_candidate');
  } catch {
    try {
      const dbRows = getInboxMessages(50, { classification: 'safe_reply_candidate' });
      gmailCandidates = dbRows.map(m => ({
        from: m.from_email || '',
        subject: m.subject || '',
        classification: m.classification || '',
        status: 'NEEDS-KEN',
        snippet: m.snippet || '',
        messageId: m.gmail_message_id || '',
        date: m.received_at || '',
      }));
    } catch { /* DB also unavailable */ }
  }

  // ── Card 2: Recently Released Songs ──
  let releasedSongs = [];
  try {
    const allSongs = getAllSongs();
    const eligible = allSongs.filter(s =>
      s.status === 'submitted_to_distributor' || s.status === 'published'
    );
    for (const song of eligible) {
      const links = getReleaseLinks(song.id);
      const distrokidLink = links.find(l => l.platform.toLowerCase() === 'distrokid' || l.platform.toLowerCase() === 'distrokid_link');
      releasedSongs.push({ song, links, distrokidLink: distrokidLink || null });
    }
  } catch { /* DB unavailable */ }

  const body = `
  <main class="p-8 space-y-8">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-3xl font-extrabold">Marketing Mission Control</h1>
        </div>
        <div class="flex gap-2 flex-wrap">
          <form method="POST" action="/marketing/agents/inbox-scan">
            <button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Scan Gmail inbox</button>
          </form>
        </div>
      </div>
    </section>
    ${message ? banner(message, 'emerald') : ''}${error ? banner(error, 'red') : ''}
    ${renderGmailCandidates(gmailCandidates, social)}
    ${renderReleasedSongs(releasedSongs)}
  </main>`;
  return shell('Marketing', body);
}

function buildSuggestedReply(msg, social) {
  const combined = ((msg.subject || '') + ' ' + (msg.snippet || '')).toLowerCase();
  const hasPlaylist = /playlist|curator|curate/.test(combined);
  const hasPress = /blog|press|review|media|feature|interview/.test(combined);
  const hasCollaboration = /collab|partner|sponsor|brand deal/.test(combined);

  const links = [];
  if (social.spotify_artist_url) links.push(`Spotify: ${social.spotify_artist_url}`);
  if (social.youtube_channel_url) links.push(`YouTube: ${social.youtube_channel_url}`);
  if (social.instagram_url) links.push(`Instagram: ${social.instagram_url}`);
  if (social.tiktok_url) links.push(`TikTok: ${social.tiktok_url}`);
  if (social.linktree_url) links.push(`All links: ${social.linktree_url}`);
  if (social.website_url) links.push(`Website: ${social.website_url}`);
  if (social.press_kit_url) links.push(`Press kit: ${social.press_kit_url}`);
  const linkBlock = links.length ? links.join('\n') : '[Add social links in Brand Profile → social section]';

  const brand = 'Pancake Robot';
  const email = social.email_contact || 'pancake.robot.music@gmail.com';

  if (hasPlaylist) {
    return `Hi,\n\nThanks so much for reaching out! We'd love to have ${brand} featured on your playlist.\n\n${brand} makes upbeat, silly children's music for kids ages 4–10 — high-energy pop songs designed for maximum replayability and kid participation.\n\nHere are our streaming links:\n${linkBlock}\n\nHappy to send over specific tracks or any other info you need. Just let us know!\n\nBest,\nKen (${brand})\n${email}`;
  }
  if (hasPress) {
    return `Hi,\n\nThanks for your interest in ${brand}!\n\n${brand} is a children's music project featuring a cheerful robot who loves making pancakes and going on silly adventures. We make upbeat, singalong-ready kids' pop songs for ages 4–10.\n\nHere's where to find us:\n${linkBlock}\n\nI'd be happy to answer any questions, share tracks, or send a press kit. Let me know what would be most helpful!\n\nBest,\nKen (${brand})\n${email}`;
  }
  if (hasCollaboration) {
    return `Hi,\n\nThanks for reaching out about a collaboration! We're always open to the right partnerships for ${brand}.\n\nA bit about us: ${brand} makes silly, high-energy children's music for kids ages 4–10. Our audience is families and young kids who love to sing and dance along.\n\nHere's a quick overview of where we are:\n${linkBlock}\n\nHappy to learn more about what you have in mind. Feel free to share more details and we can go from there.\n\nBest,\nKen (${brand})\n${email}`;
  }
  return `Hi,\n\nThanks so much for reaching out!\n\n${brand} is a children's music project — upbeat, silly pop songs for kids ages 4–10. Happy to share more about what we do.\n\nHere are our links:\n${linkBlock}\n\nLet me know how I can help!\n\nBest,\nKen (${brand})\n${email}`;
}

function renderGmailCandidates(messages, social = {}) {
  const heading = `<div class="flex items-center justify-between gap-3 mb-4"><div><h2 class="font-bold text-lg">Gmail Reply Candidates</h2><p class="text-sm text-zinc-500 mt-1">Messages classified as safe to reply to. Status: NEEDS-KEN until actioned.</p></div></div>`;
  if (!messages.length) {
    return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">${heading}<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No Gmail reply candidates found. Run inbox scan to refresh.</div></section>`;
  }

  const rows = messages.map((m, i) => {
    const reply = buildSuggestedReply(m, social);
    const replyId = `reply-${i}`;
    return `<tr class="align-top border-b">
      <td class="py-4 pr-4 font-medium max-w-xs">
        <div class="font-semibold">${esc(m.subject || '(no subject)')}</div>
        <div class="text-xs text-zinc-500 mt-0.5">${esc(m.from || '')}</div>
        <div class="text-xs text-zinc-400 mt-0.5">${m.date ? new Date(m.date).toLocaleDateString() : ''}</div>
      </td>
      <td class="py-4 pr-4">
        <span class="${inboxBadge(m.classification)}">${esc(m.classification)}</span>
        <div class="text-amber-600 font-semibold text-xs mt-1">&#9888; ${esc(m.status || 'NEEDS-KEN')}</div>
      </td>
      <td class="py-4 pr-4 text-zinc-400 text-xs max-w-xs">${esc(m.snippet || '')}</td>
      <td class="py-4 pl-2 min-w-80">
        <div class="relative">
          <textarea id="${replyId}" class="w-full text-xs font-mono border border-zinc-200 rounded-lg p-3 bg-zinc-50 resize-y min-h-40" readonly>${esc(reply)}</textarea>
          <button onclick="(function(btn){const t=document.getElementById('${replyId}');navigator.clipboard.writeText(t.value).then(()=>{const orig=btn.textContent;btn.textContent='Copied!';btn.classList.add('bg-emerald-600');setTimeout(()=>{btn.textContent=orig;btn.classList.remove('bg-emerald-600')},1500)});})(this)" class="absolute top-2 right-2 bg-zinc-800 hover:bg-zinc-700 text-white text-xs px-2 py-1 rounded transition-colors">Copy</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">${heading}<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-xs uppercase text-zinc-400 border-b"><tr><th class="py-3 pr-4">Message</th><th class="py-3 pr-4">Status</th><th class="py-3 pr-4">Snippet</th><th class="py-3 pl-2">Suggested Reply</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderReleasedSongs(entries) {
  const heading = `<div class="flex items-center justify-between gap-3 mb-4"><div><h2 class="font-bold text-lg">Recently Released Songs</h2><p class="text-sm text-zinc-500 mt-1">${entries.length} song${entries.length !== 1 ? 's' : ''} submitted to distributor.</p></div></div>`;
  if (!entries.length) {
    return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">${heading}<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No released songs with DistroKid links yet.</div></section>`;
  }
  const isDistrokidPlatform = p => p.toLowerCase() === 'distrokid' || p.toLowerCase() === 'distrokid_link';
  const cards = entries.map(({ song, links, distrokidLink }) => {
    const otherLinks = links.filter(l => !isDistrokidPlatform(l.platform));
    const otherLinksHtml = otherLinks.map(l => `<a href="${attr(l.url)}" target="_blank" rel="noopener noreferrer" class="text-xs text-blue-600 hover:underline">${esc(l.platform)}</a>`).join(' &middot; ');
    const distrokidHtml = distrokidLink
      ? `<a href="${attr(distrokidLink.url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-semibold px-3 py-1 rounded-full hover:bg-indigo-100">DistroKid &#8599;</a>`
      : `<span class="inline-flex items-center gap-1 bg-zinc-100 border border-zinc-200 text-zinc-400 text-xs px-3 py-1 rounded-full">Link pending</span>`;
    return `<div class="border border-zinc-200 rounded-xl p-4"><div class="flex items-start justify-between gap-3"><div class="flex-1"><div class="font-semibold">${esc(song.title || '(untitled)')}</div><div class="mt-2 flex flex-wrap gap-2 items-center">${distrokidHtml}${otherLinksHtml ? `<span class="text-zinc-400 text-xs">${otherLinksHtml}</span>` : ''}</div></div><span class="${badge(song.status)}">${esc(song.status)}</span></div></div>`;
  }).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">${heading}<div class="space-y-2">${cards}</div></section>`;
}
function inboxBadge(cls) { const map = { do_not_contact:'bg-red-100 text-red-700', safe_reply_candidate:'bg-emerald-100 text-emerald-700', opportunity:'bg-amber-100 text-amber-700', submission_confirmation:'bg-blue-100 text-blue-700', vendor_spam:'bg-zinc-100 text-zinc-500', needs_ken:'bg-orange-100 text-orange-700', creator_reply:'bg-violet-100 text-violet-700', playlist_reply:'bg-indigo-100 text-indigo-700', blog_media_reply:'bg-sky-100 text-sky-700', platform_admin:'bg-gray-100 text-gray-500', account_admin:'bg-gray-100 text-gray-500' }; return `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[cls]||'bg-zinc-100 text-zinc-600'}`; }
function banner(text, color) { return `<div class="rounded-xl border border-${color}-200 bg-${color}-50 px-4 py-3 text-sm text-${color}-800">${esc(text)}</div>`; }
function badge(status) { return `badge ${status === 'done' || status === 'approved' || status === 'draft' ? 'badge-ok' : status === 'rejected' || String(status).startsWith('blocked') || status === 'error' ? 'badge-bad' : 'badge-warn'}`; }
function opt(value, label, selected) { return `<option value="${attr(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`; }
function groupBy(items, key) { return items.reduce((acc, item) => { const group = item[key] || 'Other'; (acc[group] ||= []).push(item); return acc; }, {}); }
function shell(title, body) { return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ${esc(BRAND_PROFILE.app_title)}</title><link rel="icon" href="/logo.png"><script src="https://cdn.tailwindcss.com"></script><style>.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:.75rem;font-weight:500}.badge-ok{background:#d1fae5;color:#047857}.badge-warn{background:#fef3c7;color:#b45309}.badge-bad{background:#fee2e2;color:#b91c1c}</style></head><body class="bg-zinc-50 text-zinc-900"><div class="flex min-h-screen"><nav class="w-56 bg-zinc-900 text-zinc-100 p-4"><img src="/logo.png" class="w-32 h-32 object-contain mx-auto"><div class="mt-5 space-y-1"><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/">Dashboard</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas/generate">Generate Ideas</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas">Idea Vault</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/songs">Song Catalog</a><a class="block rounded-lg px-3 py-2 bg-zinc-700 text-white" href="/marketing">Marketing</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/brand">Brand</a></div></nav><div class="flex-1">${body}</div></div></body></html>`; }
async function parseBody(req) { const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString('utf8'); if ((req.headers['content-type'] || '').includes('json')) return raw ? JSON.parse(raw) : {}; return Object.fromEntries(new URLSearchParams(raw).entries()); }
function sendHtml(res, content) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(content); }
function sendJson(res, payload) { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload)); }
function redirect(res, location) { res.statusCode = 303; res.setHeader('location', location); res.end(); }
function esc(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#39;'); }
function attr(value) { return esc(value); }
