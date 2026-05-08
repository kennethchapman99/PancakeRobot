import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { getSocialEnv } from './social-env.js';

export const YOUTUBE_AUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export function getYoutubeTokenPath() {
  return getSocialEnv().youtube.tokenPath;
}

export function loadSavedYoutubeTokenData() {
  const tokenPath = getYoutubeTokenPath();
  if (!tokenPath || !fs.existsSync(tokenPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveYoutubeTokenData(tokenData = {}) {
  const tokenPath = getYoutubeTokenPath();
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
}

export function getYoutubeOAuth2Client() {
  const env = getSocialEnv();
  if (!env.youtube.clientId || !env.youtube.clientSecret || !env.youtube.redirectUri) {
    throw new Error('YouTube OAuth is not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REDIRECT_URI first.');
  }
  const client = new google.auth.OAuth2(env.youtube.clientId, env.youtube.clientSecret, env.youtube.redirectUri);
  client.on('tokens', (tokens) => {
    const existing = loadSavedYoutubeTokenData() || {};
    saveYoutubeTokenData({
      ...existing,
      ...tokens,
      refresh_token: tokens.refresh_token || existing.refresh_token || env.youtube.refreshToken || '',
      channel_id: existing.channel_id || env.youtube.channelId || '',
      channel_title: existing.channel_title || env.youtube.channelTitle || '',
      saved_at: new Date().toISOString(),
    });
  });
  return client;
}

export function getYoutubeAuthUrl({ state = '' } = {}) {
  const client = getYoutubeOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    include_granted_scopes: true,
    prompt: 'consent',
    scope: YOUTUBE_AUTH_SCOPES,
    state: state || undefined,
  });
}

async function fetchAuthenticatedYoutubeChannel(auth) {
  const youtube = google.youtube({ version: 'v3', auth });
  const response = await youtube.channels.list({ part: ['id', 'snippet'], mine: true });
  const channel = response.data.items?.[0] || null;
  if (!channel?.id) throw new Error('Authorized Google account does not appear to have an accessible YouTube channel.');
  return {
    channelId: channel.id,
    channelTitle: channel.snippet?.title || '',
  };
}

export async function exchangeYoutubeAuthCode(code) {
  const client = getYoutubeOAuth2Client();
  const existing = loadSavedYoutubeTokenData() || {};
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const { channelId, channelTitle } = await fetchAuthenticatedYoutubeChannel(client);
  const saved = {
    ...existing,
    ...tokens,
    refresh_token: tokens.refresh_token || existing.refresh_token || '',
    channel_id: channelId,
    channel_title: channelTitle,
    saved_at: new Date().toISOString(),
  };
  saveYoutubeTokenData(saved);
  return {
    channelId,
    channelTitle,
    tokenPath: getYoutubeTokenPath(),
    hasRefreshToken: Boolean(saved.refresh_token),
  };
}

export async function getAuthorizedYoutubeOAuth2Client() {
  const env = getSocialEnv();
  const saved = loadSavedYoutubeTokenData() || {};
  const refreshToken = env.youtube.refreshToken || saved.refresh_token || '';
  if (!refreshToken) {
    throw new Error('YouTube is not authorized. Open /marketing/social and use Connect YouTube first.');
  }

  const client = getYoutubeOAuth2Client();
  client.setCredentials({
    ...saved,
    refresh_token: refreshToken,
  });
  await client.getAccessToken();
  saveYoutubeTokenData({
    ...saved,
    ...client.credentials,
    refresh_token: refreshToken,
    channel_id: saved.channel_id || env.youtube.channelId || '',
    channel_title: saved.channel_title || env.youtube.channelTitle || '',
    saved_at: new Date().toISOString(),
  });
  return client;
}

export function getYoutubeAuthSummary() {
  const env = getSocialEnv();
  const saved = loadSavedYoutubeTokenData() || {};
  return {
    tokenPath: getYoutubeTokenPath(),
    hasSavedToken: Boolean(saved.refresh_token),
    hasEnvRefreshToken: Boolean(process.env.YOUTUBE_REFRESH_TOKEN),
    channelId: saved.channel_id || env.youtube.channelId || '',
    channelTitle: saved.channel_title || env.youtube.channelTitle || '',
  };
}
