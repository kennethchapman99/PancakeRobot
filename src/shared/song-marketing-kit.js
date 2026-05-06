import path from 'path';
import { loadBrandProfile } from './brand-profile.js';
import { getReleaseLinks, getSong, upsertSong } from './db.js';
import { resolveDefaultBaseImage, scanMarketingPack, scanSongBaseImage } from './song-catalog-marketing.js';
import { getOutreachEvents } from './marketing-outreach-db.js';
import { getSongNextAction } from './song-workflow.js';

const BRAND_PROFILE = loadBrandProfile();
const DEFAULT_CONTACT_EMAIL = BRAND_PROFILE.marketing?.contact_email
  || BRAND_PROFILE.contact_email
  || BRAND_PROFILE.social?.contact_email
  || BRAND_PROFILE.social?.email_contact
  || 'pancakeprobotmusic@gmail.com';

export const MARKETING_LINK_FIELDS = [
  'smart_link',
  'spotify_url',
  'apple_music_url',
  'youtube_music_url',
  'youtube_video_url',
  'release_kit_url',
  'audio_download_url',
  'promo_assets_folder_url',
  'cover_art_url',
  'lyrics_url',
  'instagram_url',
  'tiktok_url',
  'artist_website_url',
  'contact_email',
];

export const MARKETING_ASSET_FIELDS = [
  'base_image_url',
  'fallback_image_url',
  'square_post_url',
  'vertical_post_url',
  'portrait_post_url',
  'outreach_banner_url',
  'cover_safe_promo_url',
  'no_text_variation_url',
  'generated_at',
  'generation_source',
];

export function getSongMarketingKit(songOrId, options = {}) {
  const song = typeof songOrId === 'string' ? getSong(songOrId) : songOrId;
  if (!song) return buildEmptyMarketingKit();

  const releaseLinks = options.releaseLinks || getReleaseLinks(song.id);
  const baseImage = options.baseImage || scanSongBaseImage(song.id);
  const marketingPack = options.marketingPack || scanMarketingPack(song.id);
  const defaults = getBrandMarketingDefaults();

  const marketing_links = normalizeMarketingLinks({
    ...deriveLinksFromSong(song, releaseLinks),
    ...song.marketing_links,
  }, defaults);
  if (!marketing_links.release_kit_url && song.marketing_assets?.release_kit_published) {
    marketing_links.release_kit_url = buildReleaseKitPath(song.id);
  }

  const marketing_assets = normalizeMarketingAssets({
    ...deriveAssetsFromSong(song, marketingPack, baseImage, marketing_links, defaults),
    ...song.marketing_assets,
  }, defaults);

  if (!marketing_assets.base_image_url && baseImage?.url) marketing_assets.base_image_url = baseImage.url;
  const imageSelection = resolveMarketingImageSelection(marketing_assets, marketing_links, defaults, baseImage, song.id);
  marketing_assets.fallback_image_url = imageSelection.fallback_image_url;
  marketing_assets.generation_source = imageSelection.generation_source;

  const last_outreach = normalizeLastOutreach(song.last_outreach, song.id);
  const marketing_readiness = computeMarketingReadiness({
    links: marketing_links,
    assets: marketing_assets,
    lastOutreach: last_outreach,
  });
  const next_action = getSongNextAction(song, {
    marketing_links,
    marketing_assets,
    marketing_readiness,
  });

  return {
    marketing_links,
    marketing_assets,
    marketing_readiness,
    last_outreach,
    next_action,
    defaults,
    image_source: imageSelection,
    validation: validateMarketingKit({ links: marketing_links, assets: marketing_assets }),
    outreach_link_block: buildOutreachLinkBlock({ links: marketing_links }),
  };
}

