import { getSocialEnv } from '../social-env.js';
import { validateSocialAssetRequest, isPublicHttpsUrl } from '../social-asset-validator.js';

export const instagramConnector = {
  platform: 'instagram',

  validateConfig() {
    const env = getSocialEnv();
    const missing = [];
    if (!env.meta.appId) missing.push('META_APP_ID');
    if (!env.meta.appSecret) missing.push('META_APP_SECRET');
    if (!env.meta.pageId) missing.push('META_PAGE_ID');
    if (!env.meta.pageAccessToken) missing.push('META_PAGE_ACCESS_TOKEN');
    if (!env.instagram.igUserId) missing.push('INSTAGRAM_IG_USER_ID');
    return { ok: missing.length === 0, missing };
  },

  dryRun(request = {}) {
    const env = getSocialEnv();
    const base = validateSocialAssetRequest({ ...request, platform: 'instagram' }, { mode: env.socialPublishMode });
    const errors = [...base.errors];
    const warnings = [...base.warnings];
    const caption = String(request.caption || '').trim();
    if (!['image', 'video'].includes(base.assetType)) errors.push('Instagram requires assetType=image or assetType=video.');
    if (!caption) errors.push('Instagram caption is required.');
    if (env.socialPublishMode === 'live' && !isPublicHttpsUrl(request.publicAssetUrl || '')) {
      errors.push('Instagram live publishing requires a public HTTPS media URL.');
    }

    return {
      ok: errors.length === 0,
      mode: env.socialPublishMode,
      platform: 'instagram',
      warnings,
      errors,
      payloadPreview: {
        caption,
        mediaType: base.assetType === 'video' ? 'REELS' : 'IMAGE',
        publicAssetUrl: request.publicAssetUrl || '',
      },
      notes: [
        'Live implementation TODO: POST /{ig-user-id}/media using image_url or video_url.',
        'For vertical video, set media_type=REELS, poll creation status if required, then POST /{ig-user-id}/media_publish.',
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
    throw new Error('TODO: live Instagram publishing is not implemented yet. Wire the official Graph API media container flow first.');
  },
};
