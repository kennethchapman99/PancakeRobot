import { getAllSongs, getSong } from '../shared/db.js';
import { getSongMarketingKit } from '../shared/song-marketing-kit.js';
import { getReleaseMarketingBySongId, getOrCreateReleaseMarketing } from '../shared/marketing-releases.js';
import {
  createDailySocialCampaign,
  getDailySocialCampaignById,
  getDailySocialCampaignForDate,
  getSocialPostsBySongId,
  upsertSocialPost,
  getSocialPostsByCampaignId,
  updateDailySocialCampaign,
} from '../shared/social-publishing-db.js';
import { getSocialEnv, getPlatformScheduleTime } from '../shared/social/social-env.js';
import { buildPublicAssetUrl } from '../shared/social/social-asset-validator.js';
import { SOCIAL_PLATFORMS } from '../shared/social/social-types.js';
import { generateSocialCopy } from './social-copy-agent.js';
import { SONG_STATUSES } from '../shared/song-status.js';

function nowInTimezoneDate(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const token = parts.find(part => part.type === 'timeZoneName')?.value || 'GMT+0';
  const match = token.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * ((hours * 60) + minutes);
}

function zonedDateTimeToUtcIso(dateText, timeText, timeZone) {
  const [year, month, day] = dateText.split('-').map(Number);
  const [hours, minutes] = String(timeText || '09:00').split(':').map(Number);
  const firstPassUtc = Date.UTC(year, month - 1, day, hours || 0, minutes || 0, 0);
  const offset = getTimeZoneOffsetMinutes(timeZone, new Date(firstPassUtc));
  const correctedUtc = Date.UTC(year, month - 1, day, hours || 0, minutes || 0, 0) - (offset * 60 * 1000);
  return new Date(correctedUtc).toISOString();
}

function hasSocialAsset(kit) {
  return Boolean(
    kit?.marketing_assets?.vertical_post_url
    || kit?.marketing_assets?.square_post_url
    || kit?.marketing_assets?.portrait_post_url
    || kit?.marketing_assets?.cover_safe_promo_url
    || kit?.marketing_assets?.no_text_variation_url
  );
}

function resolveCampaignType(song, kit) {
  if (song.marketing_inputs_from_ar?.prioritize_next_daily_campaign) return 'new_release_push';
  if (song.status === SONG_STATUSES.SUBMITTED_TO_DISTROKID || song.status === SONG_STATUSES.OUTREACH_COMPLETE) return 'new_release_push';
  if (kit?.marketing_assets?.vertical_post_url) return 'song_clip';
  if (kit?.marketing_assets?.square_post_url || kit?.marketing_assets?.portrait_post_url) return 'catalog_discovery';
  return 'parent_friendly_pitch';
}

function daysSinceRecentPost(posts = []) {
  const latest = posts.find(post => post.published_at || post.created_at);
  if (!latest) return Number.POSITIVE_INFINITY;
  const stamp = latest.published_at || latest.created_at;
  return (Date.now() - new Date(stamp).getTime()) / (1000 * 60 * 60 * 24);
}

function scoreSong(song) {
  const kit = getSongMarketingKit(song);
  const release = getReleaseMarketingBySongId(song.id);
  const posts = getSocialPostsBySongId(song.id);
  const recentDays = daysSinceRecentPost(posts);
  const releaseRecommendationScore = Number(song.release_recommendation?.score || 0);
  const hasReleaseLink = Boolean(kit.marketing_links.smart_link || kit.marketing_links.release_kit_url);
  const hasPriority = Boolean(song.marketing_inputs_from_ar?.prioritize_next_daily_campaign || song.marketing_inputs_from_ar?.use_in_daily_social_push);
  const statusScore = song.status === SONG_STATUSES.SUBMITTED_TO_DISTROKID || song.status === SONG_STATUSES.OUTREACH_COMPLETE ? 35 : 10;
  const assetScore = hasSocialAsset(kit) ? 25 : 0;
  const releaseScore = release ? 10 : 0;
  const linkScore = hasReleaseLink ? 10 : 0;
  const recommendationScore = Math.min(Math.round(releaseRecommendationScore / 5), 20);
  const priorityScore = hasPriority ? 30 : 0;
  const recencyPenalty = recentDays < 7 ? -50 : 0;
  const archivedPenalty = String(song.status || '').toLowerCase() === 'archived' ? -1000 : 0;
  const total = statusScore + assetScore + releaseScore + linkScore + recommendationScore + priorityScore + recencyPenalty + archivedPenalty;
  const rationaleParts = [];
  if (song.status === SONG_STATUSES.SUBMITTED_TO_DISTROKID || song.status === SONG_STATUSES.OUTREACH_COMPLETE) rationaleParts.push('release-ready status');
  if (hasSocialAsset(kit)) rationaleParts.push('marketing-ready assets available');
  if (hasReleaseLink) rationaleParts.push('shareable release link available');
  if (releaseRecommendationScore) rationaleParts.push(`release-selection score ${releaseRecommendationScore}`);
  if (recentDays < 7) rationaleParts.push('recently used in daily social');
  if (!rationaleParts.length) rationaleParts.push('catalog fallback');
  return { song, kit, release, posts, recentDays, total, rationale: rationaleParts.join('; ') };
}

