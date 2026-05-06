import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getActiveProfileId } from './brand-profile.js';
import { getDbPath } from './db.js';
import { getMarketingTargets } from './marketing-db.js';
import { hydrateOutletsWithHistory } from './marketing-outlets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_SOURCE_PATH = path.join(REPO_ROOT, 'pancake_robot_marketing_outlets_schema.json');
const PRESET_MINIMUM = 5;

export function resolveMarketingOutletsSourcePath() {
  const candidates = [
    process.env.MARKETING_OUTLETS_SOURCE_PATH,
    process.env.MARKETING_RESEARCH_SOURCE_PATH,
    DEFAULT_SOURCE_PATH,
  ].filter(Boolean).map(value => path.resolve(value));

  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

export function loadMarketingOutletsSource() {
  const sourcePath = resolveMarketingOutletsSourcePath();
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`Marketing outlets source not found: ${sourcePath || 'unset'}`);
  }
  const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const outletTargets = Array.isArray(parsed.outlet_targets) ? parsed.outlet_targets : [];
  return { sourcePath, parsed, outletTargets };
}

export function isTestOrDemoTarget(target = {}) {
  const raw = target.raw_json && typeof target.raw_json === 'object' ? target.raw_json : parseObject(target.raw_json);
  if (raw?.internal_test === true || target.internal_test === true) return true;

  const values = [
    target.id,
    target.name,
    target.contact_email,
    target.public_email,
    target.source_url,
    target.official_website_url,
    target.contact_page_url,
    target.submission_form_url,
    target.url,
    target.handle,
    raw?.id,
    raw?.name,
    raw?.url,
    raw?.contact?.email,
    raw?.contact?.submission_path,
  ].filter(Boolean).map(value => String(value).toLowerCase());

  return values.some(value =>
    /\btest\b/.test(value)
    || value.endsWith('.example')
    || value.includes('.example/')
    || value.includes('.example?')
    || value.includes('example.com')
    || value.includes('example.test')
    || value.startsWith('outlet://test')
  );
}

export function getActiveBrandOutlets({ brandProfileId = getActiveProfileId(), includeTestData = false, filters = {}, includeHistory = true } = {}) {
  const rows = getMarketingTargets({ ...filters, brand_profile_id: brandProfileId });
  const hydrated = includeHistory ? hydrateOutletsWithHistory(rows) : rows;
  return includeTestData ? hydrated : hydrated.filter(row => !isTestOrDemoTarget(row));
}

export function canUseForRealOutreach(outlet = {}) {
  return !isTestOrDemoTarget(outlet) && canUseForPresetSelection(outlet);
}

export function isEmailTarget(outlet = {}) {
  return Boolean(outlet?.public_email || outlet?.contact_email || outlet?.contact?.email);
}

export function getPresetEligibleOutlets(outlets = [], preset = 'all_safe') {
  const real = outlets.filter(canUseForRealOutreach);
  if (preset === 'safe_p0') return real.filter(outlet => outlet.priority === 'P0');
  if (preset === 'safe_p0_p1') return real.filter(outlet => ['P0', 'P1'].includes(outlet.priority));
  if (preset === 'playlist') return real.filter(outlet => outlet.type === 'playlist');
  if (preset === 'parent_teacher') return real.filter(outlet => ['parent_creator', 'educator'].includes(outlet.type));
  return real;
}

