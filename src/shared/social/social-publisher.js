import { facebookConnector } from './connectors/facebook-connector.js';
import { instagramConnector } from './connectors/instagram-connector.js';
import { youtubeConnector } from './connectors/youtube-connector.js';
import { getSocialEnv } from './social-env.js';
import { buildPublicAssetUrl } from './social-asset-validator.js';

const CONNECTORS = {
  facebook: facebookConnector,
  instagram: instagramConnector,
  youtube: youtubeConnector,
};

export function getSocialConnector(platform) {
  return CONNECTORS[String(platform || '').trim().toLowerCase()] || null;
}

export function listSocialConnectorStatuses() {
  return Object.values(CONNECTORS).map(connector => ({
    platform: connector.platform,
    config: connector.validateConfig(),
  }));
}

export function buildPublishRequestFromPost(post, overrides = {}) {
  const env = getSocialEnv();
  return {
    platform: post.platform,
    assetType: post.asset_type,
    assetUrl: post.asset_url,
    publicAssetUrl: post.public_asset_url || buildPublicAssetUrl(post.asset_url, env.publicBaseUrl),
    title: post.title || '',
    caption: post.caption || '',
    description: post.description || '',
    hashtags: post.hashtags || [],
    tags: post.hashtags || [],
    madeForKids: post.made_for_kids,
    containsSyntheticMedia: post.contains_synthetic_media !== false,
    scheduledAt: post.scheduled_at,
    privacyStatus: overrides.privacyStatus || 'private',
    ...overrides,
  };
}

export async function executeSocialPublish(post, overrides = {}) {
  const connector = getSocialConnector(post.platform);
  if (!connector) {
    return {
      ok: false,
      platform: post.platform,
      errors: [`Unsupported platform: ${post.platform}`],
      warnings: [],
      config: { ok: false, missing: [] },
      mode: getSocialEnv().socialPublishMode,
    };
  }

  const config = connector.validateConfig();
  const request = buildPublishRequestFromPost(post, overrides);
  const env = getSocialEnv();
  const liveRequested = env.socialPublishMode === 'live';
  const dryRunResult = connector.dryRun(request);

  if (!config.ok) {
    return {
      ...dryRunResult,
      ok: false,
      config,
      errors: [...(dryRunResult.errors || []), `Missing config: ${config.missing.join(', ')}`],
    };
  }

  if (!liveRequested) {
    return {
      ...dryRunResult,
      config,
      dryRun: true,
    };
  }

  const published = await connector.publish(request);
  return { ...published, config, dryRun: false };
}
