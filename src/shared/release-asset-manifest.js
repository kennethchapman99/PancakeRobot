import { loadBrandProfile } from './brand-profile.js';

const FALLBACK_SOCIAL_HANDLE = '@pancakerobotmusic';

const HANDLE_URL_PATTERNS = [
  /instagram\.com\/@?([A-Za-z0-9._]+)/i,
  /tiktok\.com\/@?([A-Za-z0-9._]+)/i,
  /youtube\.com\/@([A-Za-z0-9._-]+)/i,
  /facebook\.com\/([A-Za-z0-9._-]+)/i,
];

const ASSET_LABELS = {
  'spotify-cover-3000x3000.png': 'Spotify / DSP Cover',
  'youtube-thumbnail-1280x720.png': 'YouTube Thumbnail',
  'instagram-square-1080x1080.png': 'Instagram Square Post',
  'instagram-vertical-1080x1920.png': 'Instagram Story / Reel Asset',
  'facebook-post-1200x630.png': 'Facebook Post Image',
  'ig-square-post-1080x1080.png': 'Square Instagram Post',
  'ig-feed-announcement-1080x1350.png': 'Portrait Instagram Feed',
  'tiktok-cover.jpg': 'Vertical TikTok / Reels Cover',
  'outreach-hero-1600x900.png': 'Outreach Banner',
  'ig-reel-cover.jpg': 'Cover-safe Promo',
  'no-text-variation.png': 'No-text Variation',
  'captions.md': 'Caption Seed',
  'upload-checklist.md': 'Upload Checklist',
  'marketing-qa-report.json': 'QA Report',
  'metadata.json': 'Release Asset Manifest',
  'index.html': 'Static Pack Preview',
};

function cleanString(value) {
  return String(value || '').trim();
}

export function extractSocialHandleFromUrl(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  for (const pattern of HANDLE_URL_PATTERNS) {
    const match = raw.match(pattern);
    if (match?.[1]) return normalizeSocialHandle(match[1]);
  }
  return null;
}

