/**
 * Match approved brand targets to a specific song release.
 * Usage:
 *   npm run marketing:targets:match -- --song-id SONG_ID
 *   npm run marketing:targets:match -- --song-id SONG_ID --brand my-brand-id --min-score 60
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { matchTargetsForRelease, flagStaleTargets } from '../agents/marketing-target-agent.js';
import { getActiveProfileId } from '../shared/brand-profile.js';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

const songId = getArg('--song-id') || process.argv.find(a => /^SONG_/i.test(a));
const brandProfileId = getArg('--brand') || getActiveProfileId();
const minScore = getArg('--min-score') ? parseInt(getArg('--min-score'), 10) : undefined;
const releaseType = getArg('--release-type') || 'single';

if (!songId) {
  console.error('[MATCH-TARGETS] Usage: npm run marketing:targets:match -- --song-id SONG_ID');
  process.exit(1);
}

console.log(`[MATCH-TARGETS] Song: ${songId}`);
console.log(`[MATCH-TARGETS] Brand: ${brandProfileId}`);
if (minScore !== undefined) console.log(`[MATCH-TARGETS] Min score: ${minScore}`);

const staleInfo = flagStaleTargets(brandProfileId);
if (staleInfo.stale > 0) {
  console.log(`[MATCH-TARGETS] Warning: ${staleInfo.stale} targets are stale (not re-researched automatically — run import to refresh)`);
}

try {
  const result = await matchTargetsForRelease(songId, {
    brandProfileId,
    minScore,
    releaseType,
    logger: (msg) => console.log(msg),
  });

  console.log(`\n[MATCH-TARGETS] Matched ${result.matched} targets for ${songId}`);
  for (const m of result.matches.slice(0, 10)) {
    console.log(`  [${m.score}] ${m.targetName} — ${m.reasons.join('; ')}`);
  }
  if (result.matches.length > 10) console.log(`  ... and ${result.matches.length - 10} more`);
  process.exit(0);
} catch (err) {
  console.error(`[MATCH-TARGETS] Failed: ${err.message}`);
  process.exit(1);
}