export function saveSongMarketingKit(songId, input = {}) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  const existing = getSongMarketingKit(song);
  const requestedPublished = input.release_kit_published ?? input.marketing_assets?.release_kit_published;
  const marketing_links = normalizeMarketingLinks({ ...existing.marketing_links, ...pickFields(input.marketing_links || input, MARKETING_LINK_FIELDS) }, existing.defaults);
  const marketing_assets = normalizeMarketingAssets({
    ...existing.marketing_assets,
    ...pickFields(input.marketing_assets || input, MARKETING_ASSET_FIELDS),
    release_kit_published: booleanOrNull(requestedPublished, existing.marketing_assets.release_kit_published),
    release_kit_last_saved_at: new Date().toISOString(),
  }, existing.defaults);
  if (!marketing_links.release_kit_url && marketing_assets.release_kit_published) {
    marketing_links.release_kit_url = buildReleaseKitPath(songId);
  }
  const imageSelection = resolveMarketingImageSelection(marketing_assets, marketing_links, existing.defaults, null, songId);
  marketing_assets.fallback_image_url = imageSelection.fallback_image_url;
  marketing_assets.generation_source = imageSelection.generation_source;
  const last_outreach = normalizeLastOutreach(song.last_outreach, songId);
  const marketing_readiness = computeMarketingReadiness({ links: marketing_links, assets: marketing_assets, lastOutreach: last_outreach });

  upsertSong({
    id: songId,
    marketing_links,
    marketing_assets,
    marketing_readiness,
    last_outreach: last_outreach,
  });

  return getSongMarketingKit(songId);
}

export function syncSongMarketingKitFromPack(songId, options = {}) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  const kit = getSongMarketingKit(songId);
  const marketingPack = options.marketingPack || scanMarketingPack(songId);
  const generated = Array.isArray(marketingPack?.meta?.generated_assets) ? marketingPack.meta.generated_assets : [];
  const byName = name => generated.find(asset => String(asset.name || '').toLowerCase() === name.toLowerCase());
  const baseImage = options.baseImage || scanSongBaseImage(songId);
  const assets = {
    ...kit.marketing_assets,
    base_image_url: kit.marketing_assets.base_image_url || baseImage?.url || null,
    square_post_url: pathToMediaUrl(byName('ig-square-post-1080x1080.png')?.path) || kit.marketing_assets.square_post_url || null,
    vertical_post_url: pathToMediaUrl(byName('tiktok-cover.jpg')?.path) || pathToMediaUrl(byName('ig-reel-cover.jpg')?.path) || kit.marketing_assets.vertical_post_url || null,
    portrait_post_url: pathToMediaUrl(byName('ig-feed-announcement-1080x1350.png')?.path) || kit.marketing_assets.portrait_post_url || null,
    outreach_banner_url: pathToMediaUrl(byName('outreach-hero-1600x900.png')?.path) || kit.marketing_assets.outreach_banner_url || null,
    cover_safe_promo_url: pathToMediaUrl(byName('ig-reel-cover.jpg')?.path) || kit.marketing_assets.cover_safe_promo_url || null,
    no_text_variation_url: pathToMediaUrl(byName('no-text-variation.png')?.path) || kit.marketing_assets.no_text_variation_url || null,
    generated_at: marketingPack?.meta?.generated_at || kit.marketing_assets.generated_at || null,
  };
  return saveSongMarketingKit(songId, {
    marketing_links: kit.marketing_links,
    marketing_assets: assets,
  });
}

