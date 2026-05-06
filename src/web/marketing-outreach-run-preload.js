import { createRequire } from 'module';
import { createOutreachRun, getEligibleOutlets } from '../agents/marketing-outreach-run-agent.js';
import { generateDraftsForCampaign, generateDraftForOutreachItem } from '../agents/marketing-outreach-draft-agent.js';
import { getOutreachItems, getOutreachSummary } from '../shared/marketing-outreach-db.js';
import { getMarketingCampaigns } from '../shared/marketing-db.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import { getMarketingReleaseEntries } from '../shared/marketing-releases.js';

const require = createRequire(import.meta.url);
const express = require('express');
const originalHandle = express.application.handle;
const BRAND_PROFILE = loadBrandProfile();

express.application.handle = function marketingOutreachRunHandle(req, res, done) {
  const pathname = new URL(req.url, 'http://local').pathname;
  const shouldHandle =
    pathname === '/marketing' ||
    pathname === '/marketing/outreach-run' ||
    pathname === '/marketing/outreach-drafts/generate' ||
    pathname === '/api/marketing/outreach-run' ||
    pathname === '/api/marketing/outreach-items' ||
    pathname === '/api/marketing/outreach-summary' ||
    pathname === '/api/marketing/outreach-drafts/generate' ||
    pathname.match(/^\/api\/marketing\/outreach-items\/[^/]+\/generate-draft$/);

  if (shouldHandle && pathname !== '/marketing') {
    routeOutreachRun(req, res).catch((error) => {
      if (res.headersSent) return;
      const wantsJson = pathname.startsWith('/api/');
      res.statusCode = 500;
      res.setHeader('content-type', wantsJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
      res.end(wantsJson ? JSON.stringify({ ok: false, error: error.message }) : (error.stack || error.message));
    });
    return;
  }

  if (pathname === '/marketing' && req.method === 'GET') {
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const chunks = [];

    res.write = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof cb === 'function') cb();
      return true;
    };

    res.end = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      let html = Buffer.concat(chunks).toString('utf8');
      try {
        const bulkHtml = renderBulkOutreachSection();
        if (html.includes('<section class="bg-white border border-zinc-200 rounded-2xl p-6">\n      <div class="flex items-start justify-between gap-4">')) {
          html = html.replace('</section>\n    ', `</section>\n    ${bulkHtml}\n    `);
        } else if (html.includes('</main>')) {
          html = html.replace('</main>', `${bulkHtml}</main>`);
        }
      } catch (error) {
        const fallback = `<section class="bg-white border border-red-200 rounded-2xl p-6"><h2 class="font-bold text-lg">Bulk Outreach Run</h2><p class="text-sm text-red-700 mt-2">Could not load bulk outreach controls: ${esc(error.message)}</p></section>`;
        html = html.includes('</main>') ? html.replace('</main>', `${fallback}</main>`) : html;
      }
      return originalEnd(html, 'utf8', cb);
    };

    return originalHandle.call(this, req, res, done);
  }

  return originalHandle.call(this, req, res, done);
};

async function routeOutreachRun(req, res) {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  if (pathname === '/api/marketing/outreach-summary' && req.method === 'GET') {
    return sendJson(res, { ok: true, summary: getOutreachSummary() });
  }

  if (pathname === '/api/marketing/outreach-items' && req.method === 'GET') {
    const filters = Object.fromEntries(url.searchParams.entries());
    return sendJson(res, { ok: true, items: getOutreachItems(filters) });
  }

  if (pathname === '/api/marketing/outreach-run' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = await createAndMaybeGenerate(body);
    return sendJson(res, { ok: true, result });
  }

  if (pathname === '/marketing/outreach-run' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = await createAndMaybeGenerate(body);
    const message = `Outreach run created: ${result.campaign_count} campaign(s), ${result.item_count} outreach item(s)${result.generated_drafts ? `, ${result.generated_drafts} draft(s) generated` : ''}`;
    return redirect(res, `/marketing?message=${encodeURIComponent(message)}`);
  }

  if (pathname === '/api/marketing/outreach-drafts/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.campaign_id) throw new Error('campaign_id is required');
    const result = await generateDraftsForCampaign(body.campaign_id, { deterministic: parseBool(body.deterministic) });
    return sendJson(res, { ok: true, result });
  }

  if (pathname === '/marketing/outreach-drafts/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.campaign_id) throw new Error('campaign_id is required');
    const result = await generateDraftsForCampaign(body.campaign_id, { deterministic: parseBool(body.deterministic) });
    return redirect(res, `/marketing?message=${encodeURIComponent(`Generated ${result.generated} draft(s); ${result.failed} failed`)}`);
  }

  const itemDraftMatch = pathname.match(/^\/api\/marketing\/outreach-items\/([^/]+)\/generate-draft$/);
  if (itemDraftMatch && req.method === 'POST') {
    const body = await parseBody(req);
    const result = await generateDraftForOutreachItem(decodeURIComponent(itemDraftMatch[1]), { deterministic: parseBool(body.deterministic) });
    return sendJson(res, { ok: true, result });
  }

  res.statusCode = 404;
  return sendJson(res, { ok: false, error: 'Outreach route not found' });
}

