import { getMarketingTargets, getMarketingTargetStats } from '../../../shared/marketing-db.js';
import { getActiveProfileId } from '../../../shared/brand-profile.js';
import { getOutreachItems, getOutreachSummary } from '../../../shared/marketing-outreach-db.js';
import { createOutreachRun, getEligibleOutlets } from '../../../agents/marketing-outreach-run-agent.js';
import { generateDraftsForCampaign } from '../../../agents/marketing-outreach-draft-agent.js';
import { createGmailDraftForOutreachItem, createGmailDraftsForCampaign } from '../../../agents/marketing-gmail-draft-agent.js';
import { readBody, parseBool } from '../utils/http.js';

export function getOutletsSummaryApi(req, res) {
  const outlets = getMarketingTargets({}).map(normalizeOutletForApi);
  res.json({
    ok: true,
    brand_profile_id: getActiveProfileId(),
    stats: getMarketingTargetStats(getActiveProfileId()),
    summary: summarizeOutlets(outlets),
  });
}

export function getOutletsApi(req, res) {
  const filters = {
    q: req.query.q || undefined,
    status: req.query.status || undefined,
    type: req.query.type || undefined,
  };

  let outlets = getMarketingTargets(filters).map(normalizeOutletForApi);
  if (req.query.priority) outlets = outlets.filter(o => o.priority === req.query.priority);
  if (req.query.category) outlets = outlets.filter(o => o.category === req.query.category);
  if (req.query.ai_policy) outlets = outlets.filter(o => o.ai_policy === req.query.ai_policy);
  if (req.query.ai_risk_level) outlets = outlets.filter(o => o.ai_risk_level === req.query.ai_risk_level);
  if (req.query.contact_status) outlets = outlets.filter(o => o.contact_status === req.query.contact_status);
  if (req.query.outreach_allowed) outlets = outlets.filter(o => String(o.outreach_allowed) === req.query.outreach_allowed);

  outlets.sort(sortOutlet);
  res.json({ ok: true, count: outlets.length, outlets });
}

export function getOutreachItemsApi(req, res) {
  res.json({ ok: true, items: getOutreachItems(req.query || {}) });
}

export function getOutreachSummaryApi(req, res) {
  res.json({ ok: true, summary: getOutreachSummary() });
}

