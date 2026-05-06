import { SONG_STATUSES, normalizeSongStatus } from './song-status.js';

const NEXT_ACTION_LABELS = Object.freeze({
  ADD_HYPERFOLLOW: 'Add HyperFollow Link',
  GENERATE_MARKETING_PACK: 'Generate Release Assets',
  START_OUTREACH: 'Start Outreach',
  NONE: 'No action needed',
});

const MISSING_FIELD_LABELS = Object.freeze({
  smart_link: 'HyperFollow link',
  streaming_link: 'streaming link',
  release_kit_url: 'release kit URL',
  audio_download_url: 'audio download link',
  promo_assets_folder_url: 'promo assets folder',
  cover_art_url: 'cover art link',
  lyrics_url: 'lyrics link',
  social_links: 'social profile links',
  contact_email: 'contact email',
  base_or_fallback_image: 'base image or fallback image',
  social_asset_set: 'marketing asset set',
});

export function formatMarketingMissingFieldLabel(value) {
  return MISSING_FIELD_LABELS[value] || String(value || '').replaceAll('_', ' ');
}

export function hasGeneratedMarketingAssets(assets = {}) {
  return Boolean(
    assets.square_post_url
    || assets.vertical_post_url
    || assets.portrait_post_url
    || assets.outreach_banner_url
    || assets.cover_safe_promo_url
    || assets.no_text_variation_url
    || assets.generated_at
  );
}

export function getSongNextAction(song, marketingData = {}) {
  const status = normalizeSongStatus(song?.status);
  const links = marketingData.marketing_links || marketingData.links || {};
  const assets = marketingData.marketing_assets || marketingData.assets || {};
  const readiness = marketingData.marketing_readiness || marketingData.readiness || {};

  if (status !== SONG_STATUSES.SUBMITTED_TO_DISTROKID) {
    return {
      status,
      nextActionKey: 'NONE',
      label: status === SONG_STATUSES.OUTREACH_COMPLETE ? 'Outreach complete' : NEXT_ACTION_LABELS.NONE,
      missing: [],
      blocking: false,
      href: null,
    };
  }

  if (!cleanValue(links.smart_link)) {
    return buildNextAction(song?.id, status, 'ADD_HYPERFOLLOW', ['HyperFollow link'], true);
  }

  if (!hasGeneratedMarketingAssets(assets)) {
    const missing = ['Marketing asset set'];
    if (!cleanValue(assets.base_image_url) && !cleanValue(assets.fallback_image_url)) missing.push('Base image or fallback image');
    return buildNextAction(song?.id, status, 'GENERATE_MARKETING_PACK', missing, true);
  }

  return buildNextAction(
    song?.id,
    status,
    'START_OUTREACH',
    summarizeReadinessMissing(readiness),
    false,
  );
}

function summarizeReadinessMissing(readiness = {}) {
  const values = [
    ...(Array.isArray(readiness.missing_required_fields) ? readiness.missing_required_fields : []),
    ...(Array.isArray(readiness.missing_recommended_fields) ? readiness.missing_recommended_fields : []),
  ];
  return [...new Set(values.map(formatMarketingMissingFieldLabel))];
}

function buildNextAction(songId, status, nextActionKey, missing, blocking) {
  return {
    status,
    nextActionKey,
    label: NEXT_ACTION_LABELS[nextActionKey] || NEXT_ACTION_LABELS.NONE,
    missing: [...new Set((missing || []).filter(Boolean))],
    blocking: Boolean(blocking),
    href: buildSongNextActionHref(songId, nextActionKey),
  };
}

function buildSongNextActionHref(songId, nextActionKey) {
  if (!songId) return null;
  const base = `/songs/${encodeURIComponent(songId)}`;
  switch (nextActionKey) {
    case 'ADD_HYPERFOLLOW':
      return `${base}?tab=marketing#marketing-links`;
    case 'GENERATE_MARKETING_PACK':
      return `${base}?tab=marketing#release-kit-actions`;
    case 'START_OUTREACH':
      return `${base}?tab=performance#release-outreach`;
    default:
      return base;
  }
}

function cleanValue(value) {
  return String(value || '').trim();
}
