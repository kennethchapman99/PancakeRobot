import { createRequire } from 'module';
import { getMarketingCampaigns } from '../shared/marketing-db.js';
import {
  getOutreachItems,
  getOutreachItem,
  updateOutreachItem,
} from '../shared/marketing-outreach-db.js';
import {
  generateDraftForOutreachItem,
  generateDraftsForCampaign,
} from '../agents/marketing-outreach-draft-agent.js';
import {
  createGmailDraftForOutreachItem,
  createGmailDraftsForCampaign,
} from '../agents/marketing-gmail-draft-agent.js';
import { getSong, getReleaseLinks } from '../shared/db.js';
import { loadBrandProfile } from '../shared/brand-profile.js';

const require = createRequire(import.meta.url);
const express = require('express');
const originalHandle = express.application.handle;
const BRAND_PROFILE = loadBrandProfile();

express.application.handle = function marketingCampaignDetailHandle(req, res, done) {
  const pathname = new URL(req.url, 'http://local').pathname;
  const shouldHandle =
    pathname.match(/^\/marketing\/campaigns\/[^/]+$/) ||
    pathname.match(/^\/marketing\/campaigns\/[^/]+\/generate-drafts$/) ||
    pathname.match(/^\/marketing\/campaigns\/[^/]+\/gmail-drafts$/) ||
    pathname.match(/^\/marketing\/campaigns\/[^/]+\/items\/[^/]+\/update$/) ||
    pathname.match(/^\/marketing\/campaigns\/[^/]+\/items\/[^/]+\/generate-draft$/) ||
    pathname.match(/^\/marketing\/campaigns\/[^/]+\/items\/[^/]+\/gmail-draft$/) ||
    pathname.match(/^\/marketing\/campaigns\/[^/]+\/items\/[^/]+\/manual-submitted$/);

  if (shouldHandle) {
    routeCampaignDetail(req, res).catch((error) => {
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(shell('Campaign error', `<main class="p-8"><div class="bg-white border border-red-200 rounded-2xl p-6"><h1 class="font-bold text-xl">Campaign error</h1><pre class="mt-4 whitespace-pre-wrap text-sm text-red-700">${esc(error.stack || error.message)}</pre><a href="/marketing" class="inline-block mt-4 text-blue-600 hover:underline">Back to Marketing</a></div></main>`));
    });
    return;
  }

  return originalHandle.call(this, req, res, done);
};

