import { getMarketingTargetStats } from '../../../shared/marketing-db.js';
import { getActiveProfileId } from '../../../shared/brand-profile.js';
import { getOutreachEvents, getOutreachItems, getOutreachSummary } from '../../../shared/marketing-outreach-db.js';
import { createOutreachRun, getEligibleOutlets } from '../../../agents/marketing-outreach-run-agent.js';
import { generateDraftsForCampaign } from '../../../agents/marketing-outreach-draft-agent.js';
import { createGmailDraftForOutreachItem, createGmailDraftsForCampaign } from '../../../agents/marketing-gmail-draft-agent.js';
import { readBody, parseBool } from '../utils/http.js';
import { getActiveBrandOutlets, getMarketingOutletsDiagnostics, isTestOrDemoTarget } from '../../../shared/marketing-outlet-health.js';

export function getOutletsSummaryApi(req, res) {
  const brandProfileId = getActiveProfileId();
  const outlets = getActiveBrandOutlets({ brandProfileId, includeTestData: parseBool(req.query.show_test_data) });
  res.json({
    ok: true,
    brand_profile_id: brandProfileId,
    stats: getMarketingTargetStats(brandProfileId),
    diagnostics: getMarketingOutletsDiagnostics({ brandProfileId }),
    summary: summarizeOutlets(outlets),
  });
}

export function getOutletsApi(req, res) {
  const filters = {
    q: req.query.q || undefined,
    status: req.query.status || undefined,
    type: req.query.type || undefined,
  };

  const brandProfileId = getActiveProfileId();
  const includeTestData = parseBool(req.query.show_test_data);
  let outlets = getActiveBrandOutlets({ brandProfileId, includeTestData, filters });
  if (req.query.priority) outlets = outlets.filter(o => o.priority === req.query.priority);
  if (req.query.category) outlets = outlets.filter(o => o.category === req.query.category);
  if (req.query.ai_policy) outlets = outlets.filter(o => o.ai_policy === req.query.ai_policy);
  if (req.query.cost_status) outlets = outlets.filter(o => o.cost_status === req.query.cost_status);
  if (req.query.contactability) outlets = outlets.filter(o => o.contactability.status === req.query.contactability);
  if (req.query.best_channel) outlets = outlets.filter(o => o.contactability.best_channel === req.query.best_channel);
  if (req.query.eligible !== undefined) outlets = outlets.filter(o => String(o.eligible) === req.query.eligible);
  if (req.query.outreach_allowed !== undefined) outlets = outlets.filter(o => String(o.outreach_allowed) === req.query.outreach_allowed);
  if (req.query.show_excluded === 'false') outlets = outlets.filter(o => o.eligible === true);
  if (!includeTestData) outlets = outlets.filter(o => !isTestOrDemoTarget(o));
  if (req.query.release_id) {
    const releaseId = String(req.query.release_id);
    outlets = outlets.filter(o => !o.outreach_history.some(event => event.release_id === releaseId));
  }

  outlets.sort(sortOutlet);
  res.json({
    ok: true,
    brand_profile_id: brandProfileId,
    count: outlets.length,
    diagnostics: getMarketingOutletsDiagnostics({ brandProfileId }),
    outlets,
  });
}

export function getOutreachItemsApi(req, res) {
  res.json({ ok: true, items: getOutreachItems(req.query || {}) });
}