export async function postCreateOutreachRunApi(req, res) {
  try {
    const body = await readBody(req);
    const result = await createAndMaybeGenerate(body);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

export async function postGenerateOutreachDraftsApi(req, res) {
  try {
    const body = await readBody(req);
    if (!body.campaign_id) return res.status(400).json({ ok: false, error: 'campaign_id is required' });
    const result = await generateDraftsForCampaign(body.campaign_id, { deterministic: parseBool(body.deterministic) });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

export async function postCreateCampaignGmailDraftsApi(req, res) {
  try {
    const body = await readBody(req);
    if (!body.campaign_id) return res.status(400).json({ ok: false, error: 'campaign_id is required' });
    const result = await createGmailDraftsForCampaign(body.campaign_id);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

export async function postCreateItemGmailDraftApi(req, res) {
  try {
    const result = await createGmailDraftForOutreachItem(req.params.itemId);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

export async function createAndMaybeGenerate(body = {}) {
  const result = createOutreachRun({
    song_ids: body.song_ids || body.song_id || [],
    outlet_ids: resolveOutletIdsFromBody(body),
    mode: body.mode || 'single_release',
    preset: body.preset || body.outlet_preset || null,
  });

  if (parseBool(body.generate_drafts)) {
    let generated = 0;
    let failed = 0;
    const draft_results = [];
    for (const campaign of result.campaigns || []) {
      const draftResult = await generateDraftsForCampaign(campaign.campaign_id, { deterministic: parseBool(body.deterministic) });
      generated += draftResult.generated || 0;
      failed += draftResult.failed || 0;
      draft_results.push(draftResult);
    }
    return { ...result, generated_drafts: generated, failed_drafts: failed, draft_results };
  }

  return result;
}

function resolveOutletIdsFromBody(body = {}) {
  const explicit = normalizeIds(body.outlet_ids || body.target_ids || body.outlets || []);
  if (explicit.length) return explicit;

  const preset = body.outlet_preset || body.preset || 'safe_p0';
  const outlets = getEligibleOutlets();
  if (preset === 'safe_p0') return outlets.filter(o => o.priority === 'P0' && o.outreach_allowed === true).map(o => o.id);
  if (preset === 'safe_p0_p1') return outlets.filter(o => ['P0', 'P1'].includes(o.priority) && o.outreach_allowed === true).map(o => o.id);
  if (preset === 'all_safe') return outlets.filter(o => o.outreach_allowed === true).map(o => o.id);
  if (preset === 'playlist') return outlets.filter(o => o.type === 'playlist' && o.outreach_allowed === true).map(o => o.id);
  if (preset === 'parent_teacher') return outlets.filter(o => ['parent_creator', 'educator'].includes(o.type) && o.outreach_allowed === true).map(o => o.id);
  return [];
}

function normalizeIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  return [];
}

export function normalizeOutletForApi(row) {
  const raw = parseObject(row.raw_json);
  const pitchPrefs = parseObject(row.pitch_preferences);
  const contact = raw.contact || {};
  const aiMusicStance = raw.ai_music_stance || pitchPrefs.ai_music_stance || {};
  const priority = raw.priority || pitchPrefs.priority || null;
  const category = raw.category || pitchPrefs.category || row.type || null;

  return {
    id: row.id,
    name: row.name,
    brand_profile_id: row.brand_profile_id,
    status: row.status,
    recommendation: row.recommendation,
    priority,
    category,
    type: row.type,
    platforms: raw.platforms || splitCsv(row.platform),
    fit_score: row.fit_score,
    url: raw.url || row.source_url,
    source_url: row.source_url,
    contact: {
      email: row.contact_email || contact.email || null,
      method: row.contact_method || contact.submission_path || null,
      handle: row.handle || null,
      status: contactStatus(row, contact),
    },
    contact_status: contactStatus(row, contact),
    ai_policy: row.ai_policy,
    ai_risk_score: row.ai_risk_score,
    ai_risk_level: aiMusicStance.risk_level || riskLevelFromScore(row.ai_risk_score),
    ai_music_stance: aiMusicStance,
    outreach_allowed: outreachAllowed(row),
    recommended_pitch_type: raw.recommended_pitch_type || pitchPrefs.recommended_pitch_type || null,
    sample_pitch_hook: raw.sample_pitch_hook || row.outreach_angle || null,
    best_angles: raw.best_pancake_robot_angles || pitchPrefs.best_angles || [],
    assets_to_send: raw.assets_to_send || pitchPrefs.assets_to_send || [],
    outreach_sequence: raw.outreach_sequence || pitchPrefs.outreach_sequence || [],
    research_summary: row.research_summary,
    outreach_angle: row.outreach_angle,
    raw_json: raw,
  };
}

function summarizeOutlets(outlets) {
  return {
    total: outlets.length,
    by_priority: countBy(outlets, 'priority'),
    by_status: countBy(outlets, 'status'),
    by_type: countBy(outlets, 'type'),
    by_ai_policy: countBy(outlets, 'ai_policy'),
    by_contact_status: countBy(outlets, 'contact_status'),
    outreach_allowed: outlets.filter(o => o.outreach_allowed === true).length,
    manual_review_only: outlets.filter(o => o.outreach_allowed === 'manual_review_only').length,
    blocked: outlets.filter(o => o.outreach_allowed === false).length,
  };
}

function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function contactStatus(row, contact = {}) {
  if (row.status === 'do_not_contact') return 'avoid';
  if (row.contact_email || contact.email) return 'has_email';
  if (row.contact_method || contact.submission_path) return 'has_contact_or_submission_path';
  if (String(row.platform || '').toLowerCase().includes('owned')) return 'owned_channel';
  return 'manual_research_needed';
}

function outreachAllowed(row) {
  if (row.status === 'do_not_contact') return false;
  if (row.ai_policy === 'banned') return false;
  if (row.ai_policy === 'likely_hostile') return 'manual_review_only';
  if ((row.ai_risk_score || 0) >= 85) return 'manual_review_only';
  return true;
}

function riskLevelFromScore(score) {
  const n = Number(score || 0);
  if (n >= 85) return 'high';
  if (n >= 50) return 'medium';
  return 'low';
}

function sortOutlet(a, b) {
  const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3, AVOID_FOR_FULLY_AI: 9 };
  const pa = priorityOrder[a.priority] ?? 5;
  const pb = priorityOrder[b.priority] ?? 5;
  if (pa !== pb) return pa - pb;
  return (b.fit_score || 0) - (a.fit_score || 0);
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

function splitCsv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}
