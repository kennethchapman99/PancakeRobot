import { getAllSongs, getReleaseLinks } from '../../../shared/db.js';
import { getMarketingCampaigns } from '../../../shared/marketing-db.js';
import { getOutreachItems, getOutreachSummary } from '../../../shared/marketing-outreach-db.js';
import { getInboxMessages, getInboxSummary } from '../../../shared/marketing-inbox-db.js';
import { getEligibleOutlets } from '../../../agents/marketing-outreach-run-agent.js';
import { renderMarketingLayout } from '../views/layout.js';
import { banner, emptyBox, presetRadio, modeRadio } from '../views/helpers.js';
import { esc, attr, redirect, readBody } from '../utils/http.js';
import { createAndMaybeGenerate } from './api-controller.js';

export function renderMarketingDashboard(req, res) {
  const releases = releaseReadySongs();
  const outlets = getEligibleOutlets();
  const campaigns = getMarketingCampaigns(50).filter(c => c.focus_song_id);
  const outreachSummary = getOutreachSummary();
  const inbox = safeInbox();

  const body = `<main class="p-8 space-y-8">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-start justify-between gap-4">
        <div><h1 class="text-3xl font-extrabold">Marketing Mission Control</h1><p class="text-sm text-zinc-500 mt-2">Release outreach, Gmail draft queue, and inbound triage.</p></div>
        <form method="POST" action="/marketing/agents/inbox-scan"><button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Scan Gmail inbox</button></form>
      </div>
    </section>
    ${banner(req.query.message)}${banner(req.query.error, 'error')}
    ${renderBulkOutreach(releases, outlets, outreachSummary)}
    ${renderCampaignList(campaigns)}
    ${renderInboxTriage(inbox)}
  </main>`;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout('Marketing', body));
}

export async function postOutreachRun(req, res) {
  try {
    const body = await readBody(req);
    const result = await createAndMaybeGenerate(body);
    const draftNote = result.generated_drafts === 'queued' ? '; drafts generating in background' : (result.generated_drafts ? `, ${result.generated_drafts} draft(s)` : '');
    const msg = `Outreach run created: ${result.campaign_count} campaign(s), ${result.item_count} item(s)${draftNote}`;
    redirect(res, `/marketing?message=${encodeURIComponent(msg)}`);
  } catch (error) {
    redirect(res, `/marketing?error=${encodeURIComponent(error.message)}`);
  }
}

export async function postInboxScan(req, res) {
  try {
    const { runInboxScan } = await import('../../../agents/marketing-inbox-agent.js');
    const result = await runInboxScan({ dryRun: false });
    redirect(res, `/marketing?message=${encodeURIComponent(`Inbox scan done: fetched ${result.fetched}, saved ${result.saved}`)}`);
  } catch (error) {
    redirect(res, `/marketing?error=${encodeURIComponent(error.message)}`);
  }
}

