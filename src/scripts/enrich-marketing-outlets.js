import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import {
  getMarketingTargets,
  getMarketingTargetStats,
  initMarketingSchema,
  upsertMarketingTarget,
} from '../shared/marketing-db.js';
import { normalizeOutletForApp } from '../shared/marketing-outlets.js';

initMarketingSchema();

const rows = getMarketingTargets({});
let updated = 0;
const checkedAt = new Date().toISOString();

for (const row of rows) {
  const normalized = normalizeOutletForApp(row);
  const target = {
    ...row,
    official_website_url: normalized.official_website_url,
    contact_page_url: normalized.contact_page_url,
    public_email: normalized.public_email,
    submission_form_url: normalized.submission_form_url,
    instagram_url: normalized.instagram_url,
    tiktok_url: normalized.tiktok_url,
    youtube_url: normalized.youtube_url,
    facebook_url: normalized.facebook_url,
    twitter_url: normalized.twitter_url,
    threads_url: normalized.threads_url,
    playlist_link_url: normalized.playlist_link_url,
    best_free_contact_method: normalized.best_free_contact_method || normalized.contactability.contact_methods[0]?.value || null,
    backup_contact_method: normalized.contactability.contact_methods[1]?.value || null,
    contactability: normalized.contactability,
    cost_policy: normalized.cost_policy,
    ai_policy: normalized.ai_policy,
    ai_policy_details: normalized.ai_policy_details,
    outreach_eligibility: {
      ...normalized.outreach_eligibility,
      last_checked_at: checkedAt,
    },
    contact_email: normalized.public_email || row.contact_email || null,
    contact_method: normalized.submission_form_url || row.contact_method || null,
    raw_json: normalized.raw_json,
  };
  upsertMarketingTarget(target);
  updated++;
}

console.log(JSON.stringify({
  updated,
  stats: getMarketingTargetStats(),
}, null, 2));
