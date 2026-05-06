/**
 * Seed Pancake Robot outreach outlets into the existing backend marketing DB.
 *
 * This intentionally does NOT add a UI import flow. It treats the provided
 * pancake_robot_marketing_outlets_schema.json as a trusted backend seed file
 * and converts outlet_targets[] into marketing_targets rows the UI/API can call.
 *
 * Usage:
 *   npm run marketing:outlets:seed
 *   npm run marketing:outlets:seed -- --source /Users/kchapman/PancakeRobot/pancake_robot_marketing_outlets_schema.json
 *   npm run marketing:outlets:seed -- --source ./pancake_robot_marketing_outlets_schema.json --brand pancake_robot
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import {
  initMarketingSchema,
  upsertMarketingTarget,
  addSuppressionRule,
  getSuppressionRules,
  getMarketingTargetStats,
  getMarketingTargetById,
} from '../shared/marketing-db.js';
import { getActiveProfileId } from '../shared/brand-profile.js';
import { getDbPath } from '../shared/db.js';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function getDefaultSourcePath() {
  const candidates = [
    process.env.MARKETING_OUTLETS_SOURCE_PATH,
    process.env.MARKETING_RESEARCH_SOURCE_PATH,
    resolve(process.cwd(), 'pancake_robot_marketing_outlets_schema.json'),
    '/Users/kchapman/PancakeRobot/pancake_robot_marketing_outlets_schema.json',
  ].filter(Boolean);

  return candidates.find(p => fs.existsSync(resolve(p))) || candidates[candidates.length - 1];
}

function mapOutletType(category = '') {
  const c = String(category).toLowerCase();
  if (c.includes('playlist') || c.includes('curator')) return 'playlist';
  if (c.includes('radio')) return 'radio';
  if (c.includes('podcast')) return 'podcast';
  if (c.includes('teacher') || c.includes('education') || c.includes('classroom') || c.includes('homeschool')) return 'educator';
  if (c.includes('parent') || c.includes('toddler') || c.includes('sensory') || c.includes('activity')) return 'parent_creator';
  if (c.includes('youtube') || c.includes('kids_music_channel')) return 'kids_music_channel';
  if (c.includes('blog')) return 'blog';
  if (c.includes('media') || c.includes('editorial') || c.includes('award')) return 'media';
  if (c.includes('owned')) return 'community';
  return 'other';
}

function mapAiPolicy(outlet) {
  const stance = outlet.ai_music_stance || {};
  const status = String(stance.status || '').toLowerCase();
  const priority = String(outlet.priority || '').toLowerCase();
  const riskLevel = String(stance.risk_level || '').toLowerCase();

  if (priority.includes('avoid') || status.includes('reject') || status.includes('ban')) return 'banned';
  if (status.includes('disclosure')) return 'disclosure_required';
  if (status.includes('allow') || status.includes('accept')) return 'allowed';
  if (riskLevel === 'high') return 'likely_hostile';
  return 'unclear';
}

function mapAiPolicyDetails(outlet) {
  const stance = outlet.ai_music_stance || {};
  const status = mapAiPolicy(outlet);
  return {
    status: status === 'unclear' && !stance.status ? 'not_found' : status,
    evidence_url: Array.isArray(stance.evidence_urls) && stance.evidence_urls.length ? stance.evidence_urls[0] : null,
    evidence_text: stance.notes || null,
    confidence: stance.risk_level === 'low' ? 'high' : stance.risk_level === 'medium' ? 'medium' : 'high',
  };
}

function mapAiRiskScore(riskLevel) {
  if (riskLevel === 'low') return 20;
  if (riskLevel === 'medium') return 50;
  if (riskLevel === 'high') return 85;
  if (riskLevel === 'avoid') return 100;
  return 60;
}

function mapTargetStatus(outlet) {
  const aiPolicy = mapAiPolicy(outlet);
  if (outlet.priority === 'AVOID_FOR_FULLY_AI' || aiPolicy === 'banned') return 'do_not_contact';
  if (aiPolicy === 'likely_hostile') return 'needs_review';
  return 'approved';
}

function mapRecommendation(outlet) {
  if (outlet.priority === 'AVOID_FOR_FULLY_AI') return 'do_not_contact';
  if (outlet.priority === 'P0') return 'prioritize';
  if (outlet.priority === 'P1') return 'pitch';
  if (outlet.priority === 'P2') return 'consider';
  return 'manual_review';
}

function firstSourceUrl(outlet) {
  return outlet.url || (Array.isArray(outlet.source_urls) && outlet.source_urls[0]) || `outlet://${outlet.id}`;
}

function contactMethod(outlet) {
  const contact = outlet.contact || {};
  return contact.submission_path || contact.email || null;
}

function socialUrl(handle, platform) {
  if (!handle) return null;
  if (/^https?:\/\//i.test(handle)) return handle;
  const clean = String(handle).replace(/^@/, '');
  const base = {
    instagram: 'https://www.instagram.com/',
    tiktok: 'https://www.tiktok.com/@',
    youtube: 'https://www.youtube.com/@',
    facebook: 'https://www.facebook.com/',
    twitter: 'https://x.com/',
    threads: 'https://www.threads.net/@',
  }[platform];
  return base ? `${base}${clean}` : null;
}

function buildCostPolicy(outlet) {
  if (outlet.id === 'kids_listen') {
    return {
      requires_payment: true,
      cost_type: 'membership',
      cost_amount: 100,
      cost_currency: 'USD',
      evidence_url: 'https://kidslisten.org/creator-membership',
      evidence_text: 'General Membership - $100/yr',
      confidence: 'high',
    };
  }
  return {
    requires_payment: false,
    cost_type: 'free',
    cost_amount: null,
    cost_currency: null,
    evidence_url: null,
    evidence_text: null,
    confidence: 'low',
  };
}

function buildContactability(outlet) {
  const contact = outlet.contact || {};
  const methods = [];
  if (contact.email) methods.push({ type: 'email', value: contact.email, source_url: outlet.url || null, confidence: 'high' });
  if (contact.submission_path) methods.push({ type: 'contact_form', value: contact.submission_path, source_url: outlet.url || null, confidence: 'medium' });
  if (!methods.length && String(outlet.category || '').toLowerCase().includes('owned')) {
    methods.push({ type: 'owned_channel', value: outlet.url || 'owned channel', source_url: outlet.url || null, confidence: 'high' });
  }
  let status = 'manual_research_needed';
  let bestChannel = 'unknown';
  if (contact.email) {
    status = 'contactable';
    bestChannel = 'email';
  } else if (String(outlet.category || '').toLowerCase().includes('owned')) {
    status = 'owned_action';
    bestChannel = 'owned_channel';
  } else if (contact.submission_path) {
    status = 'contactable_manual';
    bestChannel = 'contact_form';
  }
  return {
    status,
    free_contact_method_found: methods.length > 0,
    best_channel: bestChannel,
    contact_methods: methods,
    evidence_url: outlet.url || null,
    notes: methods.length ? null : 'No usable free outreach route found.',
  };
}

function buildEligibility(outlet, aiPolicyDetails, costPolicy, contactability) {
  const doNotContact = mapTargetStatus(outlet) === 'do_not_contact';
  const reasonCodes = [];
  if (costPolicy.requires_payment) reasonCodes.push(costPolicy.cost_type === 'membership' ? 'paid_membership_required' : 'requires_payment');
  if (aiPolicyDetails.status === 'banned') reasonCodes.push('ai_music_banned');
  if (!['contactable', 'contactable_manual', 'owned_action'].includes(contactability.status) || contactability.free_contact_method_found !== true) reasonCodes.push('no_contact_method');
  if (doNotContact) reasonCodes.push('do_not_contact');
  return {
    eligible: !costPolicy.requires_payment && aiPolicyDetails.status !== 'banned' && ['contactable', 'contactable_manual', 'owned_action'].includes(contactability.status) && contactability.free_contact_method_found === true && !doNotContact,
    reason_codes: [...new Set(reasonCodes)],
    reason_summary: reasonCodes.length ? reasonCodes.join(', ') : 'Eligible for outreach.',
    last_checked_at: new Date().toISOString(),
  };
}

function domainFromUrl(value) {
  try {
    if (!value || !String(value).startsWith('http')) return null;
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normalizeOutletToMarketingTarget(outlet, brandProfileId) {
  const contact = outlet.contact || {};
  const audience = outlet.audience || {};
  const sourceUrl = firstSourceUrl(outlet);
  const aiPolicyDetails = mapAiPolicyDetails(outlet);
  const costPolicy = buildCostPolicy(outlet);
  const contactability = buildContactability(outlet);
  const outreachEligibility = buildEligibility(outlet, aiPolicyDetails, costPolicy, contactability);

  return {
    id: outlet.id,
    brand_profile_id: brandProfileId,
    name: outlet.name,
    type: mapOutletType(outlet.category),
    platform: (outlet.platforms || []).join(', '),
    source_url: sourceUrl,
    submission_url: /^https?:\/\//i.test(contact.submission_path || '') ? contact.submission_path : null,
    contact_method: contactMethod(outlet),
    contact_email: contact.email || null,
    handle: Object.values(outlet.social_handles || {}).find(Boolean) || null,
    official_website_url: outlet.url || null,
    contact_page_url: /^https?:\/\//i.test(contact.submission_path || '') ? contact.submission_path : outlet.url || null,
    public_email: contact.email || null,
    submission_form_url: /^https?:\/\//i.test(contact.submission_path || '') ? contact.submission_path : null,
    instagram_url: socialUrl(outlet.social_handles?.instagram, 'instagram'),
    tiktok_url: socialUrl(outlet.social_handles?.tiktok, 'tiktok'),
    youtube_url: socialUrl(outlet.social_handles?.youtube, 'youtube'),
    facebook_url: socialUrl(outlet.social_handles?.facebook, 'facebook'),
    twitter_url: socialUrl(outlet.social_handles?.twitter || outlet.social_handles?.x, 'twitter'),
    threads_url: socialUrl(outlet.social_handles?.threads, 'threads'),
    playlist_link_url: null,
    best_free_contact_method: contact.email || contact.submission_path || null,
    backup_contact_method: null,
    contactability,
    cost_policy: costPolicy,
    ai_policy_details: aiPolicyDetails,
    outreach_eligibility: outreachEligibility,
    audience: [audience.primary, audience.age_fit].filter(Boolean).join(' | '),
    geo: audience.geo || null,
    genres: ['children', 'kindie', 'family', 'kids music'],
    content_types: [
      outlet.category,
      outlet.recommended_pitch_type,
      ...(outlet.platforms || []),
    ].filter(Boolean),
    fit_score: outlet.brand_fit_score_0_100 || null,
    ai_policy: aiPolicyDetails.status,
    ai_risk_score: mapAiRiskScore((outlet.ai_music_stance || {}).risk_level),
    recommendation: mapRecommendation(outlet),
    research_summary: (outlet.why_it_fits_pancake_robot || []).filter(Boolean).join('\n'),
    outreach_angle: outlet.sample_pitch_hook || (outlet.best_pancake_robot_angles || []).filter(Boolean).join('\n'),
    pitch_preferences: JSON.stringify({
      category: outlet.category || null,
      priority: outlet.priority || null,
      best_angles: outlet.best_pancake_robot_angles || [],
      assets_to_send: outlet.assets_to_send || [],
      recommended_pitch_type: outlet.recommended_pitch_type || null,
      outreach_sequence: outlet.outreach_sequence || [],
      ai_music_stance: outlet.ai_music_stance || {},
    }, null, 2),
    last_verified_at: null,
    freshness_status: 'seeded_needs_periodic_verification',
    status: mapTargetStatus(outlet),
    rejected_reason: outlet.priority === 'AVOID_FOR_FULLY_AI'
      ? 'Seeded as avoid for fully AI-generated music'
      : null,
    suppression_status: outlet.priority === 'AVOID_FOR_FULLY_AI' ? 'suppressed' : 'none',
    notes: JSON.stringify({
      source_schema: 'pancake_robot_marketing_outlets_schema',
      source_urls: outlet.source_urls || [],
      notes_for_marketing_agent: outlet.notes_for_marketing_agent || [],
    }, null, 2),
    raw_json: outlet,
  };
}

const sourcePath = resolve(getArg('--source') || getDefaultSourcePath());
const brandProfileId = getArg('--brand') || getActiveProfileId();

if (!fs.existsSync(sourcePath)) {
  console.error(`[MARKETING-OUTLETS] Source file not found: ${sourcePath}`);
  process.exit(1);
}

initMarketingSchema();

const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const outlets = Array.isArray(parsed.outlet_targets) ? parsed.outlet_targets : [];

if (!outlets.length) {
  console.error('[MARKETING-OUTLETS] No outlet_targets[] found in source JSON');
  process.exit(1);
}

const existingSuppressionTargetIds = new Set(
  getSuppressionRules(brandProfileId)
    .filter(rule => rule.target_id)
    .map(rule => rule.target_id)
);

let imported = 0;
let suppressed = 0;
let skipped = 0;

for (const outlet of outlets) {
  try {
    const existing = getMarketingTargetById(outlet.id, { brand_profile_id: brandProfileId });
    const target = normalizeOutletToMarketingTarget(outlet, brandProfileId);
    if (existing && ['suppressed', 'do_not_contact', 'bounced', 'paid_only'].includes(existing.suppression_status || '')) {
      target.suppression_status = existing.suppression_status;
      target.suppression_reason = existing.suppression_reason || target.rejected_reason || null;
      target.suppression_source = existing.suppression_source || 'marketing_outlets_seed';
    }
    upsertMarketingTarget(target);
    imported++;

    if (target.status === 'do_not_contact' && !existingSuppressionTargetIds.has(target.id)) {
      addSuppressionRule({
        brand_profile_id: brandProfileId,
        target_id: target.id,
        domain: domainFromUrl(target.source_url),
        reason: target.rejected_reason || 'Seeded do-not-contact outlet',
        source: 'marketing_outlets_seed',
      });
      existingSuppressionTargetIds.add(target.id);
      suppressed++;
    }
  } catch (err) {
    skipped++;
    console.warn(`[MARKETING-OUTLETS] Skipped ${outlet?.name || outlet?.id || 'unknown'}: ${err.message}`);
  }
}

const stats = getMarketingTargetStats(brandProfileId);
console.log('[MARKETING-OUTLETS] Seed complete');
console.log(JSON.stringify({
  sourcePath,
  dbPath: getDbPath(),
  brandProfileId,
  schemaVersion: parsed.schema_version || null,
  imported,
  suppressed,
  skipped,
  total: outlets.length,
  stats,
}, null, 2));
