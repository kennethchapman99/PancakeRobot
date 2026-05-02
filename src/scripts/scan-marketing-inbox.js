/**
 * Scan the marketing Gmail inbox and classify messages.
 * Usage:
 *   npm run marketing:gmail:scan
 *   npm run marketing:gmail:scan -- --write
 *   npm run marketing:gmail:scan -- --query "newer_than:30d" --max-results 50
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { runInboxScan } from '../agents/marketing-inbox-agent.js';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}
const writeMode = process.argv.includes('--write');
const query = getArg('--query') || null;
const maxResults = getArg('--max-results') ? parseInt(getArg('--max-results'), 10) : undefined;

console.log(`[INBOX-SCAN] Mode: ${writeMode ? 'WRITE (saving to DB)' : 'DRY RUN (print only)'}`);
if (query) console.log(`[INBOX-SCAN] Query: ${query}`);

try {
  const result = await runInboxScan({
    dryRun: !writeMode,
    query,
    maxResults,
    logger: (msg) => console.log(msg),
  });
  console.log(`\n[INBOX-SCAN] Done: fetched ${result.fetched}, ${writeMode ? `saved ${result.saved}` : 'dry run only'}`);
  process.exit(0);
} catch (err) {
  console.error(`[INBOX-SCAN] Failed: ${err.message}`);
  process.exit(1);
}
