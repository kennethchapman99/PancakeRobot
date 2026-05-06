import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { initMarketingSchema } from '../shared/marketing-db.js';
import { getMarketingOutletsDiagnostics } from '../shared/marketing-outlet-health.js';

initMarketingSchema();

const diagnostics = getMarketingOutletsDiagnostics();

console.log(`[MARKETING-OUTLETS-DOCTOR] active brand_profile_id: ${diagnostics.activeBrandProfileId}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] active DB path: ${diagnostics.activeDbPath}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] source JSON path: ${diagnostics.sourcePath}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] source outlet_targets count: ${diagnostics.sourceOutletCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] DB target count for active brand: ${diagnostics.activeBrandOutletCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] approved count: ${diagnostics.approvedCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] eligible count: ${diagnostics.eligibleCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] contactable count: ${diagnostics.contactableCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] email count: ${diagnostics.emailCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] contact-form/submission count: ${diagnostics.contactFormCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] owned-channel count: ${diagnostics.ownedChannelCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] blocked/do_not_contact/banned count: ${diagnostics.blockedCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] test/demo hidden count: ${diagnostics.hiddenTestDemoCount}`);
console.log(`[MARKETING-OUTLETS-DOCTOR] preset counts: ${JSON.stringify(diagnostics.presetCounts)}`);
if (diagnostics.testDemoRows.length) {
  console.log('[MARKETING-OUTLETS-DOCTOR] test/demo/example rows:');
  for (const row of diagnostics.testDemoRows) {
    console.log(`  - ${row.id} | ${row.name} | ${row.contact_email || 'no-email'} | ${row.source_url || 'no-url'} | ${row.status} | eligible=${row.eligible}`);
  }
}

if (!diagnostics.ok) {
  console.error('[MARKETING-OUTLETS-DOCTOR] FAIL');
  for (const issue of diagnostics.issues) console.error(`  - ${issue}`);
  console.error('Remediation:');
  console.error('  npm run marketing:outlets:seed');
  console.error('  npm run marketing:outlets:doctor');
  process.exit(1);
}

console.log('[MARKETING-OUTLETS-DOCTOR] OK');
