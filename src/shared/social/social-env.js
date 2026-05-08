import { SOCIAL_PLATFORMS, normalizeSocialPlatform } from './social-types.js';

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePlatforms(value) {
  const raw = String(value || '')
    .split(',')
    .map(entry => normalizeSocialPlatform(entry))
    .filter(Boolean);
  return raw.length ? [...new Set(raw)] : [...SOCIAL_PLATFORMS];
}

export function getSocialEnv() {
  return {
    socialPublishMode: String(process.env.SOCIAL_PUBLISH_MODE || 'dry_run').trim().toLowerCase() === 'live' ? 'live' : 'dry_run',
    socialRequireApproval: parseBool(process.env.SOCIAL_REQUIRE_APPROVAL, true),
    publicBaseUrl: String(process.env.PUBLIC_BASE_URL || 'http://localhost:3737').trim(),
    dailySocialEnabled: parseBool(process.env.DAILY_SOCIAL_ENABLED, false),
    dailySocialTimezone: String(process.env.DAILY_SOCIAL_TIMEZONE || 'America/Toronto').trim() || 'America/Toronto',
    dailySocialRequireApproval: parseBool(process.env.DAILY_SOCIAL_REQUIRE_APPROVAL, true),
    dailySocialPlatforms: parsePlatforms(process.env.DAILY_SOCIAL_PLATFORMS || 'instagram,facebook,youtube'),
    dailySocialTimes: {
      instagram: String(process.env.DAILY_SOCIAL_INSTAGRAM_TIME || '08:30').trim(),
      facebook: String(process.env.DAILY_SOCIAL_FACEBOOK_TIME || '09:00').trim(),
      youtube: String(process.env.DAILY_SOCIAL_YOUTUBE_TIME || '16:00').trim(),
    },
    youtube: {
      clientId: String(process.env.YOUTUBE_CLIENT_ID || '').trim(),
      clientSecret: String(process.env.YOUTUBE_CLIENT_SECRET || '').trim(),
      redirectUri: String(process.env.YOUTUBE_REDIRECT_URI || '').trim(),
      refreshToken: String(process.env.YOUTUBE_REFRESH_TOKEN || '').trim(),
      channelId: String(process.env.YOUTUBE_CHANNEL_ID || '').trim(),
    },
    meta: {
      graphVersion: String(process.env.META_GRAPH_VERSION || 'v25.0').trim() || 'v25.0',
      appId: String(process.env.META_APP_ID || '').trim(),
      appSecret: String(process.env.META_APP_SECRET || '').trim(),
      pageId: String(process.env.META_PAGE_ID || '').trim(),
      pageAccessToken: String(process.env.META_PAGE_ACCESS_TOKEN || '').trim(),
    },
    instagram: {
      igUserId: String(process.env.INSTAGRAM_IG_USER_ID || '').trim(),
    },
    facebook: {
      pageId: String(process.env.FACEBOOK_PAGE_ID || '').trim(),
      pageAccessToken: String(process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '').trim(),
    },
  };
}

export function getPlatformScheduleTime(platform) {
  const env = getSocialEnv();
  return env.dailySocialTimes[platform] || '09:00';
}
