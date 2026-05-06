import { getMarketingCampaigns } from '../../../shared/marketing-db.js';
import { getOutreachItems, getOutreachItem, updateOutreachItem } from '../../../shared/marketing-outreach-db.js';
import { transitionOutreachItem } from '../../../shared/marketing-outreach-state.js';
import { getChannelTasks, updateChannelTask } from '../../../shared/marketing-channel-tasks-db.js';
import { generateDraftForOutreachItem, generateDraftsForCampaign } from '../../../agents/marketing-outreach-draft-agent.js';
import { createGmailDraftForOutreachItem, createGmailDraftsForCampaign } from '../../../agents/marketing-gmail-draft-agent.js';
import { getSong, getReleaseLinks } from '../../../shared/db.js';
import { renderMarketingLayout } from '../views/layout.js';
import { banner, emptyBox, statCard, pill } from '../views/helpers.js';
import { esc, attr, redirect, readBody, campaignUrl } from '../utils/http.js';

export function renderCampaignDetail(req, res) {
  const campaign = findCampaign(req.params.campaignId);
  if (!campaign) return res.status(404).send(renderMarketingLayout('Campaign not found', '<main class="p-8">Campaign not found</main>'));
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout('Marketing Campaign', renderCampaignPage(campaign, req.query || {})));
}

export async function postGenerateCampaignDrafts(req, res) {
  try {
    const result = await generateDraftsForCampaign(req.params.campaignId);
    redirect(res, campaignUrl(req.params.campaignId, `Generated ${result.generated} draft(s); ${result.failed} failed`));
  } catch (error) {
    redirect(res, campaignUrl(req.params.campaignId, error.message, 'error'));
  }
}

export async function postCreateCampaignGmailDrafts(req, res) {
  try {
    const result = await createGmailDraftsForCampaign(req.params.campaignId);
    redirect(res, campaignUrl(req.params.campaignId, `Gmail drafts: ${result.created} created, ${result.blocked} blocked, ${result.failed} failed`));
  } catch (error) {
    redirect(res, campaignUrl(req.params.campaignId, error.message, 'error'));
  }
}

export async function postUpdateCampaignItem(req, res) {
  try {
    const campaign = findCampaign(req.params.campaignId);
    if (!campaign) throw new Error('Campaign not found');
    const item = ensureItem(req.params.itemId, campaign.id);
    const body = await readBody(req);
    const requestedStatus = body.status || item.status;

    updateOutreachItem(item.id, {
      subject: body.subject || null,
      body: body.body || null,
      safety_notes: body.safety_notes || null,
      safety_status: 'ken_reviewed',
      requires_ken: true,
    });

    if (requestedStatus !== item.status) applyStatusTransition(item.id, requestedStatus);
    redirect(res, campaignUrl(campaign.id, 'Draft updated'));
  } catch (error) {
    redirect(res, campaignUrl(req.params.campaignId, error.message, 'error'));
  }
}

export async function postGenerateCampaignItemDraft(req, res) {
  try {
    const campaign = findCampaign(req.params.campaignId);
    if (!campaign) throw new Error('Campaign not found');
    ensureItem(req.params.itemId, campaign.id);
    await generateDraftForOutreachItem(req.params.itemId);
    redirect(res, campaignUrl(campaign.id, 'Draft regenerated'));
  } catch (error) {
    redirect(res, campaignUrl(req.params.campaignId, error.message, 'error'));
  }
}

export async function postCreateCampaignItemGmailDraft(req, res) {
  try {
    const campaign = findCampaign(req.params.campaignId);
    if (!campaign) throw new Error('Campaign not found');
    ensureItem(req.params.itemId, campaign.id);
    const result = await createGmailDraftForOutreachItem(req.params.itemId);
    const msg = result.ok ? 'Gmail draft created' : `Gmail draft blocked: ${(result.notes || []).join('; ')}`;
    redirect(res, campaignUrl(campaign.id, msg, result.ok ? 'message' : 'error'));
  } catch (error) {
    redirect(res, campaignUrl(req.params.campaignId, error.message, 'error'));
  }
}

export async function postMarkCampaignItemManualSubmitted(req, res) {
  try {
    const campaign = findCampaign(req.params.campaignId);
    if (!campaign) throw new Error('Campaign not found');
    const item = ensureItem(req.params.itemId, campaign.id);
    const body = await readBody(req);
    transitionOutreachItem(item.id, 'mark_manual_submitted', {
      actor: 'ken',
      fields: { safety_status: 'manual_submitted', safety_notes: appendNote(item.safety_notes, body.note || 'Marked manually submitted'), requires_ken: false },
      message: 'Manual submission marked complete',
      metadata: { note: body.note || null },
    });
    for (const task of getChannelTasks({ outreach_item_id: item.id })) {
      if (['contact_form_manual', 'owned_social_manual', 'manual_research'].includes(task.channel_type)) updateChannelTask(task.id, { status: 'submitted' });
    }
    redirect(res, campaignUrl(campaign.id, 'Marked manually submitted'));
  } catch (error) {
    redirect(res, campaignUrl(req.params.campaignId, error.message, 'error'));
  }
}