async function createAndMaybeGenerate(body = {}) {
  const result = createOutreachRun({
    song_ids: body.song_ids || body.song_id || [],
    outlet_ids: resolveOutletIdsFromBody(body),
    mode: body.mode || 'single_release',
    preset: body.preset || null,
  });

  if (parseBool(body.generate_drafts)) {
    let generated = 0;
    let failed = 0;
    const draft_results = [];
    for (const campaign of result.campaigns || []) {
      const draftResult = await generateDraftsForCampaign(campaign.campaign_id, { deterministic: parseBool(body.deterministic) });
      generated += draftResult.generated || 0;
      failed += draftResult.failed || 0;
      draft_results.push(draftResult);
    }
    return { ...result, generated_drafts: generated, failed_drafts: failed, draft_results };
  }

  return result;
}

function resolveOutletIdsFromBody(body = {}) {
  const explicit = normalizeIds(body.outlet_ids || body.target_ids || body.outlets || []);
  if (explicit.length) return explicit;

  const preset = body.outlet_preset || body.preset || 'safe_p0';
  const outlets = getEligibleOutlets();
  if (preset === 'safe_p0') return outlets.filter(o => o.priority === 'P0' && o.outreach_allowed === true).map(o => o.id);
  if (preset === 'safe_p0_p1') return outlets.filter(o => ['P0', 'P1'].includes(o.priority) && o.outreach_allowed === true).map(o => o.id);
  if (preset === 'all_safe') return outlets.filter(o => o.outreach_allowed === true).map(o => o.id);
  if (preset === 'playlist') return outlets.filter(o => o.type === 'playlist' && o.outreach_allowed === true).map(o => o.id);
  if (preset === 'parent_teacher') return outlets.filter(o => ['parent_creator', 'educator'].includes(o.type) && o.outreach_allowed === true).map(o => o.id);
  return [];
}

