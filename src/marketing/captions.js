/**
 * Deterministic social captions for release packs.
 * Keeps copy exact, brand-safe, and paste-ready for manual posting.
 */

import fs from 'fs';
import { join } from 'path';
import { loadBrandProfile } from '../shared/brand-profile.js';

const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const BRAND_DESCRIPTION = BRAND_PROFILE.brand_description;
const PRIMARY_GENRE = BRAND_PROFILE.distribution.primary_genre;
const TAG_SEED = BRAND_PROFILE.distribution.youtube_tags_seed || [];

function normalizeTitle(title) {
  return String(title || 'New Song').trim();
}

function withoutAt(handle) {
  return String(handle || '').replace(/^@/, '');
}

export function getDefaultHashtags() {
  const tags = [
    BRAND_NAME,
    PRIMARY_GENRE,
    ...TAG_SEED,
    'new music',
    'independent music',
  ];

  return [...new Set(tags)]
    .map(tag => String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean)
    .slice(0, 10)
    .map(tag => `#${tag}`);
}

export function generateCaptions(assets) {
  const title = normalizeTitle(assets.title);
  const handle = assets.handle || '';
  const cta = assets.cta || 'Listen everywhere - link in bio';
  const hashtags = getDefaultHashtags();
  const tagLine = hashtags.join(' ');
  const noAt = withoutAt(handle);
  const artist = assets.artist || BRAND_PROFILE.distribution.default_artist || BRAND_NAME;
  const handleText = handle ? ` from ${handle}` : ` from ${artist}`;
  const searchText = noAt || artist;

  const instagram = [
    `${title} is out now${handleText}.\n\n${cta}.\n\n${tagLine}`,
    `New ${PRIMARY_GENRE} release: ${title}.\n\n${BRAND_DESCRIPTION}.\n\n${cta}.\n\n${tagLine}`,
    `${title} is ready to play now.\n\n${cta}.\n\n${tagLine}`,
  ];

  const tiktok = [
    `${title} is out now. Search ${searchText} or tap the link in bio. ${tagLine}`,
    `New ${PRIMARY_GENRE} song: ${title}. ${tagLine}`,
    `${artist} just released ${title}. ${tagLine}`,
  ];

  const variants = {
    short_launch: `${title} is out now${handleText}. ${cta}.`,
    genre_focused: `A new ${PRIMARY_GENRE} release: ${title}. ${cta}.`,
    brand_voice: `${BRAND_DESCRIPTION}. ${title} is out now. ${cta}.`,
  };

  const markdown = `# Social Captions — ${title}

Handle: ${handle || 'not set'}
CTA: ${cta}

## Recommended Instagram caption

${instagram[0]}

## Instagram options

${instagram.map((caption, index) => `### Instagram ${index + 1}\n\n${caption}`).join('\n\n')}

## TikTok options

${tiktok.map((caption, index) => `### TikTok ${index + 1}\n\n${caption}`).join('\n\n')}

## Reusable variants

### Short launch
${variants.short_launch}

### Genre-focused
${variants.genre_focused}

### Brand voice
${variants.brand_voice}
`;

  const tiktokMarkdown = `# TikTok Caption Options — ${title}

${tiktok.map((caption, index) => `## Option ${index + 1}\n\n${caption}`).join('\n\n')}

## Notes
- Upload ${assets.title || 'the song'} with the baked-in audio first
- If the official TikTok sound is available, manually select it for a later native-sound post
- Keep captions short and let the hook carry the post
`;

  fs.writeFileSync(join(assets.outputDir, 'captions.md'), markdown);
  fs.writeFileSync(join(assets.outputDir, 'hashtags.md'), `${hashtags.join('\n')}\n`);
  fs.writeFileSync(join(assets.dirs.tiktokDir, 'tiktok-caption-options.md'), tiktokMarkdown);

  return {
    instagram,
    tiktok,
    variants,
    hashtags,
    recommended_instagram_caption: instagram[0],
    recommended_tiktok_caption: tiktok[0],
  };
}
