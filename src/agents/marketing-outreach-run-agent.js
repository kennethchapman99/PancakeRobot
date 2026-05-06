import {
  createMarketingCampaign,
  getMarketingTargets,
} from '../shared/marketing-db.js';
import {
  createOutreachItem,
  getOutreachItems,
} from '../shared/marketing-outreach-db.js';
import { upsertChannelTask } from '../shared/marketing-channel-tasks-db.js';
import { logMarketingEvent } from '../shared/marketing-events-db.js';
import { getAllSongs, getReleaseLinks, getSong } from '../shared/db.js';
import { getActiveProfileId, loadBrandProfile } from '../shared/brand-profile.js';
import { getOutreachHistoryByTargetIds, normalizeOutletForApp, outletContactedForRelease } from '../shared/marketing-outlets.js';
import { getMarketingReleaseEntries, getOrCreateReleaseMarketing } from '../shared/marketing-releases.js';

const BRAND_PROFILE = loadBrandProfile();

export function createOutreachRun({ song_ids = [], outlet_ids = [], mode = 'single_release', preset = null, allow_same_release = false, dry_run = true, release_marketing_id = null } = {}) {
  const brandProfileId = getActiveProfileId();
  const songIds = normalizeIds(song_ids);
  const outletIds = normalizeIds(outlet_ids);

  if (!songIds.length) throw new Error('Select at least one release');
  if (!outletIds.length) throw new Error('Select at least one outlet');

  const songsById = new Map(getAllSongs({ includeTests: true }).map(song => [song.id, song]));
  const selectedSongs = songIds.map(id => songsById.get(id) || getSong(id)).filter(Boolean);
  if (!selectedSongs.length) throw new Error('No valid selected releases found');

  const allOutletsById = new Map(getAllOutletsForSelection().map(outlet => [outlet.id, outlet]));
  const selectedOutletCandidates = outletIds.map(id => allOutletsById.get(id)).filter(Boolean);
  const { selectedOutlets, excludedOutlets } = partitionOutletsForSelection(selectedOutletCandidates);
  if (!selectedOutlets.length) throw new Error('No selected outlets are eligible');

  if (mode === 'bundle') {
    return createBundleCampaign({ brandProfileId, selectedSongs, selectedOutlets, excludedOutlets, preset, allowSameRelease: allow_same_release, dryRun: dry_run, releaseMarketingId: release_marketing_id });
  }

  return createSingleReleaseCampaigns({ brandProfileId, selectedSongs, selectedOutlets, excludedOutlets, preset, allowSameRelease: allow_same_release, dryRun: dry_run, releaseMarketingId: release_marketing_id });
}

export function getEligibleOutlets() {
  return getAllOutletsForSelection()
    .filter(outlet => outlet.eligible === true && outletHasEmail(outlet))
    .sort(sortOutlets);
}

export function getAllOutletsForSelection() {
  const rows = getMarketingTargets({});
  const historyByTargetId = getOutreachHistoryByTargetIds(rows.map(row => row.id));
  return rows
    .map(row => normalizeOutletForApp(row, { outreachHistory: historyByTargetId.get(row.id) || [] }))
    .sort(sortOutlets);
}

