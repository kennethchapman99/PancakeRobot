import 'dotenv/config';

import { getActiveProfileId } from '../shared/brand-profile.js';
import { upsertMarketingTarget, getMarketingTargets } from '../shared/marketing-db.js';

const DEFAULT_EMAIL = 'kenneth@d2l.com';
const DEFAULT_NAME = 'TEST';
const DEFAULT_ID = 'MKT_TGT_TEST_KENNETH_D2L';
const DEFAULT_SOURCE_URL = 'https://example.test/pancake-robot/test-outreach';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : fallback;
}

const email = argValue('email', process.env.MARKETING_TEST_TARGET_EMAIL || DEFAULT_EMAIL);
const name = argValue('name', process.env.MARKETING_TEST_TARGET_NAME || DEFAULT_NAME);
const id = argValue('id', process.env.MARKETING_TEST_TARGET_ID || DEFAULT_ID);
const sourceUrl = argValue('source-url', process.env.MARKETING_TEST_TARGET_SOURCE_URL || DEFAULT_SOURCE_URL);
const brandProfileId = argValue('brand-profile-id', process.env.MARKETING_TEST_TARGET_BRAND_PROFILE_ID || getActiveProfileId());

if (!email || !email.includes('@')) {
  throw new Error(`Invalid test target email: ${email || '(empty)'}`);
}

const now = new Date().toISOString();

const target = {
  id,
  brand_profile_id: brandProfileId,
  name,
  type: 'test',
  platform: 'email',
  source_url: sourceUrl,
  submission_url: null,
  contact_method: 'email',
  contact_email: email,
  handle: null,
  audience: 'Internal test recipient',
  geo: 'Canada',
  genres: ['kids music', 'test'],
  content_types: ['email outreach'],
  fit_score: 100,
  ai_policy: 'allowed',
  ai_risk_score: 0,
  recommendation: 'approved',
  research_summary: 'Internal test outreach target for validating Pancake Robot release marketing flow.',
  outreach_angle: 'Use this only to test Gmail draft creation and release outreach workflow.',
  pitch_preferences: JSON.stringify({
    priority: 'P0',
    category: 'test',
    recommended_pitch_type: 'internal_test',
    ai_music_stance: {
      risk_level: 'low',
      notes: 'Internal test target',
    },
    assets_to_send: ['streaming_links', 'cover_art', 'press_blurb'],
  }),
  last_verified_at: now,
  freshness_status: 'fresh',
  status: 'approved',
  suppression_status: 'none',
  notes: 'Safe internal test target. Do not use for real external outreach metrics.',
  raw_json: {
    seed: 'seed-test-marketing-target',
    purpose: 'End-to-end release marketing test',
    contact_email: email,
  },
};

const targetId = upsertMarketingTarget(target);
const saved = getMarketingTargets({ q: name }).find(row => row.id === targetId || row.name === name);

console.log('Seeded marketing test target');
console.table([{
  id: targetId,
  name: saved?.name || name,
  email: saved?.contact_email || email,
  status: saved?.status || target.status,
  ai_policy: saved?.ai_policy || target.ai_policy,
  suppression_status: saved?.suppression_status || target.suppression_status,
  brand_profile_id: saved?.brand_profile_id || brandProfileId,
}]);
