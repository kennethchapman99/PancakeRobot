/**
 * Marketing Target Agent
 * Brand-level persistent target intelligence. Heavy research runs only during
 * explicit import/refresh — not on every release plan.
 */

import fs from 'fs';
import path from 'path';
import {
  initMarketingSchema,
  upsertMarketingTarget,
  getApprovedTargetsForBrand,
  getTargetsByBrand,
  getSuppressionRules,
  upsertReleaseMatch,
  getReleaseMatches,
  getMarketingTargetStats,
  createMarketingAgentRun,
  logMarketingAgentRun,
  finishMarketingAgentRun,
} from '../shared/marketing-db.js';
import { getActiveProfileId } from '../shared/brand-profile.js';
import { getSong } from '../shared/db.js';

const REFRESH_DAYS = parseInt(process.env.MARKETING_TARGET_REFRESH_DAYS || '60', 10);
const MIN_FIT_SCORE = parseInt(process.env.MARKETING_TARGET_MIN_FIT_SCORE || '70', 10);

// ─── Target import ────────────────────────────────────────────────────────────

export async function importTargetsFromFile(sourcePath, options = {}) {
  initMarketingSchema();
  const brandProfileId = options.brandProfileId || getActiveProfileId();
  const runId = createMarketingAgentRun({ agentName: 'marketing-target-agent', runType: 'target_import', input: { sourcePath, brandProfileId } });
  const log = (level, msg, data) => { logMarketingAgentRun(runId, level, msg, data); if (options.logger) options.logger(`[${level}] ${msg}`); else console.log(`[TARGET-IMPORT] ${msg}`); };

  try {
    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved)) throw new Error(`Source file not found: ${resolved}`);

    const raw = fs.readFileSync(resolved, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Source file must be valid JSON'); }

    const rows = Array.isArray(parsed) ? parsed : (parsed.targets || parsed.data || []);
    if (!Array.isArray(rows)) throw new Error('JSON must be an array or have a "targets" array field');

    log('info', `Importing ${rows.length} rows from ${resolved} for brand ${brandProfileId}`);

    let imported = 0, skipped = 0;
    for (const [i, row] of rows.entries()) {
      const missing = ['name', 'type', 'source_url'].filter(f => !row[f] || !String(row[f]).trim());
      if (missing.length) {
        log('warn', `Row ${i}: skipped — missing required field(s): ${missing.join(', ')}`, row);
        skipped++;
        continue;
      }
      if (!VALID_TYPES.includes(row.type)) {
        log('warn', `Row ${i} "${row.name}": unknown type "${row.type}" — allowed: ${VALID_TYPES.join(', ')}`);
      }

      try {
        upsertMarketingTarget({ ...row, brand_profile_id: brandProfileId });
        imported++;
      } catch (err) {
        log('warn', `Row ${i} "${row.name}": upsert failed — ${err.message}`);
        skipped++;
      }
    }

    const result = { status: 'done', imported, skipped, total: rows.length, brandProfileId };
    log('info', `Import complete: ${imported} imported, ${skipped} skipped`);
    finishMarketingAgentRun(runId, 'done', result);
    return result;
  } catch (err) {
    finishMarketingAgentRun(runId, 'error', null, err.message);
    throw err;
  }
}

// ─── Per-release matching ─────────────────────────────────────────────────────

