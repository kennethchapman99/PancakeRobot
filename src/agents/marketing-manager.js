import fs from 'fs';
import path from 'path';
import {
  createMarketingAgentRun,
  finishMarketingAgentRun,
  logMarketingAgentRun,
  upsertMarketingTarget,
  getApprovedMarketingTargets,
  createMarketingCampaign,
} from '../shared/marketing-db.js';
import { getMarketingContext } from '../shared/marketing-context.js';
import { SONG_STATUSES } from '../shared/song-status.js';

/**
 * Thin-slice marketing research importer.
 *
 * This intentionally does not fabricate targets. It imports only real records from
 * MARKETING_RESEARCH_SOURCE_PATH, which should be produced by OpenClaw/Firecrawl
 * or by manual research. Every imported target must include at least:
 *   - name
 *   - type
 *   - source_url
 */
export async function runMarketingResearchImport({ sourcePath = process.env.MARKETING_RESEARCH_SOURCE_PATH } = {}) {
  const runId = createMarketingAgentRun({
    agentName: 'marketing-manager',
    runType: 'target_research_import',
    input: { sourcePath: sourcePath || null },
  });

  try {
    logMarketingAgentRun(runId, 'info', 'Marketing research import started.');

    if (!sourcePath || !String(sourcePath).trim()) {
      const message = 'No MARKETING_RESEARCH_SOURCE_PATH configured. Refusing to create placeholder targets.';
      logMarketingAgentRun(runId, 'blocked', message, {
        requiredEnv: 'MARKETING_RESEARCH_SOURCE_PATH',
        expectedFormat: 'JSON array or { "targets": [...] } with name, type, and source_url for each target.',
      });
      finishMarketingAgentRun(runId, 'blocked_missing_source', { imported: 0, skipped: 0 }, message);
      return { runId, status: 'blocked_missing_source', imported: 0, skipped: 0 };
    }

    const resolvedPath = path.resolve(sourcePath);
    if (!fs.existsSync(resolvedPath)) {
      const message = `Configured research source file does not exist: ${resolvedPath}`;
      logMarketingAgentRun(runId, 'blocked', message);
      finishMarketingAgentRun(runId, 'blocked_missing_file', { imported: 0, skipped: 0, resolvedPath }, message);
      return { runId, status: 'blocked_missing_file', imported: 0, skipped: 0 };
    }

    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    const targets = Array.isArray(parsed) ? parsed : Array.isArray(parsed.targets) ? parsed.targets : [];

    if (!targets.length) {
      const message = 'Research source contained no targets. Nothing imported.';
      logMarketingAgentRun(runId, 'warn', message, { resolvedPath });
      finishMarketingAgentRun(runId, 'done', { imported: 0, skipped: 0, resolvedPath });
      return { runId, status: 'done', imported: 0, skipped: 0 };
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const [index, target] of targets.entries()) {
      try {
        const id = upsertMarketingTarget({
          ...target,
          status: target.status || 'needs_review',
          recommendation: target.recommendation || 'manual_review',
          raw_json: target,
        });
        imported += 1;
        logMarketingAgentRun(runId, 'info', `Imported target: ${target.name}`, { id, source_url: target.source_url });
      } catch (error) {
        skipped += 1;
        const detail = { index, error: error.message, target };
        errors.push(detail);
        logMarketingAgentRun(runId, 'warn', `Skipped unsourced or invalid target at index ${index}: ${error.message}`, detail);
      }
    }

    const status = errors.length ? 'done_with_skips' : 'done';
    const output = { imported, skipped, errors, resolvedPath };
    finishMarketingAgentRun(runId, status, output);
    logMarketingAgentRun(runId, 'info', `Marketing research import finished. Imported=${imported}, skipped=${skipped}.`);
    return { runId, status, imported, skipped, errors };
  } catch (error) {
    logMarketingAgentRun(runId, 'error', error.message, { stack: error.stack });
    finishMarketingAgentRun(runId, 'error', null, error.message);
    return { runId, status: 'error', imported: 0, skipped: 0, error: error.message };
  }
}

/**
 * Creates a draft campaign from the active brand profile, real song catalog, and
 * approved targets only. This is intentionally not an outreach sender.
 */