export function getOutreachEventsApi(req, res) {
  res.json({ ok: true, events: getOutreachEvents(req.query || {}) });
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

export async function postInboxScanApi(req, res) {
  try {
    const { runInboxScan } = await import('../../../agents/marketing-inbox-agent.js');
    const body = await readBody(req);
    const result = await runInboxScan({ dryRun: body.dry_run !== 'false' && body.dry_run !== false });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

export async function createAndMaybeGenerate(body = {}, options = {}) {
  const { awaitDraftGeneration = false } = options;
  const shouldGenerateDrafts = parseBool(body.generate_drafts);
  const shouldCreateGmailDrafts = body.create_gmail_drafts === undefined ? shouldGenerateDrafts : parseBool(body.create_gmail_drafts);
  const result = createOutreachRun({
    song_ids: body.song_ids || body.song_id || [],
    outlet_ids: resolveOutletIdsFromBody(body),
    mode: body.mode || 'single_release',
    preset: body.preset || body.outlet_preset || null,
    allow_same_release: parseBool(body.allow_same_release),
  });

  if (shouldGenerateDrafts) {
    const deterministic = parseBool(body.deterministic);
    if (awaitDraftGeneration) {
      let generated = 0;
      let failed = 0;
      const draft_results = [];
      let gmail_created = 0;
      let gmail_blocked = 0;
      let gmail_failed = 0;
      const gmail_results = [];
      for (const campaign of result.campaigns || []) {
        const draftResult = await generateDraftsForCampaign(campaign.campaign_id, { deterministic });
        generated += draftResult.generated || 0;
        failed += draftResult.failed || 0;
        draft_results.push(draftResult);
        if (shouldCreateGmailDrafts) {
          const gmailResult = await createGmailDraftsForCampaign(campaign.campaign_id, { dryRun: parseBool(body.dry_run) });
          gmail_created += gmailResult.created || 0;
          gmail_blocked += gmailResult.blocked || 0;
          gmail_failed += gmailResult.failed || 0;
          gmail_results.push(gmailResult);
        }
      }
      return {
        ...result,
        generated_drafts: generated,
        failed_drafts: failed,
        draft_results,
        gmail_drafts_created: gmail_created,
        gmail_drafts_blocked: gmail_blocked,
        gmail_drafts_failed: gmail_failed,
        gmail_results,
      };
    }

    for (const campaign of result.campaigns || []) {
      (async () => {
        try {
          await generateDraftsForCampaign(campaign.campaign_id, { deterministic });
          if (shouldCreateGmailDrafts) {
            await createGmailDraftsForCampaign(campaign.campaign_id, { dryRun: parseBool(body.dry_run) });
          }
        } catch (err) {
          console.error('[draft-gen] campaign', campaign.campaign_id, err.message);
        }
      })();
    }
    return { ...result, generated_drafts: 'queued', gmail_drafts_created: shouldCreateGmailDrafts ? 'queued' : 0 };
  }

  return result;
}

function resolveOutletIdsFromBody(body = {}) {
  const explicit = normalizeIds(body.outlet_ids || body.target_ids || body.outlets || []);
  if (explicit.length) return explicit;

  const preset = body.outlet_preset || body.preset || 'safe_p0';
  const outlets = getEligibleOutlets();
  if (preset === 'safe_p0') return outlets.filter(o => o.priority === 'P0').map(o => o.id);
  if (preset === 'safe_p0_p1') return outlets.filter(o => ['P0', 'P1'].includes(o.priority)).map(o => o.id);
  if (preset === 'all_safe') return outlets.map(o => o.id);
  if (preset === 'playlist') return outlets.filter(o => o.type === 'playlist').map(o => o.id);
  if (preset === 'parent_teacher') return outlets.filter(o => ['parent_creator', 'educator'].includes(o.type)).map(o => o.id);
  return [];
}

function normalizeIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  return [];
}

export function normalizeOutletForApi(row) {
  return hydrateOutletsWithHistory([row])[0];
}

function summarizeOutlets(outlets) {
  return {
    total: outlets.length,
    by_priority: countBy(outlets, 'priority'),
    by_status: countBy(outlets, 'status'),
    by_type: countBy(outlets, 'type'),
    by_ai_policy: countBy(outlets, 'ai_policy'),
    by_contact_status: outlets.reduce((acc, outlet) => {
      const key = outlet.contactability?.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    by_cost_status: countBy(outlets, 'cost_status'),
    eligible: outlets.filter(o => o.eligible === true).length,
    blocked: outlets.filter(o => o.eligible !== true).length,
  };
}

function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function sortOutlet(a, b) {
  const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3, AVOID_FOR_FULLY_AI: 9 };
  const pa = priorityOrder[a.priority] ?? 5;
  const pb = priorityOrder[b.priority] ?? 5;
  if (pa !== pb) return pa - pb;
  return (b.fit_score || 0) - (a.fit_score || 0);
}