async function routeCampaignDetail(req, res) {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  const campaignId = decodeURIComponent(pathname.split('/')[3] || '');
  const campaign = findCampaign(campaignId);
  if (!campaign) {
    res.statusCode = 404;
    return sendHtml(res, shell('Campaign not found', `<main class="p-8"><div class="bg-white border border-zinc-200 rounded-2xl p-6"><h1 class="font-bold text-xl">Campaign not found</h1><a href="/marketing" class="inline-block mt-4 text-blue-600 hover:underline">Back to Marketing</a></div></main>`));
  }

  if (pathname.match(/^\/marketing\/campaigns\/[^/]+$/) && req.method === 'GET') {
    return sendHtml(res, renderCampaignDetailPage(campaign, {
      message: url.searchParams.get('message') || '',
      error: url.searchParams.get('error') || '',
    }));
  }

  if (pathname.match(/^\/marketing\/campaigns\/[^/]+\/generate-drafts$/) && req.method === 'POST') {
    const result = await generateDraftsForCampaign(campaign.id);
    return redirect(res, campaignUrl(campaign.id, `Generated ${result.generated} draft(s); ${result.failed} failed`));
  }

  if (pathname.match(/^\/marketing\/campaigns\/[^/]+\/gmail-drafts$/) && req.method === 'POST') {
    const result = await createGmailDraftsForCampaign(campaign.id);
    return redirect(res, campaignUrl(campaign.id, `Gmail drafts: ${result.created} created, ${result.blocked} blocked, ${result.failed} failed`));
  }

  const itemUpdate = pathname.match(/^\/marketing\/campaigns\/[^/]+\/items\/([^/]+)\/update$/);
  if (itemUpdate && req.method === 'POST') {
    const itemId = decodeURIComponent(itemUpdate[1]);
    ensureItemBelongsToCampaign(itemId, campaign.id);
    const body = await parseBody(req);
    updateOutreachItem(itemId, {
      subject: body.subject || null,
      body: body.body || null,
      status: body.status || 'draft_generated',
      safety_notes: body.safety_notes || null,
      safety_status: body.safety_status || 'ken_reviewed',
      requires_ken: true,
    });
    return redirect(res, campaignUrl(campaign.id, 'Draft updated'));
  }

  const itemGenerate = pathname.match(/^\/marketing\/campaigns\/[^/]+\/items\/([^/]+)\/generate-draft$/);
  if (itemGenerate && req.method === 'POST') {
    const itemId = decodeURIComponent(itemGenerate[1]);
    ensureItemBelongsToCampaign(itemId, campaign.id);
    await generateDraftForOutreachItem(itemId);
    return redirect(res, campaignUrl(campaign.id, 'Draft regenerated'));
  }

  const itemGmail = pathname.match(/^\/marketing\/campaigns\/[^/]+\/items\/([^/]+)\/gmail-draft$/);
  if (itemGmail && req.method === 'POST') {
    const itemId = decodeURIComponent(itemGmail[1]);
    ensureItemBelongsToCampaign(itemId, campaign.id);
    const result = await createGmailDraftForOutreachItem(itemId);
    if (result.ok) return redirect(res, campaignUrl(campaign.id, 'Gmail draft created'));
    return redirect(res, campaignUrl(campaign.id, `Gmail draft blocked: ${(result.notes || []).join('; ')}`, 'error'));
  }

  const itemManual = pathname.match(/^\/marketing\/campaigns\/[^/]+\/items\/([^/]+)\/manual-submitted$/);
  if (itemManual && req.method === 'POST') {
    const itemId = decodeURIComponent(itemManual[1]);
    ensureItemBelongsToCampaign(itemId, campaign.id);
    const body = await parseBody(req);
    const existing = getOutreachItem(itemId);
    updateOutreachItem(itemId, {
      status: 'manual_submitted',
      safety_status: 'manual_submitted',
      safety_notes: appendNote(existing?.safety_notes, body.note || 'Marked manually submitted'),
      requires_ken: false,
    });
    return redirect(res, campaignUrl(campaign.id, 'Marked manually submitted'));
  }

  res.statusCode = 405;
  return sendHtml(res, shell('Method not allowed', `<main class="p-8">Method not allowed</main>`));
}

function renderCampaignDetailPage(campaign, { message, error }) {
  const items = getOutreachItems({ campaign_id: campaign.id });
  const song = campaign.focus_song_id ? getSong(campaign.focus_song_id) : null;
  const links = campaign.focus_song_id ? getReleaseLinks(campaign.focus_song_id) : [];
  const stats = summarizeItems(items);

  const rows = items.length
    ? items.map(item => renderItemCard(campaign, item)).join('')
    : '<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No outreach items found for this campaign.</div>';

  const linksHtml = links.length
    ? links.map(l => `<a href="${attr(l.url)}" target="_blank" rel="noopener noreferrer" class="text-xs text-blue-600 hover:underline">${esc(l.platform)}</a>`).join(' &middot; ')
    : '<span class="text-xs text-zinc-400">No release links captured</span>';

  const body = `<main class="p-8 space-y-6">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <a href="/marketing" class="text-sm text-blue-600 hover:underline">← Back to Marketing</a>
          <h1 class="text-3xl font-extrabold mt-2">${esc(campaign.name)}</h1>
          <p class="text-sm text-zinc-500 mt-2">${esc(campaign.objective || '')}</p>
          <div class="mt-2 text-xs text-zinc-500">Focus release: <span class="font-semibold text-zinc-700">${esc(song?.title || song?.topic || campaign.focus_song_id || '—')}</span> · ${linksHtml}</div>
        </div>
        <div class="flex flex-wrap gap-2">
          <form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/generate-drafts">
            <button class="bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm font-semibold">Generate all drafts</button>
          </form>
          <form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/gmail-drafts">
            <button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Create Gmail drafts</button>
          </form>
        </div>
      </div>
    </section>

    ${message ? banner(message, 'emerald') : ''}${error ? banner(error, 'red') : ''}

    <section class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
      ${statCard('Items', stats.total)}
      ${statCard('Queued', stats.queued)}
      ${statCard('Drafted', stats.draft_generated)}
      ${statCard('Gmail', stats.gmail_draft_created)}
      ${statCard('Manual', stats.manual_submitted)}
      ${statCard('Needs Ken', stats.needs_ken)}
      ${statCard('Blocked', stats.blocked)}
      ${statCard('With Email', stats.with_email)}
    </section>

    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 class="font-bold text-lg">Outlet Outreach Items</h2>
          <p class="text-sm text-zinc-500 mt-1">Review/edit each outlet draft before creating Gmail drafts or marking manual submission.</p>
        </div>
      </div>
      <div class="space-y-4">${rows}</div>
    </section>
  </main>`;

  return shell('Marketing Campaign', body);
}

