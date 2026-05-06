import { createRequire } from 'module';
import {
  createMarketingCampaign,
  getMarketingCampaigns,
  getMarketingTargets,
  getReleaseMatches,
} from '../shared/marketing-db.js';
import { getActiveProfileId, loadBrandProfile } from '../shared/brand-profile.js';
import { getAllSongs, getReleaseLinks } from '../shared/db.js';
import { getMarketingReleaseEntries } from '../shared/marketing-releases.js';

const require = createRequire(import.meta.url);
const express = require('express');
const originalHandle = express.application.handle;
const BRAND_PROFILE = loadBrandProfile();

express.application.handle = function marketingReleaseOutreachHandle(req, res, done) {
  const pathname = new URL(req.url, 'http://local').pathname;
  const shouldHandle =
    pathname === '/marketing' ||
    pathname === '/api/marketing/release-outreach-campaign' ||
    pathname === '/api/marketing/release-outreach-campaigns' ||
    pathname.match(/^\/api\/marketing\/release-outreach-options\/[^/]+$/) ||
    pathname === '/marketing/release-outreach-campaign';

  if (shouldHandle) {
    routeReleaseOutreach(req, res).catch((error) => {
      if (res.headersSent) return;
      res.statusCode = 500;
      const wantsJson = pathname.startsWith('/api/');
      res.setHeader('content-type', wantsJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
      res.end(wantsJson ? JSON.stringify({ ok: false, error: error.message }) : (error.stack || error.message));
    });
    return;
  }

  return originalHandle.call(this, req, res, done);
};

async function routeReleaseOutreach(req, res) {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  const optionsMatch = pathname.match(/^\/api\/marketing\/release-outreach-options\/([^/]+)$/);
  if (optionsMatch && req.method === 'GET') {
    const songId = decodeURIComponent(optionsMatch[1]);
    return sendJson(res, { ok: true, ...buildReleaseOutreachOptions(songId) });
  }

  if (pathname === '/api/marketing/release-outreach-campaigns' && req.method === 'GET') {
    return sendJson(res, { ok: true, campaigns: getReleaseCampaignsForApi() });
  }

  if (pathname === '/api/marketing/release-outreach-campaign' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = createReleaseOutreachCampaign(body);
    return sendJson(res, { ok: true, result });
  }

  if (pathname === '/marketing/release-outreach-campaign' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = createReleaseOutreachCampaign(body);
    return redirect(res, `/marketing?message=${encodeURIComponent(`Outreach campaign created: ${result.campaign_id}`)}`);
  }

  if (pathname === '/marketing' && req.method === 'GET') {
    return sendHtml(res, renderMarketingDashboard({
      message: url.searchParams.get('message') || '',
      error: url.searchParams.get('error') || '',
    }));
  }

  res.statusCode = 404;
  return sendJson(res, { ok: false, error: 'Release outreach route not found' });
}

function buildReleaseOutreachOptions(songId) {
  const song = getAllSongs().find(s => s.id === songId);
  if (!song) throw new Error(`Song not found: ${songId}`);

  const outlets = getEligibleOutletsForRelease(songId);
  const links = getReleaseLinks(songId);
  const campaigns = getCampaignsForSong(songId);

  return {
    song,
    release_links: links,
    outlets,
    campaigns,
    presets: [
      { id: 'safe_p0_launch', label: 'Safe P0 Launch', outlet_ids: outlets.filter(o => o.priority === 'P0' && o.outreach_allowed === true).map(o => o.id) },
      { id: 'all_safe_priority', label: 'All Safe P0/P1/P2', outlet_ids: outlets.filter(o => o.outreach_allowed === true).map(o => o.id) },
      { id: 'manual_review_queue', label: 'Manual Review Queue', outlet_ids: outlets.filter(o => o.outreach_allowed === 'manual_review_only').map(o => o.id) },
    ],
  };
}

function createReleaseOutreachCampaign(body = {}) {
  const songId = String(body.song_id || body.focus_song_id || '').trim();
  if (!songId) throw new Error('song_id is required');

  const song = getAllSongs().find(s => s.id === songId);
  if (!song) throw new Error(`Song not found: ${songId}`);

  const selectedOutletIds = normalizeIds(body.outlet_ids || body.target_ids || body.outlets || []);
  if (!selectedOutletIds.length) throw new Error('Select at least one outlet');

  const eligible = getEligibleOutletsForRelease(songId);
  const eligibleById = new Map(eligible.map(o => [o.id, o]));
  const selectedOutlets = selectedOutletIds
    .map(id => eligibleById.get(id))
    .filter(Boolean);

  if (!selectedOutlets.length) {
    throw new Error('No selected outlets are eligible for this release');
  }

  const blockedIds = selectedOutletIds.filter(id => !eligibleById.has(id));
  const links = getReleaseLinks(songId);
  const campaignId = createMarketingCampaign({
    name: `${BRAND_PROFILE.brand_name || 'Pancake Robot'} Outreach — ${song.title || song.topic || song.id}`,
    status: 'draft',
    focus_song_id: song.id,
    objective: buildCampaignObjective(song, selectedOutlets),
    audience: song.target_age_range || BRAND_PROFILE.audience?.age_range || '',
    channel_mix: summarizeChannelMix(selectedOutlets),
    approved_target_ids: selectedOutlets.map(o => o.id),
    brand_context: {
      campaign_kind: 'release_outreach',
      preset: body.preset || null,
      release: {
        id: song.id,
        title: song.title,
        topic: song.topic,
        status: song.status,
        release_date: song.release_date,
        distributor: song.distributor,
        links,
      },
      selected_outlets: selectedOutlets.map(o => ({
        id: o.id,
        name: o.name,
        priority: o.priority,
        type: o.type,
        contact_status: o.contact_status,
        ai_policy: o.ai_policy,
        outreach_allowed: o.outreach_allowed,
      })),
      blocked_or_ineligible_outlet_ids: blockedIds,
    },
    notes: 'Release-level outreach campaign. Draft only; Gmail sending/draft generation should remain review-gated.',
  });

  return {
    campaign_id: campaignId,
    song_id: song.id,
    selected_outlet_count: selectedOutlets.length,
    selected_outlets: selectedOutlets,
    blocked_or_ineligible_outlet_ids: blockedIds,
  };
}

function getEligibleOutletsForRelease(_songId) {
  return getMarketingTargets({})
    .map(normalizeOutletForDashboard)
    .filter(o => o.status !== 'do_not_contact')
    .filter(o => o.ai_policy !== 'banned')
    .filter(o => Boolean(o.contact_email || o.public_email))
    .sort((a, b) => {
      const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3, AVOID_FOR_FULLY_AI: 9 };
      const pa = priorityOrder[a.priority] ?? 5;
      const pb = priorityOrder[b.priority] ?? 5;
      if (pa !== pb) return pa - pb;
      return (b.fit_score || 0) - (a.fit_score || 0);
    });
}

