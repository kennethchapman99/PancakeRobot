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

import { buildSongReleaseAssets } from '../shared/song-release-assets-service.js';

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
const json = hasFlag('--json');
const jsonSummary = hasFlag('--json-summary');

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
  console.error('  --json');
  console.error('  --json-summary');
  process.exit(1);
}

if (mode && !VALID_MODES.includes(mode)) {
  console.error(`[MARKETING] Invalid mode: ${mode}. Must be one of: ${VALID_MODES.join(', ')}`);
  process.exit(1);
}

try {
  const log = (...args) => console.error(...args);
  const restoreConsoleLog = (json || jsonSummary)
    ? (() => {
        const original = console.log;
        console.log = (...args) => console.error(...args);
        return () => { console.log = original; };
      })()
    : () => {};
  if (!json && !jsonSummary) {
    log(`[MARKETING] Building marketing pack for ${songId}...`);
    if (mode) log(`[MARKETING] Mode: ${mode}`);
    if (provider) log(`[MARKETING] Provider: ${provider}`);
    if (formats) log(`[MARKETING] Formats: ${formats.join(', ')}`);
    if (regenerateBaseArt) log(`[MARKETING] Regenerating base art`);
    if (!renderVideos) log(`[MARKETING] Skipping video render`);
  }

  const result = await buildSongReleaseAssets(songId, {
    mode,
    provider,
    imageProvider: provider,
    formats,
    useBaseImage,
    regenerateBaseArt,
    renderVideos,
    requireApprovalBeforeVideo,
  });
  restoreConsoleLog();

  const payload = {
    ok: result.ok,
    songId: result.songId,
    dashboardUrl: result.dashboardUrl,
    generatedAssets: result.generatedAssets,
    marketingAssets: result.marketingAssets,
    imageSource: result.imageSource,
    qaWarnings: result.qaWarnings || [],
    qaFailures: result.qaFailures || [],
  };

  if (json || jsonSummary) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      songId: result.songId,
      dashboardUrl: result.dashboardUrl,
      generatedAssets: result.generatedAssets,
      marketingAssets: result.marketingAssets,
      imageSource: result.imageSource,
      warnings: result.qaWarnings || [],
      failures: result.qaFailures || [],
    })}\n`);
  } else {
    log(`\n[MARKETING] ${result.ok ? '✓' : '⚠'} Marketing pack generated`);
    log(`[MARKETING] Dashboard: ${result.dashboardUrl}`);
    if (payload.qaWarnings.length) {
      log('\n[MARKETING] Warnings:');
      for (const warning of payload.qaWarnings) log(`  - ${warning}`);
    }
    if (payload.qaFailures.length) {
      log('\n[MARKETING] Failures:');
      for (const failure of payload.qaFailures) log(`  - ${failure}`);
    }
  }

  process.exit(payload.qaFailures.length ? 2 : 0);
} catch (err) {
  console.error(`[MARKETING] Failed: ${err.message}`);
  process.exit(1);
}