export function getMarketingOutletsDiagnostics({ brandProfileId = getActiveProfileId() } = {}) {
  const dbPath = getDbPath();
  const dbExists = fs.existsSync(dbPath);
  const { sourcePath, outletTargets } = loadMarketingOutletsSource();
  const allDbOutlets = hydrateOutletsWithHistory(getMarketingTargets({ brand_profile_id: null }));
  const allBrandOutlets = getActiveBrandOutlets({ brandProfileId, includeTestData: true });
  const realBrandOutlets = allBrandOutlets.filter(outlet => !isTestOrDemoTarget(outlet));
  const hiddenTestDemo = allDbOutlets.filter(isTestOrDemoTarget);
  const eligible = realBrandOutlets.filter(canUseForRealOutreach);
  const emailTargets = eligible.filter(isEmailTarget);
  const contactFormTargets = eligible.filter(outlet => outlet.contactability?.status === 'contactable_manual');
  const ownedChannelTargets = eligible.filter(outlet => outlet.contactability?.status === 'owned_action');
  const blocked = realBrandOutlets.filter(outlet =>
    outlet.do_not_contact === true
    || ['do_not_contact', 'suppressed', 'paid_only', 'bounced', 'ai_banned', 'no_contact_method'].includes(outlet.suppression_status || '')
    || outlet.ai_policy === 'banned'
    || outlet.status === 'do_not_contact'
  );
  const approved = realBrandOutlets.filter(outlet => outlet.status === 'approved');
  const contactable = realBrandOutlets.filter(outlet => ['contactable', 'contactable_manual', 'owned_action'].includes(outlet.contactability?.status));
  const testDemoEligibleRows = hiddenTestDemo.filter(canUseForPresetSelection);
  const presetCounts = {
    safe_p0: getPresetEligibleOutlets(allBrandOutlets, 'safe_p0').length,
    safe_p0_p1: getPresetEligibleOutlets(allBrandOutlets, 'safe_p0_p1').length,
    all_safe: getPresetEligibleOutlets(allBrandOutlets, 'all_safe').length,
    playlist: getPresetEligibleOutlets(allBrandOutlets, 'playlist').length,
    parent_teacher: getPresetEligibleOutlets(allBrandOutlets, 'parent_teacher').length,
  };

  const issues = [];
  if (!dbExists) issues.push(`Active DB path does not exist: ${dbPath}`);
  if (outletTargets.length >= 40 && realBrandOutlets.length < 30) {
    issues.push(`Only ${realBrandOutlets.length} active-brand outlets loaded from DB, but source has ${outletTargets.length}`);
  }
  if (testDemoEligibleRows.length) {
    issues.push(`Test/demo outlets are eligible for real outreach: ${testDemoEligibleRows.map(row => row.name || row.id).join(', ')}`);
  }
  if (outletTargets.length >= 40) {
    const weakPreset = Object.entries(presetCounts).find(([, count]) => count < PRESET_MINIMUM);
    if (weakPreset) issues.push(`Preset ${weakPreset[0]} only resolves to ${weakPreset[1]} outlets`);
  }

  return {
    ok: issues.length === 0,
    issues,
    activeBrandProfileId: brandProfileId,
    activeDbPath: dbPath,
    sourcePath,
    sourceOutletCount: outletTargets.length,
    activeBrandOutletCount: realBrandOutlets.length,
    activeBrandOutletCountIncludingTests: allBrandOutlets.length,
    totalDbOutletCount: allDbOutlets.length,
    approvedCount: approved.length,
    eligibleCount: eligible.length,
    contactableCount: contactable.length,
    emailCount: emailTargets.length,
    contactFormCount: contactFormTargets.length,
    ownedChannelCount: ownedChannelTargets.length,
    blockedCount: blocked.length,
    excludedCount: Math.max(realBrandOutlets.length - eligible.length, 0),
    hiddenTestDemoCount: hiddenTestDemo.length,
    testDemoRows: hiddenTestDemo.map(row => ({
      id: row.id,
      name: row.name,
      contact_email: row.public_email || row.contact?.email || null,
      source_url: row.source_url || row.url || null,
      status: row.status,
      eligible: row.eligible,
    })),
    presetCounts,
  };
}

function canUseForPresetSelection(outlet = {}) {
  return outlet.eligible === true
    && ['contactable', 'contactable_manual', 'owned_action'].includes(outlet.contactability?.status)
    && !['do_not_contact', 'suppressed', 'paid_only', 'bounced', 'ai_banned', 'no_contact_method'].includes(outlet.suppression_status || '')
    && outlet.do_not_contact !== true;
}

export function assertMarketingOutletsReadyForOutreach({ brandProfileId = getActiveProfileId() } = {}) {
  const diagnostics = getMarketingOutletsDiagnostics({ brandProfileId });
  if (diagnostics.ok) return diagnostics;
  throw new Error(
    `Marketing outlets preflight failed: only ${diagnostics.activeBrandOutletCount} active-brand outlets loaded from DB, but source has ${diagnostics.sourceOutletCount}. Run npm run marketing:outlets:seed then npm run marketing:outlets:doctor.`
  );
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
