import fs from 'fs';
import path from 'path';
import { SOCIAL_PLATFORMS, normalizeSocialPlatform } from './social-types.js';
import { getPublicBaseUrl } from '../public-url.js';

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

function expandHome(value) {
  if (!value) return '';
  return value.startsWith('~')
    ? path.join(process.env.HOME || process.env.USERPROFILE || '.', value.slice(2))
    : value;
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getSocialEnv() {
  const youtubeTokenPath = expandHome(process.env.YOUTUBE_TOKEN_PATH || '~/.pancake-robot/youtube_token.json');
  const youtubeToken = readJsonFile(youtubeTokenPath);
  return {
    socialPublishMode: String(process.env.SOCIAL_PUBLISH_MODE || 'dry_run').trim().toLowerCase() === 'live' ? 'live' : 'dry_run',
    socialRequireApproval: parseBool(process.env.SOCIAL_REQUIRE_APPROVAL, true),
    publicBaseUrl: getPublicBaseUrl(),
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
      refreshToken: String(process.env.YOUTUBE_REFRESH_TOKEN || youtubeToken.refresh_token || '').trim(),
      channelId: String(process.env.YOUTUBE_CHANNEL_ID || youtubeToken.channel_id || '').trim(),
      channelTitle: String(youtubeToken.channel_title || '').trim(),
      tokenPath: youtubeTokenPath,
      hasSavedToken: Boolean(youtubeToken.refresh_token),
      defaultPrivacyStatus: String(process.env.YOUTUBE_DEFAULT_PRIVACY_STATUS || 'private').trim().toLowerCase() || 'private',
      renderForce: parseBool(process.env.YOUTUBE_RENDER_FORCE, false),
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
