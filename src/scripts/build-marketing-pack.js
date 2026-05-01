/**
 * Build an Instagram + TikTok marketing pack for a song.
 * Usage:
 *   npm run marketing -- SONG_ID
 *   node src/scripts/build-marketing-pack.js SONG_ID
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

const songId = getArg('--song-id') || process.argv.find(arg => /^SONG_/i.test(arg));

if (!songId) {
  console.error('Usage: npm run marketing -- SONG_ID');
  console.error('Or:    node src/scripts/build-marketing-pack.js --song-id SONG_ID');
  process.exit(1);
}

try {
  console.log(`[MARKETING] Building Instagram + TikTok release pack for ${songId}...`);
  const result = await buildMarketingReleasePack(songId);

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
