import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { getWorkflowRunEvents, getWorkflowRunRecord } from '../shared/workflow-runs-db.js';

const runId = process.argv[2];
if (!runId) {
  console.error('Usage: node src/scripts/show-workflow-run.js <RUN_ID>');
  process.exit(1);
}

const run = getWorkflowRunRecord(runId);
if (!run) {
  console.error(`Workflow run not found: ${runId}`);
  process.exit(1);
}

console.log(JSON.stringify(run, null, 2));
console.log('\nEvents:');
for (const event of getWorkflowRunEvents(runId)) {
  console.log(`${event.timestamp} | ${event.event_type} | ${event.step_id || event.stage || ''} | ${event.message || ''}`);
}