function renderCampaignPage(campaign, query) {
  const items = getOutreachItems({ campaign_id: campaign.id });
  const song = campaign.focus_song_id ? getSong(campaign.focus_song_id) : null;
  const links = campaign.focus_song_id ? getReleaseLinks(campaign.focus_song_id) : [];
  const stats = summarize(items);
  const rows = items.map(item => renderItem(campaign, item)).join('');
  const linkHtml = links.length ? links.map(l => `<a href="${attr(l.url)}" target="_blank" class="text-xs text-blue-600 hover:underline">${esc(l.platform)}</a>`).join(' · ') : '<span class="text-xs text-zinc-400">No release links captured</span>';

  return `<main class="p-8 space-y-6">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div><a href="/marketing" class="text-sm text-blue-600 hover:underline">← Back to Marketing</a><h1 class="text-3xl font-extrabold mt-2">${esc(campaign.name)}</h1><p class="text-sm text-zinc-500 mt-2">${esc(campaign.objective || '')}</p><div class="mt-2 text-xs text-zinc-500">Focus release: <span class="font-semibold text-zinc-700">${esc(song?.title || song?.topic || campaign.focus_song_id || '—')}</span> · ${linkHtml}</div></div>
        <div class="flex flex-wrap gap-2"><form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/generate-drafts"><button class="bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm font-semibold">Generate all drafts</button></form><form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/gmail-drafts"><button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Create Gmail drafts</button></form></div>
      </div>
    </section>
    ${banner(query.message)}${banner(query.error, 'error')}
    <section class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">${statCard('Items', stats.total)}${statCard('Queued', stats.queued)}${statCard('Drafted', stats.drafted)}${statCard('Gmail', stats.gmail)}${statCard('Manual', stats.manual)}${statCard('Needs Ken', stats.needsKen)}${statCard('Blocked', stats.blocked)}${statCard('With Email', stats.withEmail)}</section>
    <section class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold text-lg mb-4">Outlet Outreach Items</h2><div class="space-y-4">${rows || emptyBox('No outreach items found.')}</div></section>
  </main>`;
}

