export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'youtube'];
export const SOCIAL_ASSET_TYPES = ['image', 'video', 'text'];
export const DAILY_SOCIAL_CAMPAIGN_TYPES = [
  'new_release_push',
  'catalog_discovery',
  'song_clip',
  'character_scene',
  'lyric_card',
  'parent_friendly_pitch',
  'radio_review_support',
];

export function normalizeSocialPlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SOCIAL_PLATFORMS.includes(normalized) ? normalized : '';
}

export function normalizeAssetType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SOCIAL_ASSET_TYPES.includes(normalized) ? normalized : '';
}

export function normalizeCampaignType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return DAILY_SOCIAL_CAMPAIGN_TYPES.includes(normalized) ? normalized : 'catalog_discovery';
}