function renderItemCard(campaign, item) {
  const email = item.outlet_context?.contact_email || item.outlet_context?.contact?.email || '';
  const hasDraft = Boolean(item.subject && item.body);
  const canGmailDraft = hasDraft && email && item.status !== 'gmail_draft_created' && item.outlet_context?.ai_policy !== 'banned';
  const gmailInfo = item.gmail_draft_id
    ? `<a href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noopener noreferrer" class="text-xs text-blue-600 hover:underline">Open Gmail drafts</a><span class="text-xs text-zinc-400 ml-2">${esc(item.gmail_draft_id)}</span>`
    : '<span class="text-xs text-zinc-400">No Gmail draft yet</span>';

  const releaseList = (item.release_context || [])
    .map(r => `<li>${esc(r.title || r.topic || r.id)}</li>`)
    .join('');

  return `<article class="border border-zinc-200 rounded-xl p-4">
    <div class="flex flex-wrap items-start justify-between gap-4 mb-4">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-bold text-base">${esc(item.outlet_name || item.target_id)}</h3>
          <span class="${statusBadge(item.status)}">${esc(item.status)}</span>
          <span class="${safetyBadge(item.safety_status)}">${esc(item.safety_status || 'pending')}</span>
        </div>
        <div class="mt-1 text-xs text-zinc-500">
          ${email ? `Email: <span class="font-semibold text-zinc-700">${esc(email)}</span>` : '<span class="text-amber-700">No email; likely manual/contact-form submission</span>'}
          · AI policy: ${esc(item.outlet_context?.ai_policy || 'unknown')}
          · ${gmailInfo}
        </div>
        ${releaseList ? `<ul class="mt-2 text-xs text-zinc-500 list-disc list-inside">${releaseList}</ul>` : ''}
      </div>
      <div class="flex flex-wrap gap-2">
        <form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/items/${attr(item.id)}/generate-draft">
          <button class="bg-zinc-900 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Regenerate</button>
        </form>
        <form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/items/${attr(item.id)}/gmail-draft">
          <button class="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-semibold ${canGmailDraft ? '' : 'opacity-50 cursor-not-allowed'}" ${canGmailDraft ? '' : 'disabled'}>Create Gmail draft</button>
        </form>
      </div>
    </div>

    <form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/items/${attr(item.id)}/update" class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="space-y-3">
        <label class="block text-xs font-semibold text-zinc-500 uppercase">Subject</label>
        <input name="subject" value="${attr(item.subject || '')}" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">

        <label class="block text-xs font-semibold text-zinc-500 uppercase">Status</label>
        <select name="status" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
          ${statusOption('queued', item.status)}
          ${statusOption('draft_generated', item.status)}
          ${statusOption('needs_ken', item.status)}
          ${statusOption('ready_for_gmail_draft', item.status)}
          ${statusOption('gmail_draft_created', item.status)}
          ${statusOption('manual_submitted', item.status)}
          ${statusOption('do_not_contact', item.status)}
        </select>

        <label class="block text-xs font-semibold text-zinc-500 uppercase">Safety notes</label>
        <textarea name="safety_notes" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-xs min-h-24">${esc(item.safety_notes || '')}</textarea>
        <input type="hidden" name="safety_status" value="ken_reviewed">

        <div class="flex gap-2">
          <button class="bg-emerald-600 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Save edits</button>
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold text-zinc-500 uppercase mb-2">Body</label>
        <textarea name="body" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm font-mono min-h-80">${esc(item.body || '')}</textarea>
      </div>
    </form>

    <form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/items/${attr(item.id)}/manual-submitted" class="mt-3 flex flex-wrap gap-2 items-center">
      <input name="note" placeholder="Manual submission note, e.g. submitted via contact form" class="flex-1 min-w-64 border border-zinc-200 rounded-lg px-3 py-2 text-xs">
      <button class="border border-zinc-300 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-zinc-50">Mark manual submitted</button>
    </form>
  </article>`;
}