function createSingleReleaseCampaigns({ brandProfileId, selectedSongs, selectedOutlets, excludedOutlets = [], preset, allowSameRelease, dryRun, releaseMarketingId }) {
  const campaigns = [];

  for (const song of selectedSongs) {
    const releaseMarketing = getOrCreateReleaseMarketing(song.id, { id: releaseMarketingId || undefined });
    const releaseEligibleOutlets = allowSameRelease
      ? selectedOutlets
      : selectedOutlets.filter(outlet => !outletContactedForRelease(outlet, song.id));
    const sameReleaseExcluded = allowSameRelease
      ? []
      : selectedOutlets
        .filter(outlet => outletContactedForRelease(outlet, song.id))
        .map(outlet => ({ id: outlet.id, name: outlet.name, reason: 'contacted recently for this release' }));
    if (!releaseEligibleOutlets.length) continue;

    const campaignId = createMarketingCampaign({
      name: `${BRAND_PROFILE.brand_name || 'Pancake Robot'} Outreach — ${song.title || song.topic || song.id}`,
      status: 'draft',
      release_marketing_id: releaseMarketing.id,
      focus_song_id: song.id,
      objective: buildObjective([song], releaseEligibleOutlets),
      audience: song.target_age_range || BRAND_PROFILE.audience?.age_range || '',
      channel_mix: summarizeChannelMix(releaseEligibleOutlets),
      approved_target_ids: releaseEligibleOutlets.map(o => o.id),
      excluded_target_ids: [...excludedOutlets, ...sameReleaseExcluded].map(o => o.id),
      exclusion_summary: [...excludedOutlets, ...sameReleaseExcluded].map(o => `${o.name || o.id}: ${o.reason}`).join('; '),
      dry_run: dryRun,
      brand_context: buildBrandContext({ mode: 'single_release', preset, selectedSongs: [song], selectedOutlets: releaseEligibleOutlets }),
      notes: `Release-level outreach run. ${dryRun ? 'Dry run only; ' : ''}Draft queue only; requires review before Gmail draft/send.`,
    });

    logMarketingEvent({
      event_type: 'campaign_created',
      campaign_id: campaignId,
      song_id: song.id,
      message: `Single-release outreach campaign created for ${song.title || song.id}`,
      payload: { mode: 'single_release', preset, outlet_count: releaseEligibleOutlets.length },
    });

    const items = createItemsForCampaign({
      campaignId,
      releaseMarketingId: releaseMarketing.id,
      brandProfileId,
      mode: 'single_release',
      selectedSongs: [song],
      selectedOutlets: releaseEligibleOutlets,
    });

    campaigns.push({ campaign_id: campaignId, release_marketing_id: releaseMarketing.id, song_ids: [song.id], outreach_items: items, excluded_outlets: [...excludedOutlets, ...sameReleaseExcluded] });
  }

  if (!campaigns.length) {
    throw new Error('All selected outlets were already contacted for the selected release(s)');
  }

  return {
    mode: 'single_release',
    campaign_count: campaigns.length,
    item_count: campaigns.reduce((sum, c) => sum + c.outreach_items.length, 0),
    campaigns,
  };
}

function createBundleCampaign({ brandProfileId, selectedSongs, selectedOutlets, excludedOutlets = [], preset, allowSameRelease, dryRun, releaseMarketingId }) {
  const filteredOutlets = allowSameRelease
    ? selectedOutlets
    : selectedOutlets.filter(outlet => selectedSongs.every(song => !outletContactedForRelease(outlet, song.id)));
  if (!filteredOutlets.length) throw new Error('All selected outlets were already contacted for the selected release(s)');

  const title = selectedSongs.length === 1
    ? (selectedSongs[0].title || selectedSongs[0].topic || selectedSongs[0].id)
    : `${selectedSongs.length} releases`;

  const releaseMarketing = getOrCreateReleaseMarketing(selectedSongs[0].id, { id: releaseMarketingId || undefined });
  const campaignId = createMarketingCampaign({
    name: `${BRAND_PROFILE.brand_name || 'Pancake Robot'} Bundle Outreach — ${title}`,
    status: 'draft',
    release_marketing_id: releaseMarketing.id,
    focus_song_id: selectedSongs[0].id,
    objective: buildObjective(selectedSongs, filteredOutlets),
    audience: BRAND_PROFILE.audience?.age_range || selectedSongs[0].target_age_range || '',
    channel_mix: summarizeChannelMix(filteredOutlets),
    approved_target_ids: filteredOutlets.map(o => o.id),
    excluded_target_ids: excludedOutlets.map(o => o.id),
    exclusion_summary: excludedOutlets.map(o => `${o.name || o.id}: ${o.reason}`).join('; '),
    dry_run: dryRun,
    brand_context: buildBrandContext({ mode: 'bundle', preset, selectedSongs, selectedOutlets: filteredOutlets }),
    notes: `Bundle outreach run. ${dryRun ? 'Dry run only; ' : ''}Draft queue only; requires review before Gmail draft/send.`,
  });

  logMarketingEvent({
    event_type: 'campaign_created',
    campaign_id: campaignId,
    song_id: selectedSongs[0].id,
    message: `Bundle outreach campaign created for ${selectedSongs.length} release(s)`,
    payload: { mode: 'bundle', preset, song_ids: selectedSongs.map(s => s.id), outlet_count: filteredOutlets.length },
  });

  const items = createItemsForCampaign({
    campaignId,
    releaseMarketingId: releaseMarketing.id,
    brandProfileId,
    mode: 'bundle',
    selectedSongs,
    selectedOutlets: filteredOutlets,
  });

  return {
    mode: 'bundle',
    campaign_count: 1,
    item_count: items.length,
    campaigns: [{ campaign_id: campaignId, release_marketing_id: releaseMarketing.id, song_ids: selectedSongs.map(s => s.id), outreach_items: items, excluded_outlets: excludedOutlets }],
  };
}