function renderItem(campaign, item) {
  const email = item.outlet_context?.contact_email || item.outlet_context?.contact?.email || '';
  const canGmail = item.subject && item.body && email && item.status !== 'gmail_draft_created' && item.outlet_context?.ai_policy !== 'banned';
  const tasks = getChannelTasks({ outreach_item_id: item.id }).map(t => pill(`${t.channel_type} · ${t.status}`)).join(' ');
  const releases = (item.release_context || []).map(r => `<li>${esc(r.title || r.topic || r.id)}</li>`).join('');
  const draftMeta = summarizeDraftMeta(item.body || '');
  const draftMetaHtml = [
    draftMeta.hasArtistLinks ? pill('artist links', 'green') : '',
    draftMeta.hasAttachedNote ? pill('asset note', 'blue') : '',
    draftMeta.hasPlatformSet ? pill('platform links', 'zinc') : '',
  ].filter(Boolean).join(' ');
  const gmailDraftLink = item.gmail_draft_url
    ? `<a href="${attr(item.gmail_draft_url)}" target="_blank" rel="noopener noreferrer" class="border border-blue-300 text-blue-700 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-blue-50">Open Gmail draft</a>`
    : '';
  return `<article class="border border-zinc-200 rounded-xl p-4">
    <div class="flex flex-wrap items-start justify-between gap-4 mb-4"><div><div class="flex flex-wrap items-center gap-2"><h3 class="font-bold text-base">${esc(item.outlet_name || item.target_id)}</h3>${pill(item.status, item.status === 'gmail_draft_created' || item.status === 'manual_submitted' ? 'green' : 'blue')}${pill(item.safety_status || 'pending', String(item.safety_status || '').includes('blocked') ? 'red' : 'amber')}</div><div class="mt-1 text-xs text-zinc-500">${email ? `Email: <span class="font-semibold">${esc(email)}</span>` : '<span class="text-amber-700">No email; likely manual/contact-form submission</span>'} · AI policy: ${esc(item.outlet_context?.ai_policy || 'unknown')}</div><div class="mt-2 flex flex-wrap gap-1">${tasks}</div>${draftMetaHtml ? `<div class="mt-2 flex flex-wrap gap-1">${draftMetaHtml}</div>` : ''}${releases ? `<ul class="mt-2 text-xs text-zinc-500 list-disc list-inside">${releases}</ul>` : ''}</div><div class="flex flex-wrap gap-2"><form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/items/${attr(item.id)}/generate-draft"><button class="bg-zinc-900 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Regenerate</button></form><form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/items/${attr(item.id)}/gmail-draft"><button class="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-semibold ${canGmail ? '' : 'opacity-50 cursor-not-allowed'}" ${canGmail ? '' : 'disabled'}>Create Gmail draft</button></form>${gmailDraftLink}</div></div>
    <div class="mb-3 text-[11px] text-zinc-500">Visible change note: regenerate the draft to refresh the body with the richer social/platform links and asset attachment note; create the Gmail draft again to produce the new multipart draft with attachments.</div>
    <form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/items/${attr(item.id)}/update" class="grid grid-cols-1 lg:grid-cols-2 gap-4"><div class="space-y-3"><label class="block text-xs font-semibold text-zinc-500 uppercase">Subject</label><input name="subject" value="${attr(item.subject || '')}" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm"><label class="block text-xs font-semibold text-zinc-500 uppercase">Status</label><select name="status" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">${option('queued', item.status)}${option('draft_generated', item.status)}${option('needs_ken', item.status)}${option('ready_for_gmail_draft', item.status)}${option('manual_submitted', item.status)}${option('do_not_contact', item.status)}</select><label class="block text-xs font-semibold text-zinc-500 uppercase">Safety notes</label><textarea name="safety_notes" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-xs min-h-24">${esc(item.safety_notes || '')}</textarea><button class="bg-emerald-600 text-white rounded-lg px-3 py-1.5 text-xs font-semibold">Save edits</button></div><div><label class="block text-xs font-semibold text-zinc-500 uppercase mb-2">Body</label><textarea name="body" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm font-mono min-h-80">${esc(item.body || '')}</textarea></div></form>
    <form method="POST" action="/marketing/campaigns/${attr(campaign.id)}/items/${attr(item.id)}/manual-submitted" class="mt-3 flex flex-wrap gap-2 items-center"><input name="note" placeholder="Manual submission note" class="flex-1 min-w-64 border border-zinc-200 rounded-lg px-3 py-2 text-xs"><button class="border border-zinc-300 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-zinc-50">Mark manual submitted</button></form>
  </article>`;
}

function findCampaign(id) { return getMarketingCampaigns(500).find(c => c.id === id); }
function ensureItem(itemId, campaignId) { const item = getOutreachItem(itemId); if (!item) throw new Error('Outreach item not found'); if (item.campaign_id !== campaignId) throw new Error('Outreach item does not belong to this campaign'); return item; }
function applyStatusTransition(itemId, requested) { const map = { queued:'queue', draft_generated:'generate_draft', needs_ken:'mark_needs_ken', ready_for_gmail_draft:'mark_ready_for_gmail_draft', manual_submitted:'mark_manual_submitted', do_not_contact:'suppress', cancelled:'cancel' }; if (map[requested]) transitionOutreachItem(itemId, map[requested], { actor:'ken', fields:{ safety_status: requested === 'do_not_contact' ? 'suppressed' : 'ken_reviewed', requires_ken: !['manual_submitted','cancelled'].includes(requested) }, message:`Status changed to ${requested}` }); }
function summarize(items) { return { total:items.length, queued:items.filter(i=>i.status==='queued').length, drafted:items.filter(i=>['draft_generated','ready_for_gmail_draft'].includes(i.status)).length, gmail:items.filter(i=>i.status==='gmail_draft_created').length, manual:items.filter(i=>i.status==='manual_submitted').length, needsKen:items.filter(i=>i.requires_ken || i.status==='needs_ken').length, blocked:items.filter(i=>String(i.safety_status || '').includes('blocked') || i.status==='do_not_contact').length, withEmail:items.filter(i=>i.outlet_context?.contact_email || i.outlet_context?.contact?.email).length }; }
function option(value, selected) { return `<option value="${attr(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`; }
function appendNote(existing, next) { return [existing, next].filter(Boolean).join('\n'); }
function summarizeDraftMeta(body) {
  const text = String(body || '');
  return {
    hasArtistLinks: text.includes('Artist links:'),
    hasAttachedNote: text.includes('Attached:'),
    hasPlatformSet: ['Facebook:', 'YouTube:', 'Spotify:', 'Apple Music:', 'Instagram:', 'TikTok:'].some(label => text.includes(label)),
  };
}
