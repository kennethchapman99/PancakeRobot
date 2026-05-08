import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { listWorkflowRuns } from '../shared/workflow-runs-db.js';

const statusArg = process.argv.find(arg => arg.startsWith('--status='));
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
const status = statusArg ? statusArg.split('=').slice(1).join('=').trim() : null;
const limit = limitArg ? Number(limitArg.split('=').slice(1).join('=')) : 25;

const runs = listWorkflowRuns({ limit, status });

if (runs.length === 0) {
  console.log('No workflow runs found.');
  process.exit(0);
}

for (const run of runs) {
  const title = [
    run.id,
    run.status,
    run.source || 'unknown-source',
    run.brand_id || 'no-brand',
    run.song_id || 'no-song-yet',
  ].join(' | ');
  console.log(title);
  console.log(`  theme: ${run.theme || '—'}`);
  console.log(`  step: ${run.current_step || '—'}`);
  console.log(`  created: ${run.created_at || '—'}`);
  if (run.error && Object.keys(run.error).length) console.log(`  error: ${run.error.message || JSON.stringify(run.error)}`);
  console.log('');
}