function findCampaign(id) {
  return getMarketingCampaigns(500).find(c => c.id === id);
}

function ensureItemBelongsToCampaign(itemId, campaignId) {
  const item = getOutreachItem(itemId);
  if (!item) throw new Error(`Outreach item not found: ${itemId}`);
  if (item.campaign_id !== campaignId) throw new Error('Outreach item does not belong to this campaign');
  return item;
}

function summarizeItems(items) {
  return {
    total: items.length,
    queued: count(items, i => i.status === 'queued'),
    draft_generated: count(items, i => ['draft_generated', 'ready_for_gmail_draft'].includes(i.status)),
    gmail_draft_created: count(items, i => i.status === 'gmail_draft_created'),
    manual_submitted: count(items, i => i.status === 'manual_submitted'),
    needs_ken: count(items, i => i.requires_ken || i.status === 'needs_ken'),
    blocked: count(items, i => String(i.safety_status || '').includes('blocked') || i.status === 'do_not_contact'),
    with_email: count(items, i => Boolean(i.outlet_context?.contact_email || i.outlet_context?.contact?.email)),
  };
}

function count(items, fn) {
  return items.filter(fn).length;
}

function statusOption(value, selected) {
  return `<option value="${attr(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`;
}

function statCard(label, value) {
  return `<div class="bg-white border border-zinc-200 rounded-xl p-4"><div class="text-2xl font-extrabold">${esc(value)}</div><div class="text-xs text-zinc-500 mt-1">${esc(label)}</div></div>`;
}

function statusBadge(status) {
  const good = ['gmail_draft_created', 'manual_submitted', 'sent', 'replied'];
  const warn = ['queued', 'draft_generated', 'ready_for_gmail_draft'];
  const cls = good.includes(status)
    ? 'bg-emerald-50 text-emerald-700'
    : warn.includes(status)
      ? 'bg-blue-50 text-blue-700'
      : 'bg-amber-50 text-amber-700';
  return `inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`;
}

function safetyBadge(status) {
  const s = String(status || 'pending');
  const cls = s.includes('blocked') || s.includes('error') || s.includes('missing')
    ? 'bg-red-50 text-red-700'
    : s.includes('passed') || s.includes('created') || s.includes('submitted')
      ? 'bg-emerald-50 text-emerald-700'
      : 'bg-amber-50 text-amber-700';
  return `inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`;
}

function appendNote(existing, next) {
  return [existing, next].filter(Boolean).join('\n');
}

function campaignUrl(campaignId, text, key = 'message') {
  return `/marketing/campaigns/${encodeURIComponent(campaignId)}?${key}=${encodeURIComponent(text)}`;
}

function banner(text, color) {
  const classes = color === 'red'
    ? 'border-red-200 bg-red-50 text-red-800'
    : 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return `<div class="rounded-xl border ${classes} px-4 py-3 text-sm">${esc(text)}</div>`;
}

function shell(title, body) {
  const appTitle = BRAND_PROFILE.app_title || BRAND_PROFILE.brand_name || 'Music Pipeline';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ${esc(appTitle)}</title><link rel="icon" href="/logo.png"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-zinc-50 text-zinc-900"><div class="flex min-h-screen"><nav class="w-56 bg-zinc-900 text-zinc-100 p-4"><img src="/logo.png" class="w-32 h-32 object-contain mx-auto"><div class="mt-5 space-y-1"><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/">Dashboard</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas/generate">Generate Ideas</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas">Idea Vault</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/songs">Song Catalog</a><a class="block rounded-lg px-3 py-2 bg-zinc-700 text-white" href="/marketing">Marketing</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/brand">Brand</a></div></nav><div class="flex-1">${body}</div></div></body></html>`;
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