function normalizeOutletForDashboard(row) {
  const raw = parseObject(row.raw_json);
  const pitchPrefs = parseObject(row.pitch_preferences);
  const aiMusicStance = raw.ai_music_stance || pitchPrefs.ai_music_stance || {};
  const priority = raw.priority || pitchPrefs.priority || null;
  const category = raw.category || pitchPrefs.category || row.type || null;

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    priority,
    category,
    type: row.type,
    platform: row.platform,
    fit_score: row.fit_score,
    contact_status: contactStatus(row),
    contact_method: row.contact_method,
    contact_email: row.contact_email,
    public_email: row.public_email,
    ai_policy: row.ai_policy,
    ai_risk_score: row.ai_risk_score,
    ai_risk_level: aiMusicStance.risk_level || riskLevelFromScore(row.ai_risk_score),
    outreach_allowed: outreachAllowed(row),
    recommended_pitch_type: raw.recommended_pitch_type || pitchPrefs.recommended_pitch_type || null,
    sample_pitch_hook: raw.sample_pitch_hook || row.outreach_angle || null,
    assets_to_send: raw.assets_to_send || pitchPrefs.assets_to_send || [],
  };
}

function renderMarketingDashboard({ message, error }) {
  const releasedSongs = getReleaseReadySongs();
  const campaigns = getReleaseCampaignsForApi();
  const campaignsBySong = groupBy(campaigns, 'focus_song_id');
  const outlets = getEligibleOutletsForRelease(null);

  const body = `
  <main class="p-8 space-y-8">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-3xl font-extrabold">Marketing Mission Control</h1>
          <p class="text-sm text-zinc-500 mt-2">Create release-level outreach campaigns by selecting email-capable outlets for each song.</p>
        </div>
        <form method="POST" action="/marketing/agents/inbox-scan">
          <button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Scan Gmail inbox</button>
        </form>
      </div>
    </section>
    ${message ? banner(message, 'emerald') : ''}${error ? banner(error, 'red') : ''}
    ${renderReleaseOutreachSection(releasedSongs, campaignsBySong, outlets)}
  </main>`;

  return shell('Marketing', body);
}

