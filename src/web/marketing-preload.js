import { createRequire } from 'module';
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
import { getInboxMessages, getInboxSummary } from '../shared/marketing-inbox-db.js';

const BRAND_PROFILE = loadBrandProfile();

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
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || '',
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

function renderMarketingPage({ q, status, message, error }) {
  const summary = getMarketingSummary();
  const setup = getMarketingSetupItems();
  const targets = getMarketingTargets({ q, status });
  const campaigns = getMarketingCampaigns(10);
  const runs = getMarketingAgentRuns(10);
  const latestLogs = runs[0] ? getMarketingAgentLogs(runs[0].id) : [];
  const setupGroups = groupBy(setup, 'category');
  const setupPct = summary.setup.total ? Math.round(((summary.setup.done || 0) / summary.setup.total) * 100) : 0;
  const brandProfileId = getActiveProfileId();

  let targetStats = null;
  try { targetStats = getMarketingTargetStats(brandProfileId); } catch {}

  let inboxMessages = [];
  let inboxSummary = null;
  try { inboxMessages = getInboxMessages(20); inboxSummary = getInboxSummary(); } catch {}

  const body = `
  <main class="p-8 space-y-8">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-start justify-between gap-4">
        <div><h1 class="text-3xl font-extrabold">Marketing Mission Control</h1><p class="text-zinc-500 mt-2">Brand-level target library, inbox monitoring, release planning. No fake targets. No auto-sending.</p></div>
        <div class="flex gap-2 flex-wrap">
          <form method="POST" action="/marketing/agents/research-import"><button class="bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm font-semibold">Import targets</button></form>
          <form method="POST" action="/marketing/agents/draft-campaign"><button class="bg-amber-500 text-white rounded-lg px-4 py-2 text-sm font-semibold">Create draft campaign</button></form>
          <form method="POST" action="/marketing/agents/inbox-scan"><button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Scan Gmail inbox</button></form>
        </div>
      </div>
    </section>
    ${message ? banner(message, 'emerald') : ''}${error ? banner(error, 'red') : ''}

    <!-- Metrics row -->
    <section class="grid grid-cols-2 lg:grid-cols-6 gap-4">
      ${metric(summary.setup.done || 0, 'Setup done')} ${metric(`${setupPct}%`, 'Setup progress')} ${metric(targetStats?.total || summary.targets.total || 0, 'Sourced targets')} ${metric(targetStats?.approved || summary.targets.approved || 0, 'Approved targets')} ${metric(inboxSummary?.new_count || 0, 'New inbox')} ${metric(inboxSummary?.needs_ken || 0, 'Needs Ken')}
    </section>

    <!-- Setup + Readiness -->
    <section class="grid grid-cols-1 xl:grid-cols-3 gap-6">
      <div class="xl:col-span-2 bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold mb-4">Human setup checklist</h2>${Object.entries(setupGroups).map(([category, items]) => `<h3 class="text-xs uppercase tracking-widest text-zinc-400 mt-6 mb-2">${esc(category)}</h3>${items.map(renderSetup).join('')}`).join('')}</div>
      <aside class="space-y-6"><div class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold">Workflow readiness</h2><ol class="text-sm text-zinc-600 mt-3 list-decimal pl-5 space-y-2"><li>Complete setup checklist.</li><li>Set MARKETING_RESEARCH_SOURCE_PATH.</li><li>Import &amp; approve targets.</li><li>Authorize Gmail (npm run marketing:gmail:auth).</li><li>Scan inbox to classify messages.</li><li>Match targets for a song release.</li><li>Create release plan.</li></ol><div class="mt-4 text-xs bg-zinc-50 border border-zinc-200 rounded-lg p-3 break-all">${esc(process.env.MARKETING_RESEARCH_SOURCE_PATH || 'MARKETING_RESEARCH_SOURCE_PATH not configured')}</div></div>${renderTargetForm()}</aside>
    </section>

    <!-- Target Intelligence Library -->
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 class="font-bold">Target Intelligence Library</h2>
          <p class="text-sm text-zinc-500 mt-1">Brand: <code class="font-mono text-xs">${esc(brandProfileId)}</code></p>
        </div>
        <div class="flex gap-2">
          <form method="GET" action="/marketing" class="flex gap-2">
            <input name="q" value="${attr(q)}" placeholder="Search targets" class="border rounded-lg px-3 py-2 text-sm">
            <select name="status" class="border rounded-lg px-3 py-2 text-sm">${opt('', 'All', status)}${opt('needs_review', 'Needs review', status)}${opt('approved', 'Approved', status)}${opt('rejected', 'Rejected', status)}${opt('do_not_contact', 'DNC', status)}</select>
            <button class="bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm">Filter</button>
          </form>
        </div>
      </div>
      ${targetStats ? `<div class="grid grid-cols-2 lg:grid-cols-7 gap-3 mb-6">${metricSmall(targetStats.total||0,'Total')}${metricSmall(targetStats.approved||0,'Approved')}${metricSmall(targetStats.needs_review||0,'Needs review')}${metricSmall(targetStats.stale||0,'Stale')}${metricSmall(targetStats.rejected||0,'Rejected')}${metricSmall(targetStats.do_not_contact||0,'DNC')}${metricSmall(targetStats.ai_allowed||0,'AI: allowed')}</div>` : ''}
      ${targets.length ? renderTargets(targets) : '<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No sourced targets yet. Run: npm run marketing:targets:import -- --source /path/to/targets.json</div>'}
    </section>

    <!-- Marketing Inbox -->
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 class="font-bold">Marketing Inbox</h2>
          <p class="text-sm text-zinc-500">Classified Gmail messages — read-only. No sending or deleting.</p>
        </div>
        <form method="POST" action="/marketing/agents/inbox-scan">
          <button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Scan Inbox</button>
        </form>
      </div>
      ${inboxMessages.length ? renderInbox(inboxMessages) : '<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No inbox messages. Run: npm run marketing:gmail:auth &amp; npm run marketing:gmail:scan -- --write</div>'}
    </section>

    <!-- Draft campaigns -->
    <section class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold mb-4">Draft campaigns</h2>${campaigns.length ? campaigns.map(renderCampaign).join('') : '<div class="border border-dashed rounded-xl p-6 text-center text-zinc-500">No draft campaigns yet.</div>'}</section>

    <!-- Agent runs + logs -->
    <section class="grid grid-cols-1 xl:grid-cols-2 gap-6"><div class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold mb-4">Recent agent runs</h2>${runs.length ? runs.map(renderRun).join('') : '<div class="text-zinc-400 text-sm">No runs yet.</div>'}</div><div class="bg-zinc-900 text-zinc-100 rounded-2xl p-6"><h2 class="font-bold mb-4">Latest run logs</h2><div class="font-mono text-xs space-y-2 max-h-96 overflow-y-auto">${latestLogs.length ? latestLogs.map(l => `<div><span class="text-zinc-500">${esc(l.level)}</span> ${esc(l.message)}</div>`).join('') : '<div class="text-zinc-500">No logs yet.</div>'}</div></div></section>
  </main>`;
  return shell('Marketing', body);
}