export function matchTargetsForRelease(songId, options = {}) {
  initMarketingSchema();
  const brandProfileId = options.brandProfileId || getActiveProfileId();
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);

  const runId = createMarketingAgentRun({ agentName: 'marketing-target-agent', runType: 'target_match', input: { songId, brandProfileId } });
  const log = (level, msg, data) => { logMarketingAgentRun(runId, level, msg, data); if (options.logger) options.logger(`[${level}] ${msg}`); else console.log(`[TARGET-MATCH] ${msg}`); };

  try {
    const approved = getApprovedTargetsForBrand(brandProfileId);
    const suppressed = getSuppressionRules(brandProfileId);
    const suppressedEmails = new Set(suppressed.filter(s => s.email).map(s => s.email.toLowerCase()));
    const suppressedDomains = new Set(suppressed.filter(s => s.domain).map(s => s.domain.toLowerCase()));
    const suppressedHandles = new Set(suppressed.filter(s => s.handle).map(s => s.handle.toLowerCase()));
    const suppressedTargetIds = new Set(suppressed.filter(s => s.target_id).map(s => s.target_id));

    const songGenres = tryParseArray(song.genre_tags);
    const songMoods = tryParseArray(song.mood_tags);

    log('info', `Matching ${approved.length} approved targets for ${songId}`);

    const matches = [];
    for (const target of approved) {
      // Exclusion checks
      if (['rejected', 'do_not_contact'].includes(target.status)) continue;
      if (['banned', 'likely_hostile'].includes(target.ai_policy) && !options.allowHostile) continue;
      if (suppressedTargetIds.has(target.id)) continue;
      if (target.contact_email && suppressedEmails.has(target.contact_email.toLowerCase())) continue;
      if (target.handle && suppressedHandles.has(target.handle.toLowerCase())) continue;
      if (target.contact_email) {
        const domain = target.contact_email.split('@')[1];
        if (domain && suppressedDomains.has(domain.toLowerCase())) continue;
      }

      const { score, reasons } = scoreTarget(target, { song, songGenres, songMoods, releaseType: options.releaseType || 'single' });
      if (score < (options.minScore ?? MIN_FIT_SCORE)) continue;

      matches.push({ target, score, reasons });
    }

    matches.sort((a, b) => b.score - a.score);
    log('info', `Matched ${matches.length} targets above threshold ${options.minScore ?? MIN_FIT_SCORE}`);

    const saved = [];
    for (const { target, score, reasons } of matches) {
      const matchId = upsertReleaseMatch({
        brand_profile_id: brandProfileId,
        song_id: songId,
        target_id: target.id,
        match_score: score,
        match_reasons: reasons,
        recommended_action: recommendAction(target, score),
        status: 'planned',
        requires_human: 1,
      });
      saved.push({ matchId, targetId: target.id, targetName: target.name, score, reasons });
    }

    const result = { status: 'done', songId, brandProfileId, matched: saved.length, matches: saved };
    finishMarketingAgentRun(runId, 'done', result);
    return result;
  } catch (err) {
    finishMarketingAgentRun(runId, 'error', null, err.message);
    throw err;
  }
}

// ─── Stale detection (no auto-research) ──────────────────────────────────────

export function flagStaleTargets(brandProfileId) {
  initMarketingSchema();
  const targets = getTargetsByBrand(brandProfileId);
  const cutoff = new Date(Date.now() - REFRESH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const stale = targets.filter(t => t.last_verified_at && t.last_verified_at < cutoff);
  return { total: targets.length, stale: stale.length, staleTargets: stale.map(t => ({ id: t.id, name: t.name, last_verified_at: t.last_verified_at })) };
}

export function getTargetLibrarySummary(brandProfileId) {
  initMarketingSchema();
  return getMarketingTargetStats(brandProfileId);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreTarget(target, context) {
  let score = target.fit_score || 50;
  const reasons = [];

  const targetGenres = tryParseArray(target.genres_json);
  if (targetGenres.length && context.songGenres.length) {
    const overlap = targetGenres.filter(g => context.songGenres.some(sg => sg.toLowerCase().includes(g.toLowerCase()) || g.toLowerCase().includes(sg.toLowerCase())));
    if (overlap.length) { score += 10; reasons.push(`genre match: ${overlap.join(', ')}`); }
    else { score -= 10; reasons.push('no genre overlap'); }
  }

  if (context.releaseType === 'single' && ['playlist', 'influencer', 'short_form_creator'].includes(target.type)) {
    score += 5; reasons.push('good fit for single release');
  }
  if (context.releaseType === 'album' && ['blog', 'media', 'newsletter', 'podcast'].includes(target.type)) {
    score += 5; reasons.push('good fit for album release');
  }

  const aiPolicy = target.ai_policy || 'unclear';
  if (aiPolicy === 'allowed') { score += 5; reasons.push('AI policy: allowed'); }
  else if (aiPolicy === 'disclosure_required') { reasons.push('AI disclosure required'); }
  else if (aiPolicy === 'unclear') { reasons.push('AI policy unclear'); }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function recommendAction(target, score) {
  if (score >= 85) return 'prioritize';
  if (score >= 70) return 'pitch';
  if (score >= 55) return 'consider';
  return 'low_priority';
}

function tryParseArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; }
}

const VALID_TYPES = [
  'playlist','influencer','blog','media','curator','educator',
  'parent_creator','kids_music_channel','short_form_creator','community',
  'radio','podcast','newsletter','other',
];
