import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { getSocialEnv } from '../social-env.js';
import { validateSocialAssetRequest, isPublicHttpsUrl } from '../social-asset-validator.js';
import { getAuthorizedYoutubeOAuth2Client } from '../youtube-auth.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

function resolveLocalMediaPath(assetUrl = '') {
  const trimmed = String(assetUrl || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return '';
    }
  }
  if (trimmed.startsWith('/media/')) {
    return path.join(REPO_ROOT, 'output', trimmed.slice('/media/'.length));
  }
  if (path.isAbsolute(trimmed)) return trimmed;
  const repoRelative = path.resolve(REPO_ROOT, trimmed);
  return fs.existsSync(repoRelative) ? repoRelative : '';
}

function canUseLocalMedia(assetUrl = '') {
  const localPath = resolveLocalMediaPath(assetUrl);
  return Boolean(localPath && fs.existsSync(localPath));
}

async function buildUploadMedia(request = {}) {
  const localPath = resolveLocalMediaPath(request.assetUrl || '');
  if (localPath && fs.existsSync(localPath)) {
    const stream = fs.createReadStream(localPath);
    return {
      mediaPath: localPath,
      body: stream,
      cleanup: async () => {
        if (!stream.destroyed) stream.destroy();
      },
    };
  }

  const remoteUrl = String(request.publicAssetUrl || request.assetUrl || '').trim();
  if (!remoteUrl) throw new Error('No uploadable YouTube media source found.');
  const response = await fetch(remoteUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch YouTube media source: ${response.status} ${response.statusText}`);
  }
  return {
    mediaPath: remoteUrl,
    body: Readable.fromWeb(response.body),
    cleanup: async () => {
      response.body?.cancel?.().catch?.(() => {});
    },
  };
}

async function uploadYoutubeVideo({ authClient, request, media }) {
  const youtube = google.youtube({ version: 'v3', auth: authClient });
  return youtube.videos.insert({
    part: ['snippet', 'status'],
    notifySubscribers: false,
    requestBody: {
      snippet: {
        title: request.title,
        description: request.description,
        tags: Array.isArray(request.tags) ? request.tags : [],
        categoryId: String(request.categoryId || '10'),
      },
      status: {
        privacyStatus: request.privacyStatus || 'private',
        selfDeclaredMadeForKids: request.madeForKids,
        containsSyntheticMedia: request.containsSyntheticMedia !== false,
      },
    },
    media: {
      body: media.body,
    },
  });
}

export const youtubeConnector = {
  platform: 'youtube',

  validateConfig() {
    const env = getSocialEnv();
    const missing = [];
    if (!env.youtube.clientId) missing.push('YOUTUBE_CLIENT_ID');
    if (!env.youtube.clientSecret) missing.push('YOUTUBE_CLIENT_SECRET');
    if (!env.youtube.redirectUri) missing.push('YOUTUBE_REDIRECT_URI');
    if (!env.youtube.refreshToken) missing.push('YOUTUBE_REFRESH_TOKEN');
    if (!env.youtube.channelId) missing.push('YOUTUBE_CHANNEL_ID');
    return {
      ok: missing.length === 0,
      missing,
      details: {
        channelId: env.youtube.channelId,
        channelTitle: env.youtube.channelTitle,
        tokenPath: env.youtube.tokenPath,
        hasSavedToken: env.youtube.hasSavedToken,
      },
    };
  },

  dryRun(request = {}) {
    const env = getSocialEnv();
    const base = validateSocialAssetRequest({ ...request, platform: 'youtube' }, { mode: env.socialPublishMode });
    const errors = [...base.errors];
    const warnings = [...base.warnings];
    const title = String(request.title || '').trim();
    const description = String(request.description || '').trim();
    const hasLocalMedia = canUseLocalMedia(request.assetUrl || '');
    const hasRemotePublicMedia = request.publicAssetUrl && isPublicHttpsUrl(request.publicAssetUrl);
    const filteredErrors = hasLocalMedia
      ? errors.filter(error => error !== 'Live publishing requires a public HTTPS media URL, not localhost/private infrastructure.')
      : errors;

    if (base.assetType !== 'video') filteredErrors.push('YouTube requires assetType=video.');
    if (!title) filteredErrors.push('YouTube title is required.');
    if (!description) filteredErrors.push('YouTube description is required.');
    if (request.madeForKids !== true && request.madeForKids !== false) filteredErrors.push('YouTube madeForKids must be explicit true or false.');
    if (!request.assetUrl && !request.publicAssetUrl) filteredErrors.push('YouTube requires assetUrl or publicAssetUrl.');
    if (env.socialPublishMode === 'live' && !hasLocalMedia && !hasRemotePublicMedia) {
      filteredErrors.push('YouTube live publishing requires either a local uploadable file or a public HTTPS media URL.');
    }

    return {
      ok: filteredErrors.length === 0,
      mode: env.socialPublishMode,
      platform: 'youtube',
      warnings,
      errors: filteredErrors,
      payloadPreview: {
        title,
        description,
        tags: Array.isArray(request.tags) ? request.tags : Array.isArray(request.hashtags) ? request.hashtags : [],
        privacyStatus: request.privacyStatus || 'private',
        selfDeclaredMadeForKids: request.madeForKids,
        containsSyntheticMedia: request.containsSyntheticMedia !== false,
      },
      notes: [
        'Live YouTube uploads use videos.insert with snippet and status.',
        'Unverified API projects may still have uploads forced to private by Google.',
      ],
    };
  },

  async publish(request = {}, options = {}) {
    const env = getSocialEnv();
    const dryRun = this.dryRun(request);
    if (!dryRun.ok) {
      const error = new Error(dryRun.errors.join(' '));
      error.code = 'validation_failed';
      throw error;
    }
    if (env.socialPublishMode !== 'live') return { ...dryRun, dryRun: true };

    const authClient = options.authClient || await getAuthorizedYoutubeOAuth2Client();
    const media = options.media || await buildUploadMedia(request);
    try {
      const uploadFn = options.uploadFn || uploadYoutubeVideo;
      const response = await uploadFn({ authClient, request, media });
      const videoId = response.data?.id;
      const uploadedChannelId = response.data?.snippet?.channelId || '';
      if (!videoId) throw new Error('YouTube upload completed without a returned video ID.');
      if (env.youtube.channelId && uploadedChannelId && env.youtube.channelId !== uploadedChannelId) {
        throw new Error(`Uploaded to unexpected YouTube channel ${uploadedChannelId}; expected ${env.youtube.channelId}.`);
      }
      return {
        ok: true,
        platform: 'youtube',
        mode: env.socialPublishMode,
        warnings: [
          'Upload created successfully.',
          'Unverified YouTube API projects may still have uploads forced to private by Google.',
        ],
        errors: [],
        platformPostId: videoId,
        platformPostUrl: `https://www.youtube.com/watch?v=${videoId}`,
        payloadPreview: dryRun.payloadPreview,
        responseStatus: response.data?.status?.privacyStatus || request.privacyStatus || 'private',
      };
    } finally {
      await media.cleanup();
    }
  },
};

export { resolveLocalMediaPath, uploadYoutubeVideo };