function createItemsForCampaign({ campaignId, releaseMarketingId, brandProfileId, mode, selectedSongs, selectedOutlets }) {
  const items = [];
  const primarySong = selectedSongs[0];

  for (const outlet of selectedOutlets) {
    const duplicate = findDuplicateOutreach({
      songIds: selectedSongs.map(s => s.id),
      targetId: outlet.id,
    });

    const safety = computeSafety(outlet, duplicate);
    const itemId = createOutreachItem({
      campaign_id: campaignId,
      release_marketing_id: releaseMarketingId,
      brand_profile_id: brandProfileId,
      song_id: primarySong.id,
      bundle_song_ids: selectedSongs.map(s => s.id),
      target_id: outlet.id,
      outlet_name: outlet.name,
      status: safety.status,
      outreach_mode: mode,
      requires_ken: true,
      safety_status: safety.safety_status,
      safety_notes: safety.safety_notes,
      selected_assets: recommendAssets(outlet, selectedSongs),
      release_context: buildReleaseContext(selectedSongs),
      outlet_context: outlet,
      raw_json: { duplicate, outlet, selected_song_ids: selectedSongs.map(s => s.id) },
    });

    logMarketingEvent({
      event_type: 'outreach_item_created',
      campaign_id: campaignId,
      outreach_item_id: itemId,
      target_id: outlet.id,
      song_id: primarySong.id,
      message: `Outreach item created for ${outlet.name}`,
      payload: { mode, safety, duplicate, selected_song_ids: selectedSongs.map(s => s.id) },
    });

    createDefaultChannelTask({ campaignId, itemId, outlet, primarySong, safety });

    items.push({ item_id: itemId, target_id: outlet.id, outlet_name: outlet.name, status: safety.status, safety_status: safety.safety_status });
  }

  return items;
}

function partitionOutletsForSelection(selectedOutletCandidates = []) {
  const selectedOutlets = [];
  const excludedOutlets = [];
  for (const outlet of selectedOutletCandidates) {
    const reason = getSelectionExclusionReason(outlet);
    if (reason) excludedOutlets.push({ id: outlet.id, name: outlet.name, reason });
    else selectedOutlets.push(outlet);
  }
  return { selectedOutlets, excludedOutlets };
}

function getSelectionExclusionReason(outlet) {
  if (!outletHasEmail(outlet)) return 'no usable contact method';
  if (['do_not_contact', 'suppressed'].includes(outlet.status) || outlet.do_not_contact) return 'do not contact';
  if (['do_not_contact', 'ai_banned', 'paid_only', 'bounced', 'no_contact_method'].includes(outlet.suppression_status)) return outlet.suppression_status.replace(/_/g, ' ');
  if (outlet.ai_policy === 'banned') return 'AI banned';
  if (outlet.cost_policy?.requires_payment === true) return 'paid-only';
  if (outlet.contactability?.free_contact_method_found !== true) return 'no usable contact method';
  return null;
}

function createDefaultChannelTask({ campaignId, itemId, outlet, primarySong, safety }) {
  const hasEmail = Boolean(outlet.public_email || outlet.contact?.email);
  const channelType = hasEmail
    ? 'email_gmail'
    : outlet.contactability?.best_channel === 'contact_form' || outlet.contact?.method
      ? 'contact_form_manual'
      : ['instagram_dm', 'tiktok_dm', 'youtube_about'].includes(outlet.contactability?.best_channel)
        ? 'owned_social_manual'
        : 'manual_research';

  const actionType = hasEmail
    ? 'create_gmail_draft'
    : channelType === 'contact_form_manual'
      ? 'manual_submit_contact_form'
      : channelType === 'owned_social_manual'
        ? 'manual_owned_social_post'
        : 'manual_find_contact_route';

  upsertChannelTask({
    campaign_id: campaignId,
    outreach_item_id: itemId,
    target_id: outlet.id,
    song_id: primarySong.id,
    channel_type: channelType,
    action_type: actionType,
    status: safety.status === 'queued' ? 'pending' : 'needs_review',
    manual_url: hasEmail ? null : outlet.submission_form_url || outlet.contact?.method || outlet.source_url || null,
    instructions: hasEmail
      ? 'Generate/review copy, then create Gmail draft. Do not auto-send.'
      : 'Use the generated pitch and release assets to complete this manually. Mark submitted when done.',
    payload: { outlet, safety },
  });
}