function renderInbox(messages) {
  return `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-xs uppercase text-zinc-400 border-b"><tr><th class="py-3 pr-4">Subject</th><th class="py-3 pr-4">From</th><th class="py-3 pr-4">Classification</th><th class="py-3 pr-4">Needs Ken</th><th class="py-3 pr-4">Date</th></tr></thead><tbody class="divide-y">${messages.map(m => `<tr class="align-top"><td class="py-3 pr-4 font-medium">${esc(m.subject || '(no subject)')}</td><td class="py-3 pr-4 text-zinc-500 text-xs">${esc(m.from_email || '')}</td><td class="py-3 pr-4"><span class="${inboxBadge(m.classification)}">${esc(m.classification)}</span></td><td class="py-3 pr-4">${m.requires_ken ? '<span class="text-amber-600 font-semibold text-xs">⚠ Yes</span>' : '<span class="text-zinc-300 text-xs">No</span>'}</td><td class="py-3 pr-4 text-zinc-400 text-xs">${m.received_at ? new Date(m.received_at).toLocaleDateString() : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderSetup(item) {
  const done = item.status === 'done';
  return `<form method="POST" action="/marketing/setup/${encodeURIComponent(item.key)}" class="border ${done ? 'border-emerald-200 bg-emerald-50' : 'border-zinc-200 bg-white'} rounded-xl p-4 mb-3"><div class="flex gap-3"><input type="checkbox" ${done ? 'checked' : ''} onchange="this.form.status.value=this.checked?'done':'not_started';this.form.submit()"><div class="flex-1"><div class="font-semibold">${esc(item.title)} <span class="${badge(item.status)}">${esc(item.status)}</span></div><p class="text-sm text-zinc-500 mt-1">${esc(item.instructions || '')}</p>${item.reference_url ? `<a href="${attr(item.reference_url)}" target="_blank" class="text-xs text-blue-600">Instructions/source</a>` : ''}<div class="grid grid-cols-1 lg:grid-cols-2 gap-2 mt-3"><input name="value" value="${attr(item.value || '')}" placeholder="Account, URL, handle, or config" class="border rounded-lg px-3 py-2 text-sm"><input name="notes" value="${attr(item.notes || '')}" placeholder="Notes" class="border rounded-lg px-3 py-2 text-sm"></div><input type="hidden" name="status" value="${attr(item.status || 'not_started')}"><button class="mt-2 bg-zinc-900 text-white rounded-lg px-3 py-1.5 text-xs">Save</button></div></div></form>`;
}

function renderTargetForm() {
  return `<div class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold">Add manual target</h2><p class="text-sm text-zinc-500 mt-1">A source URL is required.</p><form method="POST" action="/marketing/targets" class="mt-4 space-y-3"><input required name="name" placeholder="Name" class="w-full border rounded-lg px-3 py-2 text-sm"><select required name="type" class="w-full border rounded-lg px-3 py-2 text-sm"><option value="">Type</option><option value="playlist">Playlist</option><option value="influencer">Influencer</option><option value="blog">Blog / media</option><option value="radio">Radio / audio</option><option value="community">Community</option></select><input required name="source_url" placeholder="Source URL" class="w-full border rounded-lg px-3 py-2 text-sm"><input name="platform" placeholder="Platform" class="w-full border rounded-lg px-3 py-2 text-sm"><input name="submission_url" placeholder="Submission/contact URL" class="w-full border rounded-lg px-3 py-2 text-sm"><select name="ai_policy" class="w-full border rounded-lg px-3 py-2 text-sm"><option value="unclear">AI unclear</option><option value="allowed">AI allowed</option><option value="disclosure_required">Disclosure required</option><option value="individual_curator_choice">Curator choice</option><option value="likely_hostile">Likely hostile</option><option value="banned">Banned</option></select><textarea name="research_summary" rows="3" placeholder="Research summary" class="w-full border rounded-lg px-3 py-2 text-sm"></textarea><button class="w-full bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm font-semibold">Add sourced target</button></form></div>`;
}

function renderCampaign(c) { return `<div class="border rounded-xl p-4 mb-3"><div class="flex items-start justify-between gap-3"><div><div class="font-semibold">${esc(c.name)}</div><div class="text-sm text-zinc-500 mt-1">${esc(c.objective || '')}</div><div class="text-xs text-zinc-400 mt-2">Focus song: ${esc(c.focus_song_id || 'none')} | targets: ${esc((c.approved_target_ids || []).length)}</div></div><span class="${badge(c.status)}">${esc(c.status)}</span></div></div>`; }

function renderTargets(targets) {
  return `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-xs uppercase text-zinc-400 border-b"><tr><th class="py-3 pr-4">Target</th><th class="py-3 pr-4">Type</th><th class="py-3 pr-4">AI policy</th><th class="py-3 pr-4">Research</th><th class="py-3 pr-4">Status</th><th class="py-3 pr-4">Action</th></tr></thead><tbody class="divide-y">${targets.map(t => `<tr class="align-top"><td class="py-4 pr-4"><div class="font-semibold">${esc(t.name)}</div><div class="text-xs text-zinc-400">${esc(t.platform || '')}</div><a href="${attr(t.source_url)}" target="_blank" class="text-xs text-blue-600">source</a>${t.submission_url ? ` <a href="${attr(t.submission_url)}" target="_blank" class="text-xs text-blue-600">submit/contact</a>` : ''}</td><td class="py-4 pr-4">${esc(t.type)}</td><td class="py-4 pr-4">${esc(t.ai_policy || 'unclear')}</td><td class="py-4 pr-4 max-w-xl text-zinc-600">${esc(t.research_summary || '')}</td><td class="py-4 pr-4"><span class="${badge(t.status)}">${esc(t.status)}</span></td><td class="py-4 pr-4"><form method="POST" action="/marketing/targets/${encodeURIComponent(t.id)}/status" class="space-y-2"><select name="status" class="border rounded-lg px-2 py-1 text-xs">${opt('needs_review', 'Needs review', t.status)}${opt('approved', 'Approve', t.status)}${opt('rejected', 'Reject', t.status)}</select><input name="notes" value="${attr(t.notes || '')}" placeholder="Notes" class="border rounded-lg px-2 py-1 text-xs"><button class="bg-zinc-900 text-white rounded-lg px-3 py-1 text-xs">Save</button></form></td></tr>`).join('')}</tbody></table></div>`;
}

function renderRun(run) { return `<div class="border rounded-xl p-4 mb-3"><div class="font-semibold">${esc(run.run_type)} <span class="${badge(run.status)}">${esc(run.status)}</span></div><div class="text-xs text-zinc-400">${esc(run.agent_name)} — ${esc(run.id)}</div>${run.error ? `<div class="text-xs text-red-600 mt-2">${esc(run.error)}</div>` : ''}</div>`; }
function metricSmall(value, label) { return `<div class="bg-zinc-50 rounded-lg border border-zinc-200 p-3"><div class="text-xl font-bold">${esc(value)}</div><div class="text-xs text-zinc-500 mt-0.5">${esc(label)}</div></div>`; }
function inboxBadge(cls) { const map = { do_not_contact:'bg-red-100 text-red-700', safe_reply_candidate:'bg-emerald-100 text-emerald-700', opportunity:'bg-amber-100 text-amber-700', submission_confirmation:'bg-blue-100 text-blue-700', vendor_spam:'bg-zinc-100 text-zinc-500', needs_ken:'bg-orange-100 text-orange-700', creator_reply:'bg-violet-100 text-violet-700', playlist_reply:'bg-indigo-100 text-indigo-700', blog_media_reply:'bg-sky-100 text-sky-700' }; return `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[cls]||'bg-zinc-100 text-zinc-600'}`; }
function metric(value, label) { return `<div class="bg-white rounded-xl border border-zinc-200 p-5"><div class="text-3xl font-bold">${esc(value)}</div><div class="text-sm text-zinc-500 mt-1">${esc(label)}</div></div>`; }
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
