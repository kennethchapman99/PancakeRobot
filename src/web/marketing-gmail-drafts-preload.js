import { createRequire } from 'module';
import {
  createGmailDraftForOutreachItem,
  createGmailDraftsForCampaign,
} from '../agents/marketing-gmail-draft-agent.js';
import { getOutreachItems, getOutreachSummary } from '../shared/marketing-outreach-db.js';
import { getMarketingCampaigns } from '../shared/marketing-db.js';
import { loadBrandProfile } from '../shared/brand-profile.js';

const require = createRequire(import.meta.url);
const express = require('express');
const originalHandle = express.application.handle;
const BRAND_PROFILE = loadBrandProfile();

express.application.handle = function marketingGmailDraftsHandle(req, res, done) {
  const pathname = new URL(req.url, 'http://local').pathname;
  const shouldHandleRoute =
    pathname === '/api/marketing/gmail-drafts/campaign' ||
    pathname === '/marketing/gmail-drafts/campaign' ||
    pathname.match(/^\/api\/marketing\/gmail-drafts\/item\/[^/]+$/);

  if (shouldHandleRoute) {
    routeGmailDrafts(req, res).catch((error) => {
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
        const section = renderGmailDraftQueueSection();
        if (html.includes('</main>')) {
          html = html.replace('</main>', `${section}</main>`);
        } else if (html.includes('</body>')) {
          html = html.replace('</body>', `${section}</body>`);
        }
      } catch (error) {
        const fallback = `<section class="bg-white border border-red-200 rounded-2xl p-6"><h2 class="font-bold text-lg">Gmail Draft Queue</h2><p class="text-sm text-red-700 mt-2">Could not load Gmail draft queue: ${esc(error.message)}</p></section>`;
        html = html.includes('</main>') ? html.replace('</main>', `${fallback}</main>`) : html;
      }

      return originalEnd(html, 'utf8', cb);
    };

    return originalHandle.call(this, req, res, done);
  }

  return originalHandle.call(this, req, res, done);
};

async function routeGmailDrafts(req, res) {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  if (pathname === '/api/marketing/gmail-drafts/campaign' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.campaign_id) throw new Error('campaign_id is required');
    const result = await createGmailDraftsForCampaign(body.campaign_id);
    return sendJson(res, { ok: true, result });
  }

  if (pathname === '/marketing/gmail-drafts/campaign' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.campaign_id) throw new Error('campaign_id is required');
    const result = await createGmailDraftsForCampaign(body.campaign_id);
    const message = `Gmail drafts: ${result.created} created, ${result.blocked} blocked, ${result.failed} failed`;
    return redirect(res, `/marketing?message=${encodeURIComponent(message)}`);
  }

  const itemMatch = pathname.match(/^\/api\/marketing\/gmail-drafts\/item\/([^/]+)$/);
  if (itemMatch && req.method === 'POST') {
    const result = await createGmailDraftForOutreachItem(decodeURIComponent(itemMatch[1]));
    return sendJson(res, { ok: true, result });
  }

  res.statusCode = 404;
  return sendJson(res, { ok: false, error: 'Gmail draft route not found' });
}

function renderGmailDraftQueueSection() {
  const summary = getOutreachSummary();
  const campaigns = getMarketingCampaigns(50).filter(c => c.focus_song_id);
  const rows = campaigns
    .map(campaign => ({ campaign, items: getOutreachItems({ campaign_id: campaign.id }) }))
    .filter(entry => entry.items.length > 0)
    .slice(0, 12)
    .map(renderCampaignDraftRow)
    .join('');

  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    <div class="flex items-start justify-between gap-4 mb-5">
      <div>
        <h2 class="font-bold text-lg">Gmail Draft Queue</h2>
        <p class="text-sm text-zinc-500 mt-1">Creates Gmail drafts only. Nothing is sent automatically.</p>
      </div>
      <div class="text-right text-xs text-zinc-500">
        <div>${summary.gmail_draft_created || 0} Gmail draft(s) created</div>
        <div>${summary.draft_generated || 0} generated draft(s) · ${summary.requires_ken || 0} need Ken</div>
      </div>
    </div>
    ${rows ? `<div class="space-y-2">${rows}</div>` : '<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No outreach items yet. Create an outreach run first.</div>'}
    <div class="mt-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-800">
      Gmail draft creation requires re-authorizing Gmail with compose scope: <code class="font-mono">npm run marketing:gmail:reauth</code>.
    </div>
  </section>`;
}

function renderCampaignDraftRow({ campaign, items }) {
  const generated = items.filter(i => i.status === 'draft_generated' || i.status === 'ready_for_gmail_draft').length;
  const created = items.filter(i => i.status === 'gmail_draft_created').length;
  const blocked = items.filter(i => i.safety_status === 'gmail_draft_blocked' || i.status === 'needs_ken').length;
  const withEmail = items.filter(i => i.outlet_context?.contact_email || i.outlet_context?.contact?.email).length;
  const ready = items.filter(i => i.subject && i.body && i.status !== 'gmail_draft_created').length;

  const itemPreview = items.slice(0, 4).map(item => {
    const statusClass = item.status === 'gmail_draft_created'
      ? 'bg-emerald-50 text-emerald-700'
      : item.subject && item.body
        ? 'bg-blue-50 text-blue-700'
        : 'bg-amber-50 text-amber-700';
    return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] ${statusClass}">${esc(item.outlet_name || item.target_id)} · ${esc(item.status)}</span>`;
  }).join(' ');

  return `<div class="border border-zinc-200 rounded-xl p-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <a href="/marketing/campaigns/${attr(campaign.id)}" class="font-semibold text-sm truncate text-blue-700 hover:underline block">${esc(campaign.name)}</a>
        <div class="text-xs text-zinc-500 mt-1">${items.length} item(s) · ${generated} generated · ${created} Gmail draft(s) · ${withEmail} with email · ${blocked} blocked/needs review</div>
        <div class="mt-2 flex flex-wrap gap-1">${itemPreview}</div>
      </div>
      <div class="flex gap-2 shrink-0">
        <a href="/marketing/campaigns/${attr(campaign.id)}" class="border border-zinc-300 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-zinc-50">Open</a>
        <form method="POST" action="/marketing/outreach-drafts/generate">
          <input type="hidden" name="campaign_id" value="${attr(campaign.id)}">
          <button class="bg-zinc-900 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Generate drafts</button>
        </form>
        <form method="POST" action="/marketing/gmail-drafts/campaign">
          <input type="hidden" name="campaign_id" value="${attr(campaign.id)}">
          <button class="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-semibold" ${ready === 0 ? 'disabled title="Generate drafts first"' : ''}>Create Gmail drafts</button>
        </form>
      </div>
    </div>
  </div>`;
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