function renderReleaseOutreachSection(entries, campaignsBySong, outlets) {
  const heading = `<div class="flex items-center justify-between gap-3 mb-4"><div><h2 class="font-bold text-lg">Release Outreach Campaigns</h2><p class="text-sm text-zinc-500 mt-1">${entries.length} release-ready song${entries.length === 1 ? '' : 's'}; ${outlets.length} eligible outlet${outlets.length === 1 ? '' : 's'} loaded.</p></div></div>`;
  if (!entries.length) {
    return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">${heading}<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No release-ready songs yet.</div></section>`;
  }

  const cards = entries.map(({ song, links, hasMarketingImage }) => renderReleaseCard(song, links, campaignsBySong[song.id] || [], outlets, hasMarketingImage)).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">${heading}<div class="space-y-4">${cards}</div></section>`;
}

function renderReleaseCard(song, links, campaigns, outlets, hasMarketingImage = false) {
  const safeP0 = outlets.filter(o => o.priority === 'P0' && o.outreach_allowed === true).slice(0, 12);
  const safeOther = outlets.filter(o => o.priority !== 'P0' && o.outreach_allowed === true).slice(0, 8);
  const manual = outlets.filter(o => o.outreach_allowed === 'manual_review_only').slice(0, 6);
  const outletOptions = [...safeP0, ...safeOther, ...manual];

  const linksHtml = links.length
    ? links.map(l => `<a href="${attr(l.url)}" target="_blank" rel="noopener noreferrer" class="text-xs text-blue-600 hover:underline">${esc(l.platform)}</a>`).join(' &middot; ')
    : '<span class="text-xs text-zinc-400">No public links captured yet</span>';

  const existingCampaigns = campaigns.length
    ? `<div class="mt-3 text-xs text-zinc-500"><span class="font-semibold text-zinc-700">Existing campaigns:</span> ${campaigns.map(c => esc(c.name)).join(' · ')}</div>`
    : '';

  const checkboxRows = outletOptions.map(o => {
    const defaultChecked = o.priority === 'P0' && o.outreach_allowed === true;
    const risk = o.outreach_allowed === 'manual_review_only' ? 'Manual review' : 'Safe draft';
    return `<label class="flex items-start gap-3 border border-zinc-200 rounded-lg p-3 hover:bg-zinc-50">
      <input type="checkbox" name="outlet_ids" value="${attr(o.id)}" ${defaultChecked ? 'checked' : ''} class="mt-1">
      <span class="flex-1 min-w-0">
        <span class="flex flex-wrap items-center gap-2">
          <span class="font-semibold text-sm">${esc(o.name)}</span>
          <span class="text-[10px] uppercase tracking-wide bg-zinc-100 text-zinc-600 rounded-full px-2 py-0.5">${esc(o.priority || '—')}</span>
          <span class="text-[10px] uppercase tracking-wide bg-blue-50 text-blue-700 rounded-full px-2 py-0.5">${esc(o.type || 'outlet')}</span>
          <span class="text-[10px] uppercase tracking-wide ${o.outreach_allowed === 'manual_review_only' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'} rounded-full px-2 py-0.5">${esc(risk)}</span>
        </span>
        <span class="block text-xs text-zinc-500 mt-1">${esc(o.sample_pitch_hook || o.recommended_pitch_type || o.category || '')}</span>
      </span>
    </label>`;
  }).join('');

  return `<article class="border border-zinc-200 rounded-xl p-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-bold text-lg">${esc(song.title || song.topic || song.id)}</h3>
          <span class="${badge(song.status)}">${esc(song.status)}</span>
          ${hasMarketingImage ? '<span title="Marketing image available" class="text-xs">🖼️</span>' : ''}
        </div>
        <div class="mt-1 text-xs text-zinc-500">${linksHtml}</div>
        ${existingCampaigns}
      </div>
    </div>

    <form class="mt-4" method="POST" action="/marketing/release-outreach-campaign">
      <input type="hidden" name="song_id" value="${attr(song.id)}">
      <input type="hidden" name="preset" value="dashboard_release_selection">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 max-h-96 overflow-y-auto pr-1">
        ${checkboxRows || '<div class="text-sm text-zinc-500 border border-dashed rounded-xl p-6">No eligible outlets loaded. Run npm run marketing:outlets:seed.</div>'}
      </div>
      <div class="mt-4 flex items-center justify-between gap-3">
        <p class="text-xs text-zinc-500">Default selection: safe P0 outlets. Manual-review outlets can be selected, but should stay review-gated.</p>
        <button class="bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm font-semibold">Create outreach campaign</button>
      </div>
    </form>
  </article>`;
}

