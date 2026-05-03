import {
  createMarketingCampaign,
  getMarketingTargets,
} from '../shared/marketing-db.js';
import {
  createOutreachItem,
  getOutreachItems,
} from '../shared/marketing-outreach-db.js';
import { getAllSongs, getReleaseLinks } from '../shared/db.js';
import { getActiveProfileId, loadBrandProfile } from '../shared/brand-profile.js';

const BRAND_PROFILE = loadBrandProfile();

export function createOutreachRun({ song_ids = [], outlet_ids = [], mode = 'single_release', preset = null } = {}) {
  const brandProfileId = getActiveProfileId();
  const songIds = normalizeIds(song_ids);
  const outletIds = normalizeIds(outlet_ids);

  if (!songIds.length) throw new Error('Select at least one release');
  if (!outletIds.length) throw new Error('Select at least one outlet');

  const songsById = new Map(getAllSongs().map(song => [song.id, song]));
  const selectedSongs = songIds.map(id => songsById.get(id)).filter(Boolean);
  if (!selectedSongs.length) throw new Error('No valid selected releases found');

  const eligibleById = new Map(getEligibleOutlets().map(outlet => [outlet.id, outlet]));
  const selectedOutlets = outletIds.map(id => eligibleById.get(id)).filter(Boolean);
  if (!selectedOutlets.length) throw new Error('No selected outlets are eligible');

  if (mode === 'bundle') {
    return createBundleCampaign({ brandProfileId, selectedSongs, selectedOutlets, preset });
  }

  return createSingleReleaseCampaigns({ brandProfileId, selectedSongs, selectedOutlets, preset });
}

export function getEligibleOutlets() {
  return getMarketingTargets({})
    .map(normalizeTarget)
    .filter(outlet => outlet.status !== 'do_not_contact')
    .filter(outlet => outlet.ai_policy !== 'banned')
    .sort(sortOutlets);
}

function createSingleReleaseCampaigns({ brandProfileId, selectedSongs, selectedOutlets, preset }) {
  const campaigns = [];

  for (const song of selectedSongs) {
    const campaignId = createMarketingCampaign({
      name: `${BRAND_PROFILE.brand_name || 'Pancake Robot'} Outreach — ${song.title || song.topic || song.id}`,
      status: 'draft',
      focus_song_id: song.id,
      objective: buildObjective([song], selectedOutlets),
      audience: song.target_age_range || BRAND_PROFILE.audience?.age_range || '',
      channel_mix: summarizeChannelMix(selectedOutlets),
      approved_target_ids: selectedOutlets.map(o => o.id),
      brand_context: buildBrandContext({ mode: 'single_release', preset, selectedSongs: [song], selectedOutlets }),
      notes: 'Release-level outreach run. Draft queue only; requires review before Gmail draft/send.',
    });

    const items = createItemsForCampaign({
      campaignId,
      brandProfileId,
      mode: 'single_release',
      selectedSongs: [song],
      selectedOutlets,
    });

    campaigns.push({ campaign_id: campaignId, song_ids: [song.id], outreach_items: items });
  }

  return {
    mode: 'single_release',
    campaign_count: campaigns.length,
    item_count: campaigns.reduce((sum, c) => sum + c.outreach_items.length, 0),
    campaigns,
  };
}

function createBundleCampaign({ brandProfileId, selectedSongs, selectedOutlets, preset }) {
  const title = selectedSongs.length === 1
    ? (selectedSongs[0].title || selectedSongs[0].topic || selectedSongs[0].id)
    : `${selectedSongs.length} releases`;

  const campaignId = createMarketingCampaign({
    name: `${BRAND_PROFILE.brand_name || 'Pancake Robot'} Bundle Outreach — ${title}`,
    status: 'draft',
    focus_song_id: selectedSongs[0].id,
    objective: buildObjective(selectedSongs, selectedOutlets),
    audience: BRAND_PROFILE.audience?.age_range || selectedSongs[0].target_age_range || '',
    channel_mix: summarizeChannelMix(selectedOutlets),
    approved_target_ids: selectedOutlets.map(o => o.id),
    brand_context: buildBrandContext({ mode: 'bundle', preset, selectedSongs, selectedOutlets }),
    notes: 'Bundle outreach run. Draft queue only; requires review before Gmail draft/send.',
  });

  const items = createItemsForCampaign({
    campaignId,
    brandProfileId,
    mode: 'bundle',
    selectedSongs,
    selectedOutlets,
  });

  return {
    mode: 'bundle',
    campaign_count: 1,
    item_count: items.length,
    campaigns: [{ campaign_id: campaignId, song_ids: selectedSongs.map(s => s.id), outreach_items: items }],
  };
}

function createItemsForCampaign({ campaignId, brandProfileId, mode, selectedSongs, selectedOutlets }) {
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

    items.push({ item_id: itemId, target_id: outlet.id, outlet_name: outlet.name, status: safety.status, safety_status: safety.safety_status });
  }

  return items;
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
  if (outlet.outreach_allowed === 'manual_review_only') notes.push('Outlet requires manual review before draft/use');
  if (outlet.ai_policy === 'disclosure_required') notes.push('AI disclosure required');
  if (outlet.ai_policy === 'unclear') notes.push('AI policy unclear; include disclosure or review carefully');
  if (outlet.contact_status === 'manual_research_needed') notes.push('Contact route needs manual research');

  if (duplicate) return { status: 'needs_ken', safety_status: 'duplicate_review', safety_notes: notes.join('\n') };
  if (outlet.outreach_allowed === 'manual_review_only') return { status: 'needs_ken', safety_status: 'manual_review', safety_notes: notes.join('\n') };
  if (outlet.contact_status === 'manual_research_needed') return { status: 'needs_ken', safety_status: 'missing_contact', safety_notes: notes.join('\n') };
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

function normalizeTarget(row) {
  const raw = safeParse(row.raw_json);
  const pitchPrefs = safeParse(row.pitch_preferences);
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
    ai_policy: row.ai_policy,
    ai_risk_score: row.ai_risk_score,
    ai_risk_level: aiMusicStance.risk_level || riskLevelFromScore(row.ai_risk_score),
    outreach_allowed: outreachAllowed(row),
    recommended_pitch_type: raw.recommended_pitch_type || pitchPrefs.recommended_pitch_type || null,
    sample_pitch_hook: raw.sample_pitch_hook || row.outreach_angle || null,
    assets_to_send: raw.assets_to_send || pitchPrefs.assets_to_send || [],
    research_summary: row.research_summary,
    outreach_angle: row.outreach_angle,
    raw_json: raw,
  };
}

function contactStatus(row) {
  if (row.status === 'do_not_contact') return 'avoid';
  if (row.contact_email) return 'has_email';
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

function normalizeIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  return [];
}

function safeParse(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