function renderBulkOutreach(releases, outlets, summary) {
  const releaseRows = releases.map(({ song, links }) => `<label class="flex items-start gap-3 border border-zinc-200 rounded-lg p-3 hover:bg-zinc-50"><input type="checkbox" name="song_ids" value="${attr(song.id)}" class="mt-1"><span class="flex-1 min-w-0"><span class="block font-semibold text-sm">${esc(song.title || song.topic || song.id)}</span><span class="block text-xs text-zinc-500">${esc(song.status)} · ${links.length ? esc(links.map(l => l.platform).slice(0,3).join(', ')) : 'links pending'}</span></span><a href="/songs/${attr(song.id)}" class="shrink-0 text-xs text-blue-600 hover:underline mt-0.5" onclick="event.stopPropagation()">View →</a></label>`).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    <div class="flex items-start justify-between gap-4 mb-5"><div><h2 class="font-bold text-lg">Bulk Outreach Run</h2><p class="text-sm text-zinc-500 mt-1">Select releases and outlet group. Creates review-gated draft rows only.</p></div><div class="text-right text-xs text-zinc-500"><div>${summary.total || 0} outreach item(s)</div><div>${summary.draft_generated || 0} draft(s) · ${summary.requires_ken || 0} need Ken</div></div></div>
    <form method="POST" action="/marketing/outreach-run" class="space-y-4">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div><div class="flex items-center justify-between mb-2"><span class="font-semibold text-sm">Releases</span><a href="/marketing/releases/new" class="text-xs text-blue-600 hover:underline">+ Add release</a></div><div class="grid grid-cols-1 gap-2 max-h-72 overflow-y-auto pr-1">${releaseRows || emptyBox('No release-ready songs. <a href="/marketing/releases/new" class="text-blue-600 hover:underline">Add one</a> or promote a song in the Song Catalog.')}</div></div>
        <div><div class="font-semibold text-sm mb-2 flex items-center gap-3">Outlet group <a href="/marketing/outlets" class="text-xs font-normal text-blue-600 hover:underline">Browse all outlets →</a></div><div class="space-y-2">
          ${presetRadio('safe_p0', `Safe P0 Launch (${outlets.filter(o => o.priority === 'P0' && o.outreach_allowed === true).length})`, true)}
          ${presetRadio('safe_p0_p1', `Safe P0 + P1 (${outlets.filter(o => ['P0','P1'].includes(o.priority) && o.outreach_allowed === true).length})`)}
          ${presetRadio('playlist', `Playlist / curators (${outlets.filter(o => o.type === 'playlist' && o.outreach_allowed === true).length})`)}
          ${presetRadio('parent_teacher', `Parent + teacher (${outlets.filter(o => ['parent_creator','educator'].includes(o.type) && o.outreach_allowed === true).length})`)}
          ${presetRadio('all_safe', `All safe (${outlets.filter(o => o.outreach_allowed === true).length})`)}
        </div><div class="mt-4 font-semibold text-sm mb-2">Mode</div><div class="space-y-2">${modeRadio('single_release', 'One campaign per selected release', true)}${modeRadio('bundle', 'Bundle selected releases into one pitch')}</div><label class="mt-4 flex gap-2 text-sm"><input type="checkbox" name="generate_drafts" value="true" checked>Generate draft copy now</label></div>
      </div>
      <div class="flex items-center justify-between pt-2"><p class="text-xs text-zinc-500">Nothing sends automatically.</p><button id="outreach-run-btn" class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Create outreach run</button></div>
    </form>
    <div id="outreach-run-progress" class="hidden mt-4 flex items-center gap-3 text-sm text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3">
      <svg class="animate-spin h-4 w-4 text-emerald-600 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg>
      <span>Creating outreach run and generating drafts… this may take 30–60 seconds.</span>
    </div>
    <script>
      document.querySelector('form[action="/marketing/outreach-run"]').addEventListener('submit', function() {
        var btn = document.getElementById('outreach-run-btn');
        btn.disabled = true;
        btn.textContent = 'Working…';
        btn.classList.replace('bg-emerald-600', 'bg-zinc-400');
        document.getElementById('outreach-run-progress').classList.remove('hidden');
      });
    </script>
  </section>`;
}

function renderCampaignList(campaigns) {
  const rows = campaigns.map(c => {
    const items = getOutreachItems({ campaign_id: c.id });
    return `<div class="border border-zinc-200 rounded-xl p-4 flex items-start justify-between gap-4"><div><a href="/marketing/campaigns/${attr(c.id)}" class="font-semibold text-blue-700 hover:underline">${esc(c.name)}</a><div class="text-xs text-zinc-500 mt-1">${items.length} item(s)</div></div><a href="/marketing/campaigns/${attr(c.id)}" class="border border-zinc-300 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-zinc-50">Open</a></div>`;
  }).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold text-lg mb-4">Campaigns / Gmail Draft Queue</h2><div class="space-y-2">${rows || emptyBox('No outreach campaigns yet.')}</div></section>`;
}

function renderInboxTriage({ summary, messages }) {
  const rows = messages.map(m => `<tr class="align-top border-b"><td class="py-3 pr-4"><div class="font-semibold">${esc(m.subject || '(no subject)')}</div><div class="text-xs text-zinc-500">${esc(m.from_name ? `${m.from_name} <${m.from_email || ''}>` : m.from_email || '')}</div></td><td class="py-3 pr-4 text-xs">${esc(m.classification || 'unclassified')}</td><td class="py-3 pr-4 text-xs text-zinc-500">${esc(m.snippet || '').slice(0, 300)}</td><td class="py-3 text-xs"><textarea class="w-full min-h-24 border border-zinc-200 rounded-lg p-2 bg-zinc-50" readonly>${esc(m.suggested_reply || '')}</textarea></td></tr>`).join('');
  const summaryLine = summary ? `${summary.total || 0} scanned · ${summary.needs_ken || 0} need Ken · ${summary.safe_reply_candidate || 0} safe candidates` : 'Run inbox scan to populate Gmail triage.';
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold text-lg">Gmail Triage / Non-Campaign Replies</h2><p class="text-sm text-zinc-500 mt-1 mb-4">${esc(summaryLine)}</p>${rows ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-xs uppercase text-zinc-400 border-b"><tr><th class="py-2 pr-4">Message</th><th class="py-2 pr-4">Class</th><th class="py-2 pr-4">Snippet</th><th class="py-2">Suggested Reply</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBox('No Gmail triage items found.')}</section>`;
}

function releaseReadySongs() {
  const statuses = new Set(['submitted_to_distributor', 'published', 'approved', 'ready_to_publish', 'metadata_ready']);
  const seen = new Set();
  return getAllSongs()
    .filter(song => statuses.has(song.status) && !seen.has(song.id) && seen.add(song.id))
    .slice(0, 50)
    .map(song => ({ song, links: getReleaseLinks(song.id) }));
}
function safeInbox() { try { return { summary: getInboxSummary(), messages: getInboxMessages(50).filter(m => m.requires_ken || ['safe_reply_candidate','opportunity','creator_reply','playlist_reply','blog_media_reply','needs_ken','submission_confirmation','platform_admin','account_admin','do_not_contact'].includes(m.classification)) }; } catch { return { summary: null, messages: [] }; } }
