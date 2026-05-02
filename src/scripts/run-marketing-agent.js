/**
 * Marketing Agent CLI
 * Usage:
 *   npm run marketing:agent -- --song-id SONG_ID
 *   npm run marketing:agent -- --song-id SONG_ID --promote
 *   npm run marketing:agent -- --album --title "Album Title" --song-ids SONG_1,SONG_2,SONG_3
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { buildReleasePlan, runSafePromotion, buildAlbumReleasePlan } from '../agents/release-planner-agent.js';
import { getActiveProfileId } from '../shared/brand-profile.js';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}
function hasFlag(name) { return process.argv.includes(name); }

const isAlbum = hasFlag('--album');
const songId = getArg('--song-id') || process.argv.find(a => /^SONG_/i.test(a));
const albumTitle = getArg('--title');
const songIdsArg = getArg('--song-ids');
const songIds = songIdsArg ? songIdsArg.split(',').map(s => s.trim()).filter(Boolean) : [];
const doPromote = hasFlag('--promote');
const brandProfileId = getArg('--brand') || getActiveProfileId();

const logger = (msg) => console.log(msg);

if (isAlbum) {
  if (!albumTitle) { console.error('[MARKETING-AGENT] Usage: --album --title "Album Title" --song-ids SONG_1,SONG_2'); process.exit(1); }
  if (!songIds.length) { console.error('[MARKETING-AGENT] --song-ids is required for album mode'); process.exit(1); }

  console.log(`[MARKETING-AGENT] Building album release plan: "${albumTitle}"`);
  console.log(`[MARKETING-AGENT] Tracks: ${songIds.join(', ')}`);

  try {
    const result = await buildAlbumReleasePlan(albumTitle, songIds, { brandProfileId, logger });
    console.log(`\n[MARKETING-AGENT] Album plan complete: ${result.tracks} tracks`);
    console.log(`[MARKETING-AGENT] Output: ${result.planPath}`);
    process.exit(0);
  } catch (err) {
    console.error(`[MARKETING-AGENT] Failed: ${err.message}`);
    process.exit(1);
  }
}

if (!songId) {
  console.error('[MARKETING-AGENT] Usage:');
  console.error('  npm run marketing:agent -- --song-id SONG_ID');
  console.error('  npm run marketing:agent -- --song-id SONG_ID --promote');
  console.error('  npm run marketing:agent -- --album --title "Album Title" --song-ids SONG_1,SONG_2');
  process.exit(1);
}

try {
  console.log(`[MARKETING-AGENT] Building release plan for ${songId}…`);
  const planResult = await buildReleasePlan(songId, { brandProfileId, logger });
  console.log(`\n[MARKETING-AGENT] Release plan: ${planResult.planPath}`);
  console.log(`[MARKETING-AGENT] Missing prerequisites: ${planResult.plan.missing_prerequisites.length}`);

  if (doPromote) {
    console.log(`\n[MARKETING-AGENT] Running safe local promotion package…`);
    const promoResult = await runSafePromotion(songId, { brandProfileId, logger });
    console.log(`\n[MARKETING-AGENT] Promotion run complete`);
    console.log(`[MARKETING-AGENT] Drafts written: ${promoResult.report.drafts_written}`);
    console.log(`[MARKETING-AGENT] External sends: 0 (manual only)`);
    console.log(`[MARKETING-AGENT] Outputs:`);
    for (const [key, path] of Object.entries(promoResult.report.outputs)) {
      console.log(`  ${key}: ${path}`);
    }
  }

  process.exit(0);
} catch (err) {
  console.error(`[MARKETING-AGENT] Failed: ${err.message}`);
  process.exit(1);
}
