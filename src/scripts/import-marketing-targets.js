/**
 * Import brand-level marketing targets from a JSON file.
 * Usage:
 *   npm run marketing:targets:import -- --source /path/to/targets.json
 *   npm run marketing:targets:import -- --source /path/to/targets.json --brand my-brand-id
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { importTargetsFromFile } from '../agents/marketing-target-agent.js';
import { getActiveProfileId } from '../shared/brand-profile.js';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

const sourcePath = getArg('--source') || process.env.MARKETING_RESEARCH_SOURCE_PATH;
const brandProfileId = getArg('--brand') || getActiveProfileId();

if (!sourcePath) {
  console.error('[IMPORT-TARGETS] Usage: npm run marketing:targets:import -- --source /path/to/targets.json');
  console.error('[IMPORT-TARGETS] Or set MARKETING_RESEARCH_SOURCE_PATH in .env');
  process.exit(1);
}

console.log(`[IMPORT-TARGETS] Source: ${sourcePath}`);
console.log(`[IMPORT-TARGETS] Brand profile: ${brandProfileId}`);

try {
  const result = await importTargetsFromFile(sourcePath, {
    brandProfileId,
    logger: (msg) => console.log(msg),
  });
  console.log(`\n[IMPORT-TARGETS] Done: ${result.imported} imported, ${result.skipped} skipped of ${result.total} total`);
  process.exit(0);
} catch (err) {
  console.error(`[IMPORT-TARGETS] Failed: ${err.message}`);
  process.exit(1);
}
