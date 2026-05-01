/**
 * Deterministic social captions for release packs.
 * Keeps copy exact, brand-safe, and paste-ready for manual posting.
 */

import fs from 'fs';
import { join } from 'path';

function normalizeTitle(title) {
  return String(title || 'New Song').trim();
}

function withoutAt(handle) {
  return String(handle || '@pancakerobotmusic').replace(/^@/, '');
}

export function getDefaultHashtags() {
  return [
    '#kidsmusic',
    '#childrensmusic',
    '#familymusic',
    '#kidssongs',
    '#pancakerobot',
    '#sillysongs',
    '#songsforkids',
    '#parentsoftiktok',
    '#parentsofinstagram',
    '#danceparty',
  ];
}

export function generateCaptions(assets) {
  const title = normalizeTitle(assets.title);
  const handle = assets.handle || '@pancakerobotmusic';
  const cta = assets.cta || 'Listen everywhere - link in bio';
  const hashtags = getDefaultHashtags();
  const tagLine = hashtags.join(' ');
  const noAt = withoutAt(handle);

  const instagram = [
    `${title} is out now from ${handle}.\n\n${cta}.\n\n${tagLine}`,
    `New Pancake Robot song: ${title}.\n\nBuilt for car rides, kitchen dance breaks, and tiny repeat-button energy.\n\n${cta}.\n\n${tagLine}`,
    `Syrup-powered robot music for kids.\n\n${title} is ready to play now.\n\n${cta}.\n\n${tagLine}`,
  ];

  const tiktok = [
    `${title} is out now. Search ${noAt} or tap the link in bio. ${tagLine}`,
    `New silly song for kids: ${title}. ${tagLine}`,
    `Pancake Robot just dropped ${title}. Kitchen dance party required. ${tagLine}`,
  ];

  const variants = {
    short_launch: `${title} is out now from ${handle}. ${cta}.`,
    parent_friendly: `A new silly kids song for car rides, kitchens, and family dance breaks: ${title}. ${cta}.`,
    funny_kid_chaos: `A toaster robot, a stack of pancakes, and one very catchy song: ${title}. ${cta}.`,
  };

  const markdown = `# Social Captions — ${title}

Handle: ${handle}
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

### Parent-friendly
${variants.parent_friendly}

### Funny kid-chaos
${variants.funny_kid_chaos}
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
