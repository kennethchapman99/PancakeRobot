import { loadBrandProfile } from '../shared/brand-profile.js';

const BRAND = loadBrandProfile();

const DEFAULT_SOCIAL_LINKS = {
  youtube: 'https://www.youtube.com/@pancakerobotmusic',
  instagram: 'https://www.instagram.com/pancakerobotmusic',
  tiktok: 'https://www.tiktok.com/@pancakerobotmusic',
  facebook: 'https://www.facebook.com/pancakerobotmusic',
};

function compact(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.map(value => compact(value)).filter(Boolean))];
}

function isPublicFanFacingLink(value = '') {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return false;
  if (/distrokid\.com\/dashboard/i.test(url)) return false;
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url)) return false;
  return true;
}

function pickLink(kit) {
  const candidates = [
    kit?.marketing_links?.smart_link,
    kit?.marketing_links?.release_kit_url,
    kit?.marketing_links?.youtube_video_url,
  ];
  return candidates.find(isPublicFanFacingLink) || '';
}

function socialLink(envName, fallback) {
  return compact(process.env[envName] || fallback);
}

function getSocialLinks() {
  return {
    youtube: socialLink('PANCAKE_SOCIAL_YOUTUBE_URL', DEFAULT_SOCIAL_LINKS.youtube),
    instagram: socialLink('PANCAKE_SOCIAL_INSTAGRAM_URL', DEFAULT_SOCIAL_LINKS.instagram),
    tiktok: socialLink('PANCAKE_SOCIAL_TIKTOK_URL', DEFAULT_SOCIAL_LINKS.tiktok),
    facebook: socialLink('PANCAKE_SOCIAL_FACEBOOK_URL', DEFAULT_SOCIAL_LINKS.facebook),
  };
}

function buildSocialLinkBlock() {
  const links = getSocialLinks();
  return [
    'Follow Pancake Robot:',
    `YouTube: ${links.youtube}`,
    `Instagram: ${links.instagram}`,
    `TikTok: ${links.tiktok}`,
    `Facebook: ${links.facebook}`,
  ].join('\n');
}

function buildTopicPhrase(song) {
  return compact(song.topic || song.concept || song.title || 'a new Pancake Robot song');
}

function buildHashtags(song) {
  return unique([
    '#PancakeRobot',
    '#KindieMusic',
    '#FamilyMusic',
    '#KidsMusic',
    '#ParentFriendly',
    song.title ? `#${song.title.replace(/[^a-z0-9]+/gi, '')}` : '',
    song.topic ? `#${song.topic.split(/\s+/).slice(0, 2).join('').replace(/[^a-z0-9]/gi, '')}` : '',
    '#YouTubeShorts',
    '#InstagramReels',
    '#MadeForFamilies',
  ]).slice(0, 10);
}

export function generateSocialCopy({ platform, song, marketingKit, campaignType, assetType, madeForKids }) {
  const brandName = BRAND.brand_name || 'Pancake Robot';
  const songTitle = compact(song.title || song.topic || song.id, song.id);
  const topic = buildTopicPhrase(song);
  const releaseLink = pickLink(marketingKit);
  const hashtags = buildHashtags(song);
  const callToAction = releaseLink ? `Listen here: ${releaseLink}` : `Follow ${brandName} for more songs.`;

  if (platform === 'instagram') {
    return {
      title: '',
      caption: `${songTitle} is here for kids, grownups, and anyone who can handle one more round of ${topic}. ${callToAction}`.trim(),
      description: '',
      hashtags: hashtags.slice(0, 8),
      madeForKids,
      assetType,
      tone: 'hook-first, playful, kindie-aware',
    };
  }

  if (platform === 'facebook') {
    return {
      title: '',
      caption: `Today’s Pancake Robot pick: ${songTitle}. It’s playful, parent-tolerable, and built for family listening without sounding like homework. ${callToAction}`.trim(),
      description: '',
      hashtags: hashtags.slice(0, 6),
      madeForKids,
      assetType,
      tone: 'warm, family-facing, shareable',
    };
  }

  const releaseSection = releaseLink
    ? `Listen here:\n${releaseLink}`
    : 'Listen everywhere soon.';
  return {
    title: compact(`${songTitle} | Pancake Robot ${campaignType === 'new_release_push' ? 'Official Short' : 'Shorts Clip'}`),
    caption: '',
    description: `${songTitle}\n\n${compact(song.notes || topic)}\n\n${releaseSection}\n\n${buildSocialLinkBlock()}\n\nTags: ${hashtags.map(tag => tag.replace(/^#/, '')).join(', ')}`,
    hashtags: hashtags.slice(0, 10),
    madeForKids,
    assetType,
    tone: 'searchable, concise, family-safe',
  };
}

export { isPublicFanFacingLink, buildSocialLinkBlock };
