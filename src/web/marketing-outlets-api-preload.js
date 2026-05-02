import { createRequire } from 'module';
import {
  getMarketingTargets,
  getMarketingTargetStats,
} from '../shared/marketing-db.js';
import { getActiveProfileId } from '../shared/brand-profile.js';

const require = createRequire(import.meta.url);
const express = require('express');
const originalHandle = express.application.handle;

express.application.handle = function marketingOutletsApiHandle(req, res, done) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (pathname === '/api/marketing/outlets' || pathname === '/api/marketing/outlets/summary' || pathname.startsWith('/api/marketing/outlets/')) {
    routeMarketingOutletsApi(req, res).catch((error) => {
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: error.message }));
    });
    return;
  }
  return originalHandle.call(this, req, res, done);
};

async function routeMarketingOutletsApi(req, res) {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  if (req.method !== 'GET') {
    res.statusCode = 405;
    return sendJson(res, { ok: false, error: 'Method not allowed' });
  }

  if (pathname === '/api/marketing/outlets/summary') {
    const outlets = getMarketingTargets({}).map(normalizeOutletForApi);
    return sendJson(res, {
      ok: true,
      brand_profile_id: getActiveProfileId(),
      stats: getMarketingTargetStats(getActiveProfileId()),
      summary: summarizeOutlets(outlets),
    });
  }

  const detailMatch = pathname.match(/^\/api\/marketing\/outlets\/([^/]+)$/);
  if (detailMatch) {
    const id = decodeURIComponent(detailMatch[1]);
    const outlet = getMarketingTargets({}).map(normalizeOutletForApi).find(o => o.id === id);
    if (!outlet) {
      res.statusCode = 404;
      return sendJson(res, { ok: false, error: 'Outlet not found' });
    }
    return sendJson(res, { ok: true, outlet });
  }

  const queryFilters = Object.fromEntries(url.searchParams.entries());
  const dbFilters = {
    q: queryFilters.q || undefined,
    status: queryFilters.status || undefined,
    type: queryFilters.type || undefined,
  };

  let outlets = getMarketingTargets(dbFilters).map(normalizeOutletForApi);

  if (queryFilters.priority) outlets = outlets.filter(o => o.priority === queryFilters.priority);
  if (queryFilters.category) outlets = outlets.filter(o => o.category === queryFilters.category);
  if (queryFilters.ai_policy) outlets = outlets.filter(o => o.ai_policy === queryFilters.ai_policy);
  if (queryFilters.ai_risk_level) outlets = outlets.filter(o => o.ai_risk_level === queryFilters.ai_risk_level);
  if (queryFilters.recommendation) outlets = outlets.filter(o => o.recommendation === queryFilters.recommendation);
  if (queryFilters.contact_status) outlets = outlets.filter(o => o.contact_status === queryFilters.contact_status);
  if (queryFilters.outreach_allowed) outlets = outlets.filter(o => String(o.outreach_allowed) === queryFilters.outreach_allowed);

  outlets.sort((a, b) => {
    const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3, AVOID_FOR_FULLY_AI: 9 };
    const pa = priorityOrder[a.priority] ?? 5;
    const pb = priorityOrder[b.priority] ?? 5;
    if (pa !== pb) return pa - pb;
    return (b.fit_score || 0) - (a.fit_score || 0);
  });

  return sendJson(res, { ok: true, count: outlets.length, outlets });
}

function normalizeOutletForApi(row) {
  const raw = parseObject(row.raw_json);
  const pitchPrefs = parseObject(row.pitch_preferences);
  const contact = raw.contact || {};
  const aiMusicStance = raw.ai_music_stance || pitchPrefs.ai_music_stance || {};
  const priority = raw.priority || pitchPrefs.priority || null;
  const category = raw.category || pitchPrefs.category || row.type || null;
  const sourceUrls = raw.source_urls || parseObject(row.notes).source_urls || [];

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
    source_urls: sourceUrls,

    contact: {
      email: row.contact_email || contact.email || null,
      method: row.contact_method || contact.submission_path || null,
      handle: row.handle || null,
      status: contactStatus(row, contact),
    },
    contact_status: contactStatus(row, contact),

    audience: raw.audience || {
      primary: row.audience || null,
      geo: row.geo || null,
    },

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
    pitch_preferences: pitchPrefs,
    raw_json: raw,

    last_verified_at: row.last_verified_at,
    freshness_status: row.freshness_status,
    last_updated_at: row.updated_at,
  };
}

function summarizeOutlets(outlets) {
  return {
    total: outlets.length,
    by_priority: countBy(outlets, 'priority'),
    by_status: countBy(outlets, 'status'),
    by_type: countBy(outlets, 'type'),
    by_ai_policy: countBy(outlets, 'ai_policy'),
    by_ai_risk_level: countBy(outlets, 'ai_risk_level'),
    by_contact_status: countBy(outlets, 'contact_status'),
    outreach_allowed: outlets.filter(o => o.outreach_allowed === true).length,
    manual_review_only: outlets.filter(o => o.outreach_allowed === 'manual_review_only').length,
    blocked: outlets.filter(o => o.outreach_allowed === false).length,
  };
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

function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
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

function sendJson(res, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
