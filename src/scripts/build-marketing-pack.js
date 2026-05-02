/**
 * Build an Instagram + TikTok marketing pack for a song.
 * Usage:
 *   npm run marketing -- SONG_ID
 *   node src/scripts/build-marketing-pack.js --song-id SONG_ID
 *   node src/scripts/build-marketing-pack.js --song-id SONG_ID --provider openai --mode full_social_pack
 *   node src/scripts/build-marketing-pack.js --song-id SONG_ID --formats ig_feed_1080x1350,tiktok_cover
 *   node src/scripts/build-marketing-pack.js --song-id SONG_ID --mode render_from_existing_visuals --no-render-videos
 *   node src/scripts/build-marketing-pack.js --song-id SONG_ID --regenerate-base-art
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);

const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { buildMarketingReleasePack } from '../marketing/release-agent.js';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}
function hasFlag(name) { return process.argv.includes(name); }

const songId = getArg('--song-id') || process.argv.find(arg => /^SONG_/i.test(arg));
const provider = getArg('--provider') || null;
const mode = getArg('--mode') || null;
const formatsArg = getArg('--formats');
const formats = formatsArg ? formatsArg.split(',').map(f => f.trim()).filter(Boolean) : null;
const useBaseImage = hasFlag('--no-use-base-image') ? false : true;
const regenerateBaseArt = hasFlag('--regenerate-base-art');
const renderVideos = hasFlag('--no-render-videos') ? false : true;
const requireApprovalBeforeVideo = hasFlag('--require-approval-before-video');

const VALID_MODES = ['full_social_pack', 'generate_new_base_art', 'render_from_existing_visuals', 'captions_checklist_only'];

if (!songId) {
  console.error('Usage: npm run marketing -- SONG_ID');
  console.error('Or:    node src/scripts/build-marketing-pack.js --song-id SONG_ID [options]');
  console.error('');
  console.error('Options:');
  console.error('  --provider openai|cloudflare');
  console.error('  --mode ' + VALID_MODES.join('|'));
  console.error('  --formats ig_feed_1080x1350,tiktok_cover,...');
  console.error('  --use-base-image / --no-use-base-image');
  console.error('  --regenerate-base-art');
  console.error('  --no-render-videos');
  console.error('  --require-approval-before-video');
  process.exit(1);
}

if (mode && !VALID_MODES.includes(mode)) {
  console.error(`[MARKETING] Invalid mode: ${mode}. Must be one of: ${VALID_MODES.join(', ')}`);
  process.exit(1);
}

try {
  console.log(`[MARKETING] Building marketing pack for ${songId}...`);
  if (mode) console.log(`[MARKETING] Mode: ${mode}`);
  if (provider) console.log(`[MARKETING] Provider: ${provider}`);
  if (formats) console.log(`[MARKETING] Formats: ${formats.join(', ')}`);
  if (regenerateBaseArt) console.log(`[MARKETING] Regenerating base art`);
  if (!renderVideos) console.log(`[MARKETING] Skipping video render`);

  const result = await buildMarketingReleasePack(songId, {
    mode,
    provider,
    imageProvider: provider,
    formats,
    useBaseImage,
    regenerateBaseArt,
    renderVideos,
    requireApprovalBeforeVideo,
  });

  console.log(`\n[MARKETING] ${result.ok ? '✓' : '⚠'} Marketing pack generated`);
  console.log(`[MARKETING] Output: ${result.outputDir}`);
  console.log(`[MARKETING] Dashboard: ${result.dashboardUrl}`);
  console.log(`[MARKETING] QA: ${result.metadata.qa_status}`);

  if (result.qaReport.warnings?.length) {
    console.log('\n[MARKETING] Warnings:');
    for (const warning of result.qaReport.warnings) console.log(`  - ${warning}`);
  }

  if (result.qaReport.failures?.length) {
    console.log('\n[MARKETING] Failures:');
    for (const failure of result.qaReport.failures) console.log(`  - ${failure}`);
    process.exit(2);
  }

  process.exit(0);
} catch (err) {
  console.error(`[MARKETING] Failed: ${err.message}`);
  process.exit(1);
}
