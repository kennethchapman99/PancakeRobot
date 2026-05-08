import { getSocialEnv } from '../social-env.js';
import { validateSocialAssetRequest, isPublicHttpsUrl } from '../social-asset-validator.js';

export const facebookConnector = {
  platform: 'facebook',

  validateConfig() {
    const env = getSocialEnv();
    const missing = [];
    if (!env.meta.appId) missing.push('META_APP_ID');
    if (!env.meta.appSecret) missing.push('META_APP_SECRET');
    if (!env.facebook.pageId) missing.push('FACEBOOK_PAGE_ID');
    if (!env.facebook.pageAccessToken) missing.push('FACEBOOK_PAGE_ACCESS_TOKEN');
    return { ok: missing.length === 0, missing };
  },

  dryRun(request = {}) {
    const env = getSocialEnv();
    const base = validateSocialAssetRequest({ ...request, platform: 'facebook' }, { mode: env.socialPublishMode });
    const errors = [...base.errors];
    const warnings = [...base.warnings];
    const caption = String(request.caption || '').trim();
    if (!['image', 'video'].includes(base.assetType)) warnings.push('Facebook usually performs best with image or video assets.');
    if (!caption) errors.push('Facebook caption is required.');
    if (env.socialPublishMode === 'live' && request.publicAssetUrl && !isPublicHttpsUrl(request.publicAssetUrl)) {
      errors.push('Facebook live publishing requires a public HTTPS media URL.');
    }

    return {
      ok: errors.length === 0,
      mode: env.socialPublishMode,
      platform: 'facebook',
      warnings,
      errors,
      payloadPreview: {
        caption,
        assetType: base.assetType,
        publicAssetUrl: request.publicAssetUrl || '',
      },
      notes: [
        'Live implementation TODO: POST /{page-id}/feed for text/link posts, /photos for image posts, /videos for video posts.',
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
    throw new Error('TODO: live Facebook publishing is not implemented yet. Wire the official Graph API endpoints first.');
  },
};
