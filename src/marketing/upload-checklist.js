/**
 * Manual posting checklist for Instagram + TikTok launch packs.
 */

import fs from 'fs';
import { join, relative } from 'path';
import { loadBrandProfile } from '../shared/brand-profile.js';

const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;

function rel(assets, path) {
  return path ? relative(assets.outputDir, path) : null;
}

export function generateUploadChecklist(assets, hook, captions, qaReport, renderResult) {
  const title = assets.title;
  const handle = assets.handle;
  const link = assets.hyperfollowUrl || 'HyperFollow / streaming link not found yet — add to link in bio manually';
  const skippedVideos = (renderResult.skipped || []).map(item => `- ${item.name}: ${item.reason}`).join('\n') || '- None';
  const warnings = (qaReport.warnings || []).map(w => `- ${w}`).join('\n') || '- None';
  const failures = (qaReport.failures || []).map(f => `- ${f}`).join('\n') || '- None';

  const md = `# ${BRAND_NAME} Release Upload Checklist

Song: ${title}
Handle: ${handle}
Link-in-bio: ${link}
Generated: ${new Date().toISOString()}

## QA status

${qaReport.passed ? 'PASS — ready for manual posting review' : 'NEEDS REVIEW — fix failures before posting'}

### Failures
${failures}

### Warnings
${warnings}

### Skipped video exports
${skippedVideos}

## Recommended first caption

### Instagram
${captions.recommended_instagram_caption}

### TikTok
${captions.recommended_tiktok_caption}

## Instagram manual upload

1. Open Instagram for ${handle}
2. Upload \`instagram/ig-reel-hook.mp4\` as the first Reel
3. Use \`instagram/ig-reel-cover.jpg\` as the cover
4. Paste the recommended Instagram caption from \`captions.md\`
5. Confirm the song title and handle are readable in the first 3 seconds
6. Post \`instagram/ig-story-new-song.mp4\` to Stories
7. Post \`instagram/ig-feed-announcement-1080x1350.png\` to feed
8. Pin the launch Reel if it performs best

## TikTok manual upload

1. Upload \`tiktok/tiktok-hook.mp4\` first
2. Use \`tiktok/tiktok-cover.jpg\` as cover if available
3. Paste TikTok caption option #1 from \`tiktok/tiktok-caption-options.md\`
4. Post \`tiktok/tiktok-lyric-karaoke.mp4\` as a second variant later
5. Post \`tiktok/tiktok-character-loop.mp4\` as a short repeatable post
6. If the official song is available in TikTok sounds, manually select it for a later native-sound post

## Hook info

- Start: ${hook.hook_start_sec}s
- End: ${hook.hook_end_sec}s
- Duration: ${hook.hook_duration_sec}s
- Rationale: ${hook.rationale}

## Assets created

${(renderResult.generated || []).map(item => `- ${item.platform} / ${item.type}: \`${rel(assets, item.path)}\``).join('\n') || '- Static checklist only — no rendered assets found'}

## Before posting

- Watch the first 3 seconds
- Confirm title spelling
- Confirm handle spelling: ${handle}
- Confirm no text is covered by TikTok/Instagram UI buttons
- Do not post if any text looks cropped or wrong
`;

  fs.writeFileSync(join(assets.outputDir, 'upload-checklist.md'), md);
  fs.writeFileSync(join(assets.dirs.tiktokDir, 'tiktok-upload-notes.md'), md);
  return md;
}
