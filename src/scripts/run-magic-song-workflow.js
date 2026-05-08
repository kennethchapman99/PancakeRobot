import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { runMagicSongWorkflow } from '../workflows/magic-song-workflow.js';

const args = process.argv.slice(2);
const theme = args.join(' ').trim();

if (!theme) {
  console.error('Usage: npm run magic:workflow -- "song theme here"');
  process.exit(1);
}

const brandId = process.env.DEFAULT_BRAND_ID || 'default';

const state = await runMagicSongWorkflow({
  theme,
  brandId,
  requestedBy: 'cli',
  source: 'api',
  mode: process.env.MAGIC_SONG_MODE || 'human_review',
}, {
  onEvent: event => {
    if (event.type === 'pipeline_progress') {
      console.log(`[${event.stage}] ${event.line || ''}`.trim());
    }
  },
});

console.log(JSON.stringify(state.result || state.stepResults?.hydrate_result || {}, null, 2));
