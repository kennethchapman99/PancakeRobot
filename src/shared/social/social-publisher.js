import { facebookConnector } from './connectors/facebook-connector.js';
import { instagramConnector } from './connectors/instagram-connector.js';
import { youtubeConnector } from './connectors/youtube-connector.js';
import { getSocialEnv } from './social-env.js';
import { buildPublicAssetUrl, isPublicHttpsUrl } from './social-asset-validator.js';
import { ensureYouTubeVideoAsset, isYoutubeVideoPath } from './youtube-video-builder.js';

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
    privacyStatus: overrides.privacyStatus || env.youtube.defaultPrivacyStatus || 'private',
    ...overrides,
  };
}

function safeYoutubePublicAssetUrl(value = '') {
  return isPublicHttpsUrl(value) ? value : '';
}

async function prepareYouTubePublishRequest(post, request, env, overrides = {}) {
  if (String(post.platform || request.platform || '').toLowerCase() !== 'youtube') {
    return { request, assetPatch: null, youtubeAsset: null };
  }

  const alreadyVideo = String(request.assetType || '').toLowerCase() === 'video' && isYoutubeVideoPath(request.assetUrl || request.publicAssetUrl || '');
  if (alreadyVideo) {
    const publicAssetUrl = safeYoutubePublicAssetUrl(request.publicAssetUrl);
    return {
      request: {
        ...request,
        publicAssetUrl,
      },
      assetPatch: {
        asset_type: 'video',
        asset_url: request.assetUrl,
        public_asset_url: publicAssetUrl,
      },
      youtubeAsset: {
        ok: true,
        reused: true,
        videoPath: request.assetUrl,
        videoAssetUrl: request.assetUrl,
        commandSummary: 'Existing YouTube video asset selected.',
      },
    };
  }

  const youtubeAsset = await ensureYouTubeVideoAsset({
    post,
    request,
    force: env.youtube.renderForce || Boolean(overrides.forceYoutubeRender),
    outputPath: overrides.youtubeVideoOutputPath || '',
    sourceAudioPath: overrides.sourceAudioPath || '',
    sourceImagePath: overrides.sourceImagePath || '',
    runner: overrides.youtubeVideoRunner || null,
  });

  if (!youtubeAsset.ok) {
    return {
      request,
      assetPatch: null,
      youtubeAsset,
      errorResult: {
        ok: false,
        platform: 'youtube',
        mode: env.socialPublishMode,
        dryRun: env.socialPublishMode !== 'live',
        errorCode: 'asset_validation_failed',
        errors: [youtubeAsset.error || 'Unable to build YouTube video asset.'],
        warnings: [],
        youtubeAsset,
      },
    };
  }

  const assetUrl = youtubeAsset.videoAssetUrl || youtubeAsset.videoPath;
  const publicAssetUrl = safeYoutubePublicAssetUrl(request.publicAssetUrl);
  const nextRequest = {
    ...request,
    assetType: 'video',
    assetUrl,
    publicAssetUrl,
    youtubeVideoPath: youtubeAsset.videoPath,
  };

  return {
    request: nextRequest,
    assetPatch: {
      asset_type: 'video',
      asset_url: assetUrl,
      public_asset_url: publicAssetUrl,
    },
    youtubeAsset,
  };
}

function appendConfigWarnings(result, config, liveRequested) {
  if (liveRequested || config.ok) return result;
  return {
    ...result,
    warnings: [
      ...(result.warnings || []),
      `Live publish config missing: ${config.missing.join(', ')}`,
    ],
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
  const env = getSocialEnv();
  const liveRequested = env.socialPublishMode === 'live';
  const baseRequest = buildPublishRequestFromPost(post, overrides);
  const prepared = await prepareYouTubePublishRequest(post, baseRequest, env, overrides);

  if (prepared.errorResult) {
    return { ...prepared.errorResult, config };
  }

  const request = prepared.request;
  const dryRunResult = connector.dryRun(request);
  const withAsset = {
    ...dryRunResult,
    youtubeAsset: prepared.youtubeAsset,
    assetPatch: prepared.assetPatch,
  };

  if (liveRequested && !config.ok) {
    return {
      ...withAsset,
      ok: false,
      config,
      errors: [...(withAsset.errors || []), `Missing config: ${config.missing.join(', ')}`],
    };
  }

  if (!liveRequested) {
    return appendConfigWarnings({
      ...withAsset,
      config,
      dryRun: true,
    }, config, liveRequested);
  }

  const published = await connector.publish(request);
  return {
    ...published,
    config,
    dryRun: false,
    youtubeAsset: prepared.youtubeAsset,
    assetPatch: prepared.assetPatch,
  };
}