function selectSongForDailySocial() {
  const candidates = getAllSongs()
    .filter(song => String(song.status || '').toLowerCase() !== 'archived')
    .map(scoreSong)
    .filter(entry => hasSocialAsset(entry.kit) || entry.kit.marketing_links.smart_link || entry.kit.marketing_links.release_kit_url)
    .sort((a, b) => b.total - a.total || String(a.song.id).localeCompare(String(b.song.id)));
  return candidates[0] || null;
}

function selectSpecificSongForDailySocial(songId) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found for social campaign: ${songId}`);
  if (String(song.status || '').toLowerCase() === 'archived') throw new Error(`Cannot create social campaign for archived song: ${songId}`);
  return scoreSong(song);
}

function resolvePlatformAsset(platform, kit) {
  const sharedAssetUrl = kit.marketing_assets.vertical_post_url
    || kit.marketing_assets.square_post_url
    || kit.marketing_assets.portrait_post_url
    || kit.marketing_assets.cover_safe_promo_url
    || '';
  const isVideo = /\.(mp4|mov|webm)$/i.test(sharedAssetUrl);
  if (platform === 'youtube') {
    return {
      assetType: isVideo ? 'video' : 'image',
      assetUrl: sharedAssetUrl,
    };
  }
  return {
    assetType: isVideo ? 'video' : 'image',
    assetUrl: sharedAssetUrl,
  };
}

export function buildSocialIdempotencyKey({ date, platform, songId, campaignType }) {
  return `${date}:${platform}:${songId}:${campaignType}`;
}

export function createOrRefreshDailySocialCampaign({ date, platforms, force = false, songId = null } = {}) {
  const env = getSocialEnv();
  const campaignDate = date || nowInTimezoneDate(env.dailySocialTimezone);
  const activePlatforms = Array.isArray(platforms) && platforms.length ? platforms : env.dailySocialPlatforms;
  let campaign = getDailySocialCampaignForDate(campaignDate);
  let selection = null;

  if (songId) {
    selection = selectSpecificSongForDailySocial(songId);
  }

  if (!campaign || (songId && campaign.selected_song_id !== songId)) {
    selection = selection || selectSongForDailySocial();
    if (!selection) throw new Error('No eligible song found for daily social.');
    const campaignType = resolveCampaignType(selection.song, selection.kit);
    const release = selection.release || getOrCreateReleaseMarketing(selection.song.id);
    campaign = createDailySocialCampaign({
      date: campaignDate,
      timezone: env.dailySocialTimezone,
      brand: 'Pancake Robot',
      status: env.dailySocialRequireApproval ? 'draft' : 'queued',
      selected_song_id: selection.song.id,
      selected_release_id: release?.id || null,
      campaign_type: campaignType,
      rationale: selection.rationale,
      requires_approval: env.dailySocialRequireApproval,
    });
  } else {
    const campaignSong = getSong(campaign.selected_song_id);
    selection = selection || (campaignSong ? scoreSong(campaignSong) : selectSongForDailySocial());
    if (!selection) throw new Error('No eligible song found for daily social.');
    const nextCampaignType = force ? resolveCampaignType(selection.song, selection.kit) : campaign.campaign_type;
    campaign = updateDailySocialCampaign(campaign.id, {
      selected_release_id: campaign.selected_release_id || selection.release?.id || null,
      campaign_type: nextCampaignType,
      rationale: selection.rationale,
    });
  }

  const song = selection?.song || getSong(campaign.selected_song_id);
  const kit = selection?.kit || getSongMarketingKit(song);
  const campaignType = campaign.campaign_type;
  const releaseId = campaign.selected_release_id || selection?.release?.id || null;

  for (const platform of activePlatforms.filter(item => SOCIAL_PLATFORMS.includes(item))) {
    const asset = resolvePlatformAsset(platform, kit);
    const copy = generateSocialCopy({
      platform,
      song,
      marketingKit: kit,
      campaignType,
      assetType: asset.assetType,
      madeForKids: platform === 'youtube' ? false : null,
    });
    upsertSocialPost({
      campaign_id: campaign.id,
      release_id: releaseId,
      song_id: song.id,
      platform,
      status: env.dailySocialRequireApproval ? 'draft' : 'approved',
      asset_type: asset.assetType,
      asset_url: asset.assetUrl,
      public_asset_url: buildPublicAssetUrl(asset.assetUrl, env.publicBaseUrl),
      title: copy.title,
      caption: copy.caption,
      description: copy.description,
      hashtags: copy.hashtags,
      scheduled_at: zonedDateTimeToUtcIso(campaign.date, getPlatformScheduleTime(platform), campaign.timezone),
      made_for_kids: copy.madeForKids,
      contains_synthetic_media: true,
      ai_generated: true,
      validation_warnings: [],
      idempotency_key: buildSocialIdempotencyKey({ date: campaign.date, platform, songId: song.id, campaignType }),
    });
  }

  const posts = getSocialPostsByCampaignId(campaign.id);
  const nextStatus = env.dailySocialRequireApproval ? 'ready_for_review' : 'queued';
  campaign = updateDailySocialCampaign(campaign.id, {
    status: campaign.status === 'published' ? campaign.status : nextStatus,
    rationale: selection?.rationale || campaign.rationale,
  });
  return { campaign, song, marketingKit: kit, posts };
}

export function createOrRefreshReleaseSocialCampaign({
  releaseType,
  releaseId,
  campaignId = null,
  date,
  platform,
  campaignMoment,
  songId = null,
  visualAssetId = null,
  dryRun = true,
} = {}) {
  const env = getSocialEnv();
  const targetSongId = String(songId || releaseId || '').trim();
  const selection = selectSpecificSongForDailySocial(targetSongId);
  const campaignDate = date || selection.song.release_date || nowInTimezoneDate(env.dailySocialTimezone);
  const effectivePlatform = String(platform || 'instagram').trim().toLowerCase();
  let campaign = campaignId ? getDailySocialCampaignById(campaignId) : null;

  if (!campaign) {
    campaign = createDailySocialCampaign({
      date: campaignDate,
      timezone: env.dailySocialTimezone,
      brand: 'Pancake Robot',
      status: 'draft',
      selected_song_id: selection.song.id,
      selected_release_id: releaseId || null,
      campaign_type: String(campaignMoment || 'release_day'),
      rationale: `Release-campaign social draft for ${releaseType || 'single'} ${releaseId || selection.song.id}`,
      requires_approval: true,
    });
  } else {
    campaign = updateDailySocialCampaign(campaign.id, {
      selected_release_id: releaseId || campaign.selected_release_id || null,
      campaign_type: campaignMoment || campaign.campaign_type,
      rationale: `Release-campaign social draft for ${releaseType || 'single'} ${releaseId || selection.song.id}`,
    });
  }

  const kit = selection.kit;
  const asset = resolvePlatformAsset(effectivePlatform, kit);
  const copy = generateSocialCopy({
    platform: effectivePlatform,
    song: selection.song,
    marketingKit: kit,
    campaignType: campaignMoment || 'release_day',
    assetType: asset.assetType,
    madeForKids: effectivePlatform === 'youtube' ? false : null,
  });
  upsertSocialPost({
    campaign_id: campaign.id,
    release_id: campaign.selected_release_id,
    song_id: selection.song.id,
    platform: effectivePlatform,
    status: dryRun ? 'draft' : 'approved',
    asset_type: asset.assetType,
    asset_url: asset.assetUrl,
    public_asset_url: buildPublicAssetUrl(asset.assetUrl, env.publicBaseUrl),
    title: copy.title,
    caption: copy.caption,
    description: copy.description,
    hashtags: copy.hashtags,
    scheduled_at: zonedDateTimeToUtcIso(campaign.date, getPlatformScheduleTime(effectivePlatform), campaign.timezone),
    made_for_kids: copy.madeForKids,
    contains_synthetic_media: true,
    ai_generated: true,
    validation_warnings: visualAssetId ? [`Selected visual asset: ${visualAssetId}`] : [],
    idempotency_key: buildSocialIdempotencyKey({
      date: campaign.date,
      platform: effectivePlatform,
      songId: selection.song.id,
      campaignType: String(campaignMoment || 'release_day'),
    }),
  });
  return {
    campaign: getDailySocialCampaignById(campaign.id),
    song: selection.song,
    marketingKit: kit,
    posts: getSocialPostsByCampaignId(campaign.id),
  };
}