export async function runDraftCampaignPlanner({ focusSongId = null } = {}) {
  const context = getMarketingContext();
  const runId = createMarketingAgentRun({
    agentName: 'marketing-manager',
    runType: 'draft_campaign_planner',
    input: { focusSongId, brand_name: context.brand.name },
  });

  try {
    logMarketingAgentRun(runId, 'info', `Loaded brand profile for ${context.brand.name}.`, {
      brand_type: context.brand.type,
      artist: context.brand.distribution?.default_artist,
    });

    const songs = context.songs || [];
    if (!songs.length) {
      const message = 'No songs exist in the catalog. Campaign planning blocked.';
      logMarketingAgentRun(runId, 'blocked', message);
      finishMarketingAgentRun(runId, 'blocked_no_songs', { campaign_id: null }, message);
      return { runId, status: 'blocked_no_songs', campaign_id: null };
    }

    const focusSong = focusSongId
      ? songs.find(song => song.id === focusSongId)
      : chooseDefaultFocusSong(songs);

    if (!focusSong) {
      const message = `Focus song not found: ${focusSongId}`;
      logMarketingAgentRun(runId, 'blocked', message);
      finishMarketingAgentRun(runId, 'blocked_missing_focus_song', { campaign_id: null, focusSongId }, message);
      return { runId, status: 'blocked_missing_focus_song', campaign_id: null };
    }

    const approvedTargets = getApprovedMarketingTargets();
    if (!approvedTargets.length) {
      const message = 'No approved marketing targets. Approve sourced targets before campaign planning.';
      logMarketingAgentRun(runId, 'blocked', message, { focus_song_id: focusSong.id });
      finishMarketingAgentRun(runId, 'blocked_no_approved_targets', { campaign_id: null, focus_song_id: focusSong.id }, message);
      return { runId, status: 'blocked_no_approved_targets', campaign_id: null, focus_song_id: focusSong.id };
    }

    const channelMix = summarizeChannelMix(approvedTargets);
    const campaignName = `${context.brand.name} — ${focusSong.title || focusSong.topic || focusSong.id}`;
    const objective = buildObjective(context, focusSong);
    const campaignId = createMarketingCampaign({
      name: campaignName,
      status: 'draft',
      focus_song_id: focusSong.id,
      objective,
      audience: context.brand.audience?.description || focusSong.target_age_range || '',
      channel_mix: channelMix,
      approved_target_ids: approvedTargets.map(target => target.id),
      brand_context: buildCampaignBrandSnapshot(context, focusSong),
      notes: 'Draft only. Requires human review before any outreach or posting.',
    });

    const output = {
      campaign_id: campaignId,
      focus_song_id: focusSong.id,
      approved_targets: approvedTargets.length,
      channel_mix: channelMix,
    };

    logMarketingAgentRun(runId, 'info', `Created draft campaign ${campaignId}.`, output);
    finishMarketingAgentRun(runId, 'done', output);
    return { runId, status: 'done', ...output };
  } catch (error) {
    logMarketingAgentRun(runId, 'error', error.message, { stack: error.stack });
    finishMarketingAgentRun(runId, 'error', null, error.message);
    return { runId, status: 'error', campaign_id: null, error: error.message };
  }
}

function chooseDefaultFocusSong(songs) {
  const priority = [SONG_STATUSES.OUTREACH_COMPLETE, SONG_STATUSES.SUBMITTED_TO_DISTROKID, SONG_STATUSES.EDITING, SONG_STATUSES.DRAFT];
  return [...songs].sort((a, b) => {
    const ai = priority.includes(a.status) ? priority.indexOf(a.status) : priority.length;
    const bi = priority.includes(b.status) ? priority.indexOf(b.status) : priority.length;
    if (ai !== bi) return ai - bi;
    return String(b.release_date || '').localeCompare(String(a.release_date || ''));
  })[0];
}

function summarizeChannelMix(targets) {
  const counts = targets.reduce((acc, target) => {
    const type = target.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts).map(([type, count]) => ({ type, count }));
}

function buildObjective(context, song) {
  const parts = [
    'Drive real discovery for an approved focus song',
    context.brand.description,
    context.brand.audience?.description,
    context.brand.distribution?.primary_genre,
    song.title || song.topic,
  ].filter(Boolean);
  return parts.join(' | ');
}

function buildCampaignBrandSnapshot(context, song) {
  return {
    brand_name: context.brand.name,
    artist: context.brand.distribution?.default_artist,
    brand_type: context.brand.type,
    brand_description: context.brand.description,
    audience: context.brand.audience,
    primary_genre: context.brand.distribution?.primary_genre,
    spotify_genres: context.brand.distribution?.spotify_genres || [],
    content_advisory: context.brand.distribution?.content_advisory,
    coppa_status: context.brand.distribution?.coppa_status,
    visual_identity: context.brand.character?.visual_identity,
    focus_song: {
      id: song.id,
      title: song.title,
      topic: song.topic,
      status: song.status,
      release_date: song.release_date,
      distributor: song.distributor,
      release_links: song.release_links || [],
    },
  };
}