export function validateMarketingKit({ links = {}, assets = {} } = {}) {
  const warnings = [];
  const errors = [];

  for (const field of MARKETING_LINK_FIELDS.filter(field => field !== 'contact_email')) {
    const value = String(links[field] || '').trim();
    if (!value) continue;
    const check = validateUrlValue(value);
    if (check.error) errors.push(`${field}: ${check.error}`);
    else warnings.push(...check.warnings.map(w => `${field}: ${w}`));
  }

  if (links.contact_email) {
    const email = String(links.contact_email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('contact_email: invalid email format');
  }

  for (const field of ['base_image_url', 'square_post_url', 'vertical_post_url', 'portrait_post_url', 'outreach_banner_url', 'cover_safe_promo_url', 'no_text_variation_url']) {
    const value = String(assets[field] || '').trim();
    if (!value) continue;
    const check = validateUrlValue(value);
    if (check.error) errors.push(`${field}: ${check.error}`);
    else warnings.push(...check.warnings.map(w => `${field}: ${w}`));
  }

  return { warnings, errors };
}

export function computeMarketingReadiness({ links = {}, assets = {}, lastOutreach = {} } = {}) {
  let score = 100;
  const missing_required_fields = [];
  const missing_recommended_fields = [];
  const warnings = [];

  if (!links.smart_link) { score -= 20; missing_required_fields.push('smart_link'); warnings.push('No smart link; outreach will fall back to individual platform links.'); }
  if (!links.instagram_url && !links.tiktok_url) { score -= 10; missing_recommended_fields.push('social_links'); }
  if (!links.contact_email) { score -= 10; missing_required_fields.push('contact_email'); }
  if (!hasAnyStreamingLink(links)) { missing_required_fields.push('streaming_link'); warnings.push('No streaming links captured yet.'); }
  if (!hasVisualSource(assets)) { score -= 10; missing_required_fields.push('base_or_fallback_image'); warnings.push('No base image or brand logo available'); }
  if (!hasGeneratedVisual(assets)) missing_required_fields.push('social_asset_set');

  if (!hasGeneratedVisual(assets)) warnings.push('Phase 1 outreach requires generated release assets.');
  if (!links.release_kit_url) warnings.push('Release kit URL is optional in phase 1 and mainly useful for blog/media outreach later.');
  if (!links.audio_download_url) warnings.push('Audio download URL is optional in phase 1 and mainly useful for radio/podcast outreach later.');
  if (!links.promo_assets_folder_url) warnings.push('Promo assets folder URL is optional in phase 1 and can be added later.');

  return {
    score: Math.max(score, 0),
    missing_required_fields,
    missing_recommended_fields,
    warnings: [...new Set(warnings)],
    last_checked_at: new Date().toISOString(),
    last_outreach_at: lastOutreach?.datetime || null,
  };
}

export function buildOutreachLinkBlock({ links = {}, outreachType = 'general', audience = '' } = {}) {
  const lines = [];
  const add = (label, value) => { if (value) lines.push(`${label}: ${value}`); };
  const youtube = links.youtube_video_url || links.youtube_music_url || null;
  const type = String(outreachType || 'general').toLowerCase();
  const useDownloadLink = ['radio', 'podcast', 'review', 'playlist_submission', 'playlist submission', 'media'].includes(type);

  if (type === 'playlist' || type === 'playlist_submission' || type === 'playlist submission') {
    add('Listen / stream', links.smart_link);
    add('Spotify', links.spotify_url);
    add('YouTube', youtube);
    if (useDownloadLink) add('Download audio', links.audio_download_url);
  } else if (type === 'radio' || type === 'podcast') {
    add('Download audio', links.audio_download_url);
    add('Listen / stream', links.smart_link);
    add('Contact', links.contact_email);
  } else if (type === 'blog' || type === 'media' || type === 'review') {
    add('Release kit', links.release_kit_url);
    add('Promo assets', links.promo_assets_folder_url);
    add('Listen / stream', links.smart_link);
    if (useDownloadLink) add('Download audio', links.audio_download_url);
  } else if (type === 'social' || type === 'influencer') {
    add('Listen / stream', links.smart_link);
    add('Spotify', links.spotify_url);
    add('YouTube', youtube);
    add('Instagram', links.instagram_url);
    add('TikTok', links.tiktok_url);
    add('Contact', links.contact_email);
  } else {
    add('Listen / stream', links.smart_link);
    add('Spotify', links.spotify_url);
    add('YouTube', youtube);
    add('Instagram', links.instagram_url);
    add('TikTok', links.tiktok_url);
    add('Contact', links.contact_email);
  }

  if (/\b(kids|family|children|parents)\b/i.test(audience || '')) add('Lyrics', links.lyrics_url);
  add('Apple Music', lines.some(line => line.startsWith('Apple Music:')) ? null : links.apple_music_url);
  add('Artist website', links.artist_website_url);
  add('Instagram', lines.some(line => line.startsWith('Instagram:')) ? null : links.instagram_url);
  add('TikTok', lines.some(line => line.startsWith('TikTok:')) ? null : links.tiktok_url);
  add('Contact', lines.some(line => line.startsWith('Contact:')) ? null : links.contact_email);

  return lines.join('\n');
}

export function buildReleaseKitViewModel(songOrId) {
  const song = typeof songOrId === 'string' ? getSong(songOrId) : songOrId;
  if (!song) return null;
  const kit = getSongMarketingKit(song);
  const releaseLinks = getReleaseLinks(song.id);
  return {
    song,
    title: song.title || song.topic || song.id,
    artistName: BRAND_PROFILE.distribution?.default_artist || BRAND_PROFILE.brand_name,
    releaseDate: song.release_date || null,
    shortDescription: song.topic || song.concept || '',
    longDescription: song.notes || song.concept || '',
    streamingLinks: [
      { label: 'Smart link', url: kit.marketing_links.smart_link },
      { label: 'Spotify', url: kit.marketing_links.spotify_url },
      { label: 'Apple Music', url: kit.marketing_links.apple_music_url },
      { label: 'YouTube Music', url: kit.marketing_links.youtube_music_url },
      { label: 'YouTube', url: kit.marketing_links.youtube_video_url },
      ...releaseLinks.map(link => ({ label: link.platform, url: link.url })),
    ].filter(link => link.url).filter(uniqueUrlFilter()),
    kit,
    usageNote: 'Approved images and copy for coverage, playlisting, and social sharing',
  };
}

export function updateSongLastOutreach(songId, lastOutreachPatch = {}) {
  const song = getSong(songId);
  if (!song) return null;
  const merged = normalizeLastOutreach({ ...song.last_outreach, ...lastOutreachPatch }, songId);
  upsertSong({ id: songId, last_outreach: merged });
  return merged;
}

function buildEmptyMarketingKit() {
  const defaults = getBrandMarketingDefaults();
  const links = normalizeMarketingLinks({}, defaults);
  const assets = normalizeMarketingAssets({}, defaults);
  const marketing_readiness = computeMarketingReadiness({ links, assets, lastOutreach: {} });
  return {
    marketing_links: links,
    marketing_assets: assets,
    marketing_readiness,
    last_outreach: normalizeLastOutreach({}, null),
    next_action: getSongNextAction(null, {
      marketing_links: links,
      marketing_assets: assets,
      marketing_readiness,
    }),
    defaults,
    validation: { warnings: [], errors: [] },
    outreach_link_block: buildOutreachLinkBlock({ links }),
  };
}

function deriveLinksFromSong(song, releaseLinks = []) {
  const map = Object.fromEntries(releaseLinks.map(link => [String(link.platform || '').toLowerCase(), link.url]));
  return {
    smart_link: map.hyperfollow || map.distrokid || '',
    spotify_url: map.spotify || '',
    apple_music_url: map['apple music'] || '',
    youtube_music_url: map['youtube music'] || '',
    youtube_video_url: map.youtube || '',
    cover_art_url: map['cover art'] || '',
    lyrics_url: map.lyrics || '',
  };
}

function deriveAssetsFromSong(song, marketingPack, baseImage, links, defaults) {
  const generated = Array.isArray(marketingPack?.meta?.generated_assets) ? marketingPack.meta.generated_assets : [];
  const find = needle => generated.find(asset => String(asset.name || '').toLowerCase() === needle.toLowerCase());
  return {
    base_image_url: baseImage?.url || null,
    fallback_image_url: resolveMarketingImageSelection({}, links, defaults, baseImage, song.id).fallback_image_url,
    square_post_url: pathToMediaUrl(find('ig-square-post-1080x1080.png')?.path) || null,
    vertical_post_url: pathToMediaUrl(find('tiktok-cover.jpg')?.path) || pathToMediaUrl(find('ig-reel-cover.jpg')?.path) || null,
    portrait_post_url: pathToMediaUrl(find('ig-feed-announcement-1080x1350.png')?.path) || null,
    outreach_banner_url: pathToMediaUrl(find('outreach-hero-1600x900.png')?.path) || null,
    cover_safe_promo_url: pathToMediaUrl(find('ig-reel-cover.jpg')?.path) || null,
    no_text_variation_url: pathToMediaUrl(find('no-text-variation.png')?.path) || null,
    generated_at: marketingPack?.meta?.generated_at || null,
    generation_source: resolveMarketingImageSelection({ base_image_url: baseImage?.url || null }, links, defaults, baseImage, song.id).generation_source,
    release_kit_published: false,
    release_kit_last_saved_at: null,
  };
}

function normalizeMarketingLinks(value = {}, defaults = {}) {
  const links = {};
  for (const field of MARKETING_LINK_FIELDS) {
    links[field] = cleanString(value[field] ?? defaults.marketing_links[field] ?? '');
  }
  return links;
}

function normalizeMarketingAssets(value = {}, defaults = {}) {
  const assets = {};
  for (const field of MARKETING_ASSET_FIELDS) {
    assets[field] = cleanString(value[field] ?? defaults.marketing_assets[field] ?? '');
  }
  assets.release_kit_published = Boolean(value.release_kit_published);
  assets.release_kit_last_saved_at = value.release_kit_last_saved_at || null;
  assets.asset_approvals = value.asset_approvals && typeof value.asset_approvals === 'object' ? value.asset_approvals : {};
  return assets;
}

function normalizeLastOutreach(value = {}, songId) {
  const latestEvent = songId ? getOutreachEvents({ song_id: songId })[0] : null;
  return {
    datetime: cleanString(value.datetime || latestEvent?.contacted_at || ''),
    release_id: cleanString(value.release_id || latestEvent?.release_id || songId || ''),
    release_title: cleanString(value.release_title || latestEvent?.release_title || ''),
    message_summary: cleanString(value.message_summary || latestEvent?.subject || latestEvent?.notes || ''),
    recipient_count: Number.isFinite(Number(value.recipient_count)) ? Number(value.recipient_count) : null,
  };
}

function getBrandMarketingDefaults() {
  const social = BRAND_PROFILE.social || {};
  const marketing = BRAND_PROFILE.marketing || {};
  return {
    marketing_links: {
      smart_link: '',
      spotify_url: '',
      apple_music_url: '',
      youtube_music_url: '',
      youtube_video_url: '',
      release_kit_url: '',
      audio_download_url: '',
      promo_assets_folder_url: '',
      cover_art_url: '',
      lyrics_url: '',
      instagram_url: social.instagram_url || '',
      tiktok_url: social.tiktok_url || '',
      artist_website_url: social.website_url || BRAND_PROFILE.website_url || '',
      contact_email: marketing.contact_email || social.contact_email || social.email_contact || DEFAULT_CONTACT_EMAIL,
    },
    marketing_assets: {
      base_image_url: '',
      fallback_image_url: marketing.default_marketing_image_url || '',
      square_post_url: '',
      vertical_post_url: '',
      portrait_post_url: '',
      outreach_banner_url: '',
      cover_safe_promo_url: '',
      no_text_variation_url: '',
      generated_at: '',
      generation_source: '',
    },
  };
}

function resolveMarketingImageSelection(assets = {}, links = {}, defaults = {}, baseImage = null, songId = '') {
  const releaseBaseImageUrl = cleanString(assets.base_image_url || baseImage?.url || '');
  const coverArtUrl = cleanString(links.cover_art_url || '');
  const brandDefaultImageUrl = cleanString(defaults.marketing_assets?.fallback_image_url || '');
  const brandLogoUrl = cleanString(publicLogoUrl());
  const defaultBaseImageUrl = cleanString(resolveDefaultBaseImage(songId || baseImage?.songId || '')?.url || '');

  if (releaseBaseImageUrl) {
    return {
      active_image_url: releaseBaseImageUrl,
      fallback_image_url: coverArtUrl || defaultBaseImageUrl || brandDefaultImageUrl || brandLogoUrl || '',
      generation_source: 'release_base_image',
      source_label: 'Release base image',
      warning: '',
    };
  }
  if (coverArtUrl) {
    return {
      active_image_url: coverArtUrl,
      fallback_image_url: coverArtUrl,
      generation_source: 'cover_art',
      source_label: 'Cover art fallback',
      warning: '',
    };
  }
  if (defaultBaseImageUrl) {
    return {
      active_image_url: defaultBaseImageUrl,
      fallback_image_url: defaultBaseImageUrl,
      generation_source: 'default_base_image_pool',
      source_label: 'Default base image library',
      warning: 'Using default base image library because no release-specific base image was supplied.',
    };
  }
  if (brandDefaultImageUrl) {
    return {
      active_image_url: brandDefaultImageUrl,
      fallback_image_url: brandDefaultImageUrl,
      generation_source: 'brand_default',
      source_label: 'Brand default marketing image',
      warning: '',
    };
  }
  if (brandLogoUrl) {
    return {
      active_image_url: brandLogoUrl,
      fallback_image_url: brandLogoUrl,
      generation_source: 'brand_logo',
      source_label: 'Brand logo fallback',
      warning: '',
    };
  }
  return {
    active_image_url: '',
    fallback_image_url: '',
    generation_source: null,
    source_label: 'Missing',
    warning: 'No base image or brand logo available',
  };
}

function hasAnyStreamingLink(links = {}) {
  return Boolean(links.smart_link || links.spotify_url || links.apple_music_url || links.youtube_music_url || links.youtube_video_url);
}

function hasVisualSource(assets = {}) {
  return Boolean(assets.base_image_url || assets.fallback_image_url);
}

function hasGeneratedVisual(assets = {}) {
  return Boolean(assets.square_post_url || assets.vertical_post_url || assets.portrait_post_url || assets.outreach_banner_url || assets.cover_safe_promo_url || assets.no_text_variation_url);
}

function validateUrlValue(value) {
  if (String(value).startsWith('/')) {
    const warnings = [];
    if (!String(value).startsWith('/release-kit/') && !String(value).startsWith('/media/') && !String(value).startsWith('/logo')) {
      warnings.push('relative URL may not be public-facing outside this app');
    }
    return { warnings };
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return { error: 'must be an http(s) URL', warnings: [] };
    const warnings = [];
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) warnings.push('URL may not be public-facing');
    if (/^(10|172\.(1[6-9]|2\d|3[0-1])|192\.168)\./.test(url.hostname)) warnings.push('URL points to a private network');
    if (value.includes('/Users/') || value.includes('output/')) warnings.push('looks like an internal file path, not a public URL');
    return { warnings };
  } catch {
    return { error: 'invalid URL format', warnings: [] };
  }
}

function buildReleaseKitPath(songId) {
  return `/release-kit/${encodeURIComponent(songId)}`;
}

function pathToMediaUrl(relativePath) {
  if (!relativePath) return null;
  const normalized = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.startsWith('output/') ? `/media/${normalized.slice('output/'.length)}` : normalized.startsWith('/media/') ? normalized : null;
}

function publicLogoUrl() {
  const logo = BRAND_PROFILE.marketing?.logo_url || BRAND_PROFILE.ui?.logo_url || BRAND_PROFILE.ui?.logo_path || '/logo.png';
  return logo.startsWith('http://') || logo.startsWith('https://') ? logo : logo.startsWith('/') ? logo : `/${logo}`;
}

function cleanString(value) {
  return String(value || '').trim();
}

function pickFields(input = {}, fields = []) {
  return Object.fromEntries(
    fields
      .filter(field => input[field] !== undefined)
      .map(field => [field, input[field]])
  );
}

function uniqueUrlFilter() {
  const seen = new Set();
  return (entry) => {
    const key = entry?.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function booleanOrNull(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'on', 'yes'].includes(String(value).toLowerCase());
}