function getReleaseReadySongs() {
  return getMarketingReleaseEntries(25);
}

function getCampaignsForSong(songId) {
  return getMarketingCampaigns(100)
    .filter(c => c.focus_song_id === songId)
    .map(c => ({ ...c, outlet_count: (c.approved_target_ids || []).length }));
}

function getReleaseCampaignsForApi() {
  return getMarketingCampaigns(100)
    .filter(c => c.focus_song_id)
    .map(c => ({ ...c, outlet_count: (c.approved_target_ids || []).length }));
}

function buildCampaignObjective(song, outlets) {
  const types = summarizeChannelMix(outlets).map(i => `${i.count} ${i.type}`).join(', ');
  return `Release outreach for ${song.title || song.topic || song.id}; selected outlet mix: ${types}`;
}

function summarizeChannelMix(outlets) {
  const counts = outlets.reduce((acc, outlet) => {
    const type = outlet.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([type, count]) => ({ type, count }));
}

function normalizeIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  return [];
}

function contactStatus(row) {
  if (row.status === 'do_not_contact') return 'avoid';
  if (row.contact_email || row.public_email) return 'has_email';
  if (row.contact_method) return 'has_contact_or_submission_path';
  if (String(row.platform || '').toLowerCase().includes('owned')) return 'owned_channel';
  return 'manual_research_needed';
}

function outreachAllowed(row) {
  if (row.status === 'do_not_contact') return false;
  if (row.ai_policy === 'banned') return false;
  if (row.ai_policy === 'likely_hostile') return 'manual_review_only';
  if ((row.ai_risk_score || 0) >= 85) return 'manual_review_only';
  return true;
}

function riskLevelFromScore(score) {
  const n = Number(score || 0);
  if (n >= 85) return 'high';
  if (n >= 50) return 'medium';
  return 'low';
}

function groupBy(items, key) {
  return items.reduce((acc, item) => {
    const group = item[key] || 'unknown';
    (acc[group] ||= []).push(item);
    return acc;
  }, {});
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function banner(text, color) {
  const classes = color === 'red'
    ? 'border-red-200 bg-red-50 text-red-800'
    : 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return `<div class="rounded-xl border ${classes} px-4 py-3 text-sm">${esc(text)}</div>`;
}

function badge(status) {
  if (['submitted to DistroKid', 'outreach complete'].includes(status)) return 'badge badge-ok';
  if (['error'].includes(status)) return 'badge badge-bad';
  return 'badge badge-warn';
}

function shell(title, body) {
  const appTitle = BRAND_PROFILE.app_title || BRAND_PROFILE.brand_name || 'Music Pipeline';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ${esc(appTitle)}</title><link rel="icon" href="/logo.png"><script src="https://cdn.tailwindcss.com"></script><style>.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:.75rem;font-weight:500}.badge-ok{background:#d1fae5;color:#047857}.badge-warn{background:#fef3c7;color:#b45309}.badge-bad{background:#fee2e2;color:#b91c1c}</style></head><body class="bg-zinc-50 text-zinc-900"><div class="flex min-h-screen"><nav class="w-56 bg-zinc-900 text-zinc-100 p-4"><img src="/logo.png" class="w-32 h-32 object-contain mx-auto"><div class="mt-5 space-y-1"><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/">Dashboard</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas/generate">Generate Ideas</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas">Idea Vault</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/songs">Song Catalog</a><a class="block rounded-lg px-3 py-2 bg-zinc-700 text-white" href="/marketing">Marketing</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/brand">Brand</a></div></nav><div class="flex-1">${body}</div></div></body></html>`;
}

async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] || '').includes('json')) return raw ? JSON.parse(raw) : {};

  const params = new URLSearchParams(raw);
  const body = {};
  for (const [key, value] of params.entries()) {
    if (body[key] === undefined) body[key] = value;
    else if (Array.isArray(body[key])) body[key].push(value);
    else body[key] = [body[key], value];
  }
  return body;
}

function sendHtml(res, content) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(content);
}

function sendJson(res, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('location', location);
  res.end();
}

function esc(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#39;');
}

function attr(value) {
  return esc(value);
}