function renderBulkOutreachSection() {
  const releases = getReleaseReadySongs();
  const outlets = getEligibleOutlets();
  const campaigns = getMarketingCampaigns(25).filter(c => c.focus_song_id);
  const summary = getOutreachSummary();

  const releaseRows = releases.map(({ song, links, hasMarketingImage }) => {
    const linkSummary = links.length
      ? links.slice(0, 3).map(l => esc(l.platform)).join(', ')
      : 'links pending';
    return `<label class="flex items-start gap-3 border border-zinc-200 rounded-lg p-3 hover:bg-zinc-50">
      <input type="checkbox" name="song_ids" value="${attr(song.id)}" class="mt-1">
      <span class="min-w-0">
        <span class="block font-semibold text-sm">${esc(song.title || song.topic || song.id)}${hasMarketingImage ? ' <span title="Marketing image available">🖼️</span>' : ''}</span>
        <span class="block text-xs text-zinc-500">${esc(song.status)} · ${esc(linkSummary)}</span>
      </span>
    </label>`;
  }).join('');

  const campaignRows = campaigns.slice(0, 8).map(c => {
    const items = getOutreachItems({ campaign_id: c.id });
    const generated = items.filter(i => i.status === 'draft_generated' || i.status === 'ready_for_gmail_draft').length;
    return `<div class="border border-zinc-200 rounded-lg p-3 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold text-sm truncate">${esc(c.name)}</div>
        <div class="text-xs text-zinc-500">${items.length} item(s) · ${generated} draft(s) generated</div>
      </div>
      <form method="POST" action="/marketing/outreach-drafts/generate">
        <input type="hidden" name="campaign_id" value="${attr(c.id)}">
        <button class="bg-zinc-900 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Generate drafts</button>
      </form>
    </div>`;
  }).join('');

  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    <div class="flex items-start justify-between gap-4 mb-5">
      <div>
        <h2 class="font-bold text-lg">Bulk Outreach Run</h2>
        <p class="text-sm text-zinc-500 mt-1">Select one or more releases, choose an email-capable outlet preset, and create review-gated outreach draft rows.</p>
      </div>
      <div class="text-right text-xs text-zinc-500">
        <div>${summary.total || 0} outreach item(s)</div>
        <div>${summary.draft_generated || 0} draft(s) generated · ${summary.requires_ken || 0} need Ken</div>
      </div>
    </div>

    <form method="POST" action="/marketing/outreach-run" class="space-y-4">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div class="font-semibold text-sm mb-2">Releases</div>
          <div class="grid grid-cols-1 gap-2 max-h-72 overflow-y-auto pr-1">
            ${releaseRows || '<div class="text-sm text-zinc-500 border border-dashed rounded-xl p-6">No release-ready songs found.</div>'}
          </div>
        </div>

        <div>
          <div class="font-semibold text-sm mb-2">Outlet group</div>
          <div class="space-y-2">
            ${presetRadio('safe_p0', `Safe P0 Launch (${outlets.filter(o => o.priority === 'P0' && o.outreach_allowed === true).length})`, true)}
            ${presetRadio('safe_p0_p1', `Safe P0 + P1 (${outlets.filter(o => ['P0', 'P1'].includes(o.priority) && o.outreach_allowed === true).length})`)}
            ${presetRadio('playlist', `Playlist / curator outlets (${outlets.filter(o => o.type === 'playlist' && o.outreach_allowed === true).length})`)}
            ${presetRadio('parent_teacher', `Parent + teacher outlets (${outlets.filter(o => ['parent_creator', 'educator'].includes(o.type) && o.outreach_allowed === true).length})`)}
            ${presetRadio('all_safe', `All safe outlets (${outlets.filter(o => o.outreach_allowed === true).length})`)}
          </div>

          <div class="mt-4 font-semibold text-sm mb-2">Mode</div>
          <div class="space-y-2">
            ${modeRadio('single_release', 'One campaign per selected release', true)}
            ${modeRadio('bundle', 'Bundle selected releases into one pitch')}
          </div>

          <label class="mt-4 flex items-start gap-2 text-sm text-zinc-700">
            <input type="checkbox" name="generate_drafts" value="true" checked class="mt-1">
            <span>Generate reviewable draft copy now using LLM when available; deterministic fallback if not</span>
          </label>
        </div>
      </div>

      <div class="flex items-center justify-between gap-3 pt-2">
        <p class="text-xs text-zinc-500">This creates draft queue rows only. It does not send email or create Gmail drafts.</p>
        <button class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Create outreach run</button>
      </div>
    </form>

    ${campaignRows ? `<div class="mt-6"><div class="font-semibold text-sm mb-2">Recent outreach campaigns</div><div class="grid grid-cols-1 lg:grid-cols-2 gap-2">${campaignRows}</div></div>` : ''}
  </section>`;
}

function presetRadio(value, label, checked = false) {
  return `<label class="flex items-center gap-2 text-sm border border-zinc-200 rounded-lg p-3 hover:bg-zinc-50"><input type="radio" name="outlet_preset" value="${attr(value)}" ${checked ? 'checked' : ''}> <span>${esc(label)}</span></label>`;
}

function modeRadio(value, label, checked = false) {
  return `<label class="flex items-center gap-2 text-sm border border-zinc-200 rounded-lg p-3 hover:bg-zinc-50"><input type="radio" name="mode" value="${attr(value)}" ${checked ? 'checked' : ''}> <span>${esc(label)}</span></label>`;
}

function getReleaseReadySongs() {
  return getMarketingReleaseEntries(50);
}

function normalizeIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  return [];
}

function parseBool(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
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
