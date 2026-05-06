import { loadBrandProfile } from './brand-profile.js';
import { getBundleMarketingPack, getReleaseMarketingPack } from './release-marketing-pack.js';
import { getAllSongs, getReleaseLinks } from './db.js';
import { buildOutreachLinkBlock } from './song-marketing-kit.js';

const BRAND_PROFILE = loadBrandProfile();

export function buildBrandSocialLinks({ releaseLinks = [] } = {}) {
  const social = BRAND_PROFILE.social || {};
  const links = [];

  pushLink(links, 'Facebook', social.facebook_url || inferFacebookUrl(social));
  pushLink(links, 'YouTube', social.youtube_channel_url || social.youtube_url || findReleaseLink(releaseLinks, ['youtube']) || getCatalogPlatformLink(['youtube']));
  pushLink(links, 'Spotify', social.spotify_artist_url || findReleaseLink(releaseLinks, ['spotify']) || getCatalogPlatformLink(['spotify']));
  pushLink(links, 'Apple Music', social.apple_music_artist_url || social.apple_music_url || findReleaseLink(releaseLinks, ['apple music']) || getCatalogPlatformLink(['apple music']));
  pushLink(links, 'Instagram', social.instagram_url);
  pushLink(links, 'TikTok', social.tiktok_url);

  return dedupeLinks(links);
}

export function buildAttachmentPlanForOutreachItem(item) {
  const packs = getPacksForItem(item);
  const primaryPack = packs[0] || {};
  const outreachType = item.outlet_context?.type || item.outlet_context?.category || 'general';
  const audience = item.release_context?.[0]?.target_age_range || '';

  return {
    attachments: [],
    attachedLabels: [],
    socialLinks: buildBrandSocialLinks({
      releaseLinks: packs.flatMap(pack => pack.streaming_links || []),
    }),
    releaseLinks: dedupeLinks(
      packs.flatMap(pack => (pack.streaming_links || []).map(link => ({
        label: link.platform,
        url: link.url,
      })))
    ),
    outreachLinkBlock: buildOutreachLinkBlock({
      links: primaryPack.marketing_links || {},
      outreachType,
      audience,
    }),
    marketingLinks: primaryPack.marketing_links || {},
  };
}

function getPacksForItem(item) {
  if (item.outreach_mode === 'bundle' && Array.isArray(item.bundle_song_ids) && item.bundle_song_ids.length) {
    const bundle = getBundleMarketingPack(item.bundle_song_ids);
    return bundle.releases || [];
  }

  if (item.song_id) return [getReleaseMarketingPack(item.song_id)];

  const releaseId = item.release_context?.[0]?.id;
  return releaseId ? [getReleaseMarketingPack(releaseId)] : [];
}

function pushLink(target, label, url) {
  if (!url) return;
  target.push({ label, url });
}

function dedupeLinks(links = []) {
  const seen = new Set();
  return links.filter(link => {
    const key = String(link.url || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findReleaseLink(links = [], names = []) {
  const wanted = new Set(names.map(name => String(name).toLowerCase()));
  const match = links.find(link => wanted.has(String(link.platform || '').toLowerCase()));
  return match?.url || null;
}

function inferFacebookUrl(social = {}) {
  const url = social.website_url || social.url || null;
  return /facebook\.com/i.test(String(url || '')) ? url : null;
}

function getCatalogPlatformLink(platforms = []) {
  const wanted = new Set(platforms.map(name => String(name).toLowerCase()));
  for (const song of getAllSongs()) {
    const match = getReleaseLinks(song.id).find(link => wanted.has(String(link.platform || '').toLowerCase()));
    if (match?.url) return match.url;
  }
  return null;
}