function findDuplicateOutreach({ songIds, targetId }) {
  for (const songId of songIds) {
    const existing = getOutreachItems({ song_id: songId, target_id: targetId })
      .filter(item => !['cancelled', 'failed'].includes(item.status));
    if (existing.length) {
      return { song_id: songId, count: existing.length, latest_item_id: existing[0].id, latest_status: existing[0].status };
    }
  }
  return null;
}

function computeSafety(outlet, duplicate) {
  const notes = [];
  if (duplicate) notes.push(`Duplicate outreach exists for ${duplicate.song_id}: ${duplicate.latest_status}`);
  if (outlet.ai_policy === 'unclear') notes.push('AI policy unclear; include disclosure or review carefully');
  if (outlet.contactability?.status !== 'contactable') notes.push('Contact route needs manual research');

  if (duplicate) return { status: 'needs_ken', safety_status: 'duplicate_review', safety_notes: notes.join('\n') };
  if (outlet.contactability?.status !== 'contactable') return { status: 'needs_ken', safety_status: 'missing_contact', safety_notes: notes.join('\n') };
  return { status: 'queued', safety_status: 'passed', safety_notes: notes.join('\n') || 'Passed deterministic preflight' };
}

function buildBrandContext({ mode, preset, selectedSongs, selectedOutlets }) {
  return {
    campaign_kind: 'release_outreach',
    mode,
    preset,
    brand: {
      name: BRAND_PROFILE.brand_name || 'Pancake Robot',
      audience: BRAND_PROFILE.audience || {},
      social: BRAND_PROFILE.social || {},
    },
    selected_song_ids: selectedSongs.map(s => s.id),
    selected_outlet_ids: selectedOutlets.map(o => o.id),
  };
}

function buildReleaseContext(selectedSongs) {
  return selectedSongs.map(song => ({
    id: song.id,
    title: song.title,
    topic: song.topic,
    concept: song.concept,
    status: song.status,
    release_date: song.release_date,
    distributor: song.distributor,
    links: getReleaseLinks(song.id),
  }));
}

function buildObjective(selectedSongs, selectedOutlets) {
  const releasePart = selectedSongs.length === 1
    ? `Release outreach for ${selectedSongs[0].title || selectedSongs[0].topic || selectedSongs[0].id}`
    : `Bundle outreach for ${selectedSongs.length} selected releases`;
  const outletPart = summarizeChannelMix(selectedOutlets).map(i => `${i.count} ${i.type}`).join(', ');
  return `${releasePart}; selected outlet mix: ${outletPart}`;
}

function recommendAssets(outlet, selectedSongs) {
  const preferred = outlet.assets_to_send || [];
  const assets = new Set(preferred);
  assets.add('streaming_links');
  assets.add('cover_art');
  if (selectedSongs.length > 1) assets.add('bundle_summary');
  if (['parent_creator', 'educator'].includes(outlet.type)) assets.add('short_clip_or_activity_angle');
  if (['playlist', 'radio'].includes(outlet.type)) assets.add('clean_audio_or_public_streaming_link');
  return [...assets];
}

function summarizeChannelMix(outlets) {
  const counts = outlets.reduce((acc, outlet) => {
    const type = outlet.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([type, count]) => ({ type, count }));
}

function sortOutlets(a, b) {
  const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3, AVOID_FOR_FULLY_AI: 9 };
  const pa = priorityOrder[a.priority] ?? 5;
  const pb = priorityOrder[b.priority] ?? 5;
  if (pa !== pb) return pa - pb;
  return (b.fit_score || 0) - (a.fit_score || 0);
}

function outletHasEmail(outlet) {
  return Boolean(outlet?.public_email || outlet?.contact_email || outlet?.contact?.email);
}

export function getReleaseReadySongs() {
  return getMarketingReleaseEntries(50);
}

function normalizeIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  return [];
}
