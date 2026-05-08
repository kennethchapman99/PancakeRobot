import { normalizeAssetType, normalizeSocialPlatform } from './social-types.js';

function isLocalHostname(hostname) {
  return (
    hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname.endsWith('.local')
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}

export function isPublicHttpsUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

export function buildPublicAssetUrl(assetUrl, publicBaseUrl) {
  if (!assetUrl) return '';
  if (/^https?:\/\//i.test(assetUrl)) return assetUrl;
  if (!publicBaseUrl) return assetUrl;
  try {
    return new URL(assetUrl, publicBaseUrl).toString();
  } catch {
    return assetUrl;
  }
}

export function validateSocialAssetRequest(request = {}, options = {}) {
  const platform = normalizeSocialPlatform(request.platform || options.platform);
  const assetType = normalizeAssetType(request.assetType || request.asset_type);
  const mode = String(options.mode || 'dry_run').toLowerCase();
  const warnings = [];
  const errors = [];
  const assetUrl = String(request.assetUrl || request.asset_url || '').trim();
  const publicAssetUrl = String(request.publicAssetUrl || request.public_asset_url || '').trim();

  if (!platform) errors.push('Unsupported platform.');
  if (!assetType) errors.push('Unsupported asset type.');
  if (!assetUrl && !publicAssetUrl) errors.push('assetUrl or publicAssetUrl is required.');

  if (publicAssetUrl) {
    try {
      const url = new URL(publicAssetUrl);
      if (!['http:', 'https:'].includes(url.protocol)) errors.push('publicAssetUrl must be http(s).');
    } catch {
      errors.push('publicAssetUrl is not a valid URL.');
    }
  }

  if (mode === 'live' && publicAssetUrl && !isPublicHttpsUrl(publicAssetUrl)) {
    errors.push('Live publishing requires a public HTTPS media URL, not localhost/private infrastructure.');
  }

  if (assetUrl && /^http:\/\//i.test(assetUrl) && mode === 'live') {
    warnings.push('assetUrl is http; prefer https or a local upload path for live publishing.');
  }

  return {
    ok: errors.length === 0,
    platform,
    assetType,
    warnings,
    errors,
    normalized: {
      ...request,
      platform,
      assetType,
      assetUrl,
      publicAssetUrl,
    },
  };
}