export function normalizeSocialHandle(value, fallback = FALLBACK_SOCIAL_HANDLE) {
  const raw = cleanString(value);
  if (!raw) return fallback;
  const withoutProtocol = raw.replace(/^https?:\/\//i, '');
  const fromUrl = extractSocialHandleFromUrl(withoutProtocol);
  if (fromUrl) return fromUrl;
  const normalized = raw.startsWith('@') ? raw : `@${raw.replace(/^@+/, '')}`;
  if (normalized.toLowerCase() === '@pancakerobot') return FALLBACK_SOCIAL_HANDLE;
  return normalized;
}

export function resolveCanonicalSocialHandle(options = {}) {
  const {
    brandProfile = loadBrandProfile(),
    socialHandle = null,
    marketingLinks = {},
    release = {},
    envHandle = process.env.MARKETING_DEFAULT_HANDLE,
  } = options;

  const releasePack = release.asset_pack || {};
  const releaseDistribution = release.distribution || {};
  const releaseSocial = release.social || {};
  const social = brandProfile.social || {};

  const candidates = [
    socialHandle,
    releaseSocial.handle,
    releasePack.socialHandle,
    releaseDistribution.socialHandle,
    marketingLinks.social_handle,
    extractSocialHandleFromUrl(marketingLinks.instagram_url),
    extractSocialHandleFromUrl(marketingLinks.tiktok_url),
    extractSocialHandleFromUrl(marketingLinks.artist_website_url),
    extractSocialHandleFromUrl(social.instagram_url),
    extractSocialHandleFromUrl(social.tiktok_url),
    extractSocialHandleFromUrl(social.youtube_channel_url),
    extractSocialHandleFromUrl(social.website_url),
    envHandle,
    FALLBACK_SOCIAL_HANDLE,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeSocialHandle(candidate, '');
    if (normalized) return normalized;
  }
  return FALLBACK_SOCIAL_HANDLE;
}

function toMediaUrl(pathValue) {
  const normalized = cleanString(pathValue).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  if (normalized.startsWith('/media/')) return normalized;
  if (normalized.startsWith('output/')) return `/media/${normalized.slice('output/'.length)}`;
  return null;
}

function inferDimensions(value) {
  const match = cleanString(value).match(/(\d{3,5})x(\d{3,5})/i);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function inferPlatformFit(value = '') {
  const lower = cleanString(value).toLowerCase();
  const fits = [];
  if (lower.includes('square') || lower.includes('1080x1080')) fits.push('instagram', 'facebook');
  if (lower.includes('1350')) fits.push('instagram');
  if (lower.includes('tiktok') || lower.includes('reel') || lower.includes('story') || lower.includes('vertical')) fits.push('tiktok', 'instagram', 'youtube');
  if (lower.includes('hero') || lower.includes('banner') || lower.includes('1600x900')) fits.push('youtube', 'facebook', 'email');
  if (lower.endsWith('.md') || lower.endsWith('.json') || lower.endsWith('.html')) fits.push('email', 'internal');
  return [...new Set(fits)];
}

function inferAssetKind(asset = {}) {
  const lower = cleanString(asset.name || asset.filePath || asset.path || asset.pathOrUrl || asset.publicUrl).toLowerCase();
  if (asset.type === 'video' || lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm')) return 'video';
  if (lower.endsWith('.md')) return 'document';
  if (lower.endsWith('.json')) return 'metadata';
  if (lower.endsWith('.html')) return 'preview';
  return 'image';
}

function assetLabel(asset = {}) {
  const name = cleanString(asset.name || asset.filePath || asset.path || asset.pathOrUrl || asset.publicUrl).split('/').pop();
  return ASSET_LABELS[name] || asset.name || name || asset.id || 'Generated Asset';
}

function buildManifestAsset(asset, extra = {}) {
  const filePath = cleanString(asset.filePath || asset.path || asset.pathOrUrl || '');
  const kind = inferAssetKind(asset);
  return {
    id: asset.id || `asset_${assetLabel(asset).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    type: asset.type || inferAssetKind(asset),
    kind,
    label: asset.label || assetLabel(asset),
    filePath: filePath || null,
    publicUrl: asset.publicUrl || toMediaUrl(filePath),
    dimensions: asset.dimensions || inferDimensions(asset.name || filePath || asset.publicUrl),
    platformFit: Array.isArray(asset.platformFit) ? asset.platformFit : inferPlatformFit(asset.name || filePath || asset.publicUrl),
    altText: asset.altText || null,
    captionSeed: asset.captionSeed || null,
    status: asset.status || 'generated',
    previewable: asset.previewable ?? ['image', 'video'].includes(kind),
    sourceArtworkUsed: asset.sourceArtworkUsed ?? null,
    promptUsed: asset.promptUsed || null,
    format: asset.format || cleanString(asset.name || filePath || asset.publicUrl || '').split('/').pop() || null,
    ...extra,
  };
}

export function buildReleaseAssetManifest({
  songId,
  releaseId = null,
  title,
  artist,
  brand = null,
  socialHandle,
  generatedAt,
  baseImage = null,
  baseImageSource = null,
  dashboardUrl = null,
  releaseKitUrl = null,
  generatedAssets = [],
  qaStatus = null,
  qaWarnings = [],
  qaFailures = [],
  mode = 'default',
}) {
  const assets = generatedAssets.map(asset => buildManifestAsset(asset, {
    altText: asset.altText || `${title} promo asset for ${artist}`,
    captionSeed: asset.captionSeed || `${title} is out now from ${socialHandle}.`,
  }));

  return {
    songId,
    releaseId,
    title,
    artist,
    brand,
    socialHandle: resolveCanonicalSocialHandle({ socialHandle }),
    generatedAt,
    mode,
    dashboardUrl,
    releaseKitUrl,
    baseImage,
    baseImageSource,
    qaStatus,
    qaWarnings,
    qaFailures,
    assets,
  };
}

export function normalizeReleaseAssetManifest(songId, raw = null) {
  if (!raw || typeof raw !== 'object') {
    return {
      songId,
      releaseId: null,
      title: '',
      artist: '',
      brand: '',
      socialHandle: FALLBACK_SOCIAL_HANDLE,
      generatedAt: null,
      dashboardUrl: null,
      releaseKitUrl: `/release-kit/${encodeURIComponent(songId)}?preview=1`,
      baseImage: null,
      baseImageSource: null,
      qaStatus: null,
      qaWarnings: [],
      qaFailures: [],
      assets: [],
    };
  }

  const generatedAssets = Array.isArray(raw.assets)
    ? raw.assets
    : Array.isArray(raw.generated_assets)
      ? raw.generated_assets
      : [];

  const manifest = {
    songId: raw.songId || raw.song_id || songId,
    releaseId: raw.releaseId || raw.release_id || null,
    title: raw.title || '',
    artist: raw.artist || raw.artistName || '',
    brand: raw.brand || raw.artist || '',
    socialHandle: resolveCanonicalSocialHandle({ socialHandle: raw.socialHandle || raw.handle }),
    generatedAt: raw.generatedAt || raw.generated_at || null,
    dashboardUrl: raw.dashboardUrl || raw.dashboard_url || null,
    releaseKitUrl: raw.releaseKitUrl || raw.release_kit_url || `/release-kit/${encodeURIComponent(songId)}?preview=1`,
    baseImage: raw.baseImage || (raw.base_image_path ? { path: raw.base_image_path, publicUrl: toMediaUrl(raw.base_image_path) } : null),
    baseImageSource: raw.baseImageSource || raw.base_image_source || null,
    qaStatus: raw.qaStatus || raw.qa_status || null,
    qaWarnings: raw.qaWarnings || raw.qa_warnings || [],
    qaFailures: raw.qaFailures || raw.qa_failures || [],
    assets: generatedAssets.map(asset => buildManifestAsset(asset)),
  };

  return manifest;
}

export function appendCacheBust(url, version) {
  const cleanUrl = cleanString(url);
  if (!cleanUrl) return '';
  const cleanVersion = cleanString(version);
  if (!cleanVersion) return cleanUrl;
  return `${cleanUrl}${cleanUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(cleanVersion)}`;
}
