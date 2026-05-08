import { getSocialEnv } from '../social-env.js';
import { validateSocialAssetRequest, isPublicHttpsUrl } from '../social-asset-validator.js';

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
    return { ok: missing.length === 0, missing };
  },

  dryRun(request = {}) {
    const env = getSocialEnv();
    const base = validateSocialAssetRequest({ ...request, platform: 'youtube' }, { mode: env.socialPublishMode });
    const errors = [...base.errors];
    const warnings = [...base.warnings];
    const title = String(request.title || '').trim();
    const description = String(request.description || '').trim();
    if (base.assetType !== 'video') errors.push('YouTube requires assetType=video.');
    if (!title) errors.push('YouTube title is required.');
    if (!description) errors.push('YouTube description is required.');
    if (request.madeForKids !== true && request.madeForKids !== false) errors.push('YouTube madeForKids must be explicit true or false.');
    if (!request.assetUrl && !request.publicAssetUrl) errors.push('YouTube requires assetUrl or publicAssetUrl.');
    if (env.socialPublishMode === 'live' && request.publicAssetUrl && !isPublicHttpsUrl(request.publicAssetUrl)) {
      errors.push('YouTube live publishing cannot use localhost/private publicAssetUrl values.');
    }

    return {
      ok: errors.length === 0,
      mode: env.socialPublishMode,
      platform: 'youtube',
      warnings,
      errors,
      payloadPreview: {
        title,
        description,
        tags: Array.isArray(request.tags) ? request.tags : Array.isArray(request.hashtags) ? request.hashtags : [],
        privacyStatus: 'private',
        selfDeclaredMadeForKids: request.madeForKids,
        containsSyntheticMedia: request.containsSyntheticMedia !== false,
      },
      notes: [
        'Live implementation TODO: wire googleapis youtube.videos.insert.',
        'Initial uploads should default to private or unlisted until reviewed.',
      ],
    };
  },

  async publish(request = {}) {
    const env = getSocialEnv();
    const dryRun = this.dryRun(request);
    if (!dryRun.ok) {
      const error = new Error(dryRun.errors.join(' '));
      error.code = 'validation_failed';
      throw error;
    }
    if (env.socialPublishMode !== 'live') return { ...dryRun, dryRun: true };
    throw new Error('TODO: live YouTube publishing is not implemented yet. Wire googleapis youtube.videos.insert first.');
  },
};
