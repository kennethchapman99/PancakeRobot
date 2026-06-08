import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  addReleaseCampaignRun,
  addReleaseCockpitLog,
  assignAlbumSingles,
  getAlbum,
  getReadyReleaseCampaignTasks,
  getReleaseCampaignByRelease,
  getReleaseCampaignTaskByKey,
  getReleaseLinks,
  getSong,
  getSongsForAlbum,
  listReleaseCampaignRuns,
  listReleaseCampaignTasks,
  listVisualLibraryAssets,
  updateReleaseCampaignRun,
  upsertReleaseCampaign,
  upsertReleaseCampaignTask,
  upsertReleaseLink,
  upsertSong,
} from './db.js';
import { createOutreachRun, getCanonicalEmailOutletsForSelection } from '../agents/marketing-outreach-run-agent.js';
import { createOrRefreshReleaseSocialCampaign } from '../agents/daily-social-planner-agent.js';
import { getSongMarketingKit, saveSongMarketingKit } from './song-marketing-kit.js';
import { recommendVisualAssets, selectReusableAssetOrSuggestCustomVideo } from './visual-library.js';
import { buildCanonicalDistroKidPayload } from './distrokid-payload.js';
import {
  BROWSY_WORKFLOW_IDS,
  evaluateBrowsyContractCompleteness,
  executeBrowsyWorkflowRun,
  getBrowsyConfig,
  getBrowsyWorkflowContract,
} from './browsy-client.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW_ROOT = path.join(REPO_ROOT, 'output', 'release-workflows');

// The songwriter/producer is always the human owner — never a brand profile
// display name. DistroKid wants the real legal name in the songwriter credit,
// while the performer/artist field uses the brand name ([[project_distrokid_artist_rule]]).
const SONGWRITER_LEGAL_NAME = 'Kenneth Chapman';

// Figment Factory → DistroKid fixed-field policy (per the test plan / "Distrokid
// fields" spec). Every Figment Factory release uses these regardless of per-song
// data: Primary Genre is always "Alternative" and the Record Label is always
// "Figment Factory". The DistroKid genre <select> option text is exactly
// "Alternative".
const DISTROKID_FIGMENT_GENRE = 'Alternative';
const DISTROKID_FIGMENT_LABEL = 'Figment Factory';

export const MAGIC_RELEASE_TASK_STATUSES = Object.freeze([
  'pending',
  'ready',
  'running',
  'complete',
  'blocked',
  'needs_ken',
  'skipped',
  'failed',
]);

export const MAGIC_RELEASE_TASK_OWNERS = Object.freeze([
  'agent',
  'ken',
  'platform',
  'external',
  'browsy',
]);

const TASK_TEMPLATES = Object.freeze([
  { key: 'verify_release_metadata', title: 'Verify release metadata', offsetDays: -30, owner: 'agent', blocking: true },
  { key: 'spotify_pre_release_positioning', title: 'Confirm Spotify pitch / pre-release positioning', offsetDays: -30, owner: 'ken', blocking: false },
  { key: 'distrokid_package_readiness', title: 'Run DistroKid package readiness', offsetDays: -28, owner: 'agent', blocking: true },
  { key: 'distrokid_submit_dry_run', title: 'Launch Browsy DistroKid submit dry-run', offsetDays: -28, owner: 'browsy', blocking: true, workflowId: release => release.type === 'album' ? BROWSY_WORKFLOW_IDS.distrokidAlbumSubmit : BROWSY_WORKFLOW_IDS.distrokidSingleSubmit },
  { key: 'distrokid_final_submit_approval', title: 'Ken approval gate for DistroKid final submit', offsetDays: -27, owner: 'ken', blocking: true, dependsOn: ['distrokid_submit_dry_run'] },
  { key: 'hyperfollow_capture', title: 'Capture HyperFollow URL', offsetDays: -26, owner: 'browsy', blocking: true, workflowId: BROWSY_WORKFLOW_IDS.hyperfollowCapture, dependsOn: ['distrokid_final_submit_approval'] },
  { key: 'hyperfollow_enrich', title: 'Enrich HyperFollow page', offsetDays: -25, owner: 'browsy', blocking: false, workflowId: BROWSY_WORKFLOW_IDS.hyperfollowEnrich, dependsOn: ['hyperfollow_capture'] },
  { key: 'select_visual_assets', title: 'Select reusable visual assets', offsetDays: -24, owner: 'agent', blocking: true },
  { key: 'decide_custom_video', title: 'Decide whether any album singles need custom video', offsetDays: -23, owner: 'ken', blocking: false, dependsOn: ['select_visual_assets'] },
  { key: 'youtube_teaser_schedule', title: 'Create/schedule YouTube teaser', offsetDays: -21, owner: 'ken', blocking: false, workflowId: 'youtube-upload-schedule', dependsOn: ['select_visual_assets'] },
  { key: 'short_form_schedule', title: 'Create/schedule short-form posts', offsetDays: -18, owner: 'ken', blocking: false, workflowId: 'meta-instagram-facebook-schedule', dependsOn: ['select_visual_assets'] },
  { key: 'outreach_wave_1', title: 'Outreach wave 1', offsetDays: -14, owner: 'agent', blocking: false, dependsOn: ['hyperfollow_capture'] },
  { key: 'pre_save_push', title: 'Pre-save push', offsetDays: -10, owner: 'agent', blocking: false, dependsOn: ['hyperfollow_capture', 'select_visual_assets'] },
  { key: 'final_pre_release_checklist', title: 'Final pre-release checklist', offsetDays: -7, owner: 'ken', blocking: true },
  { key: 'release_week_posts_approved', title: 'Release-week posts approved', offsetDays: -3, owner: 'ken', blocking: false },
  { key: 'harvest_platform_links', title: 'Harvest platform links', offsetDays: 0, owner: 'browsy', blocking: true, workflowId: BROWSY_WORKFLOW_IDS.platformLinkHarvest, dependsOn: ['distrokid_final_submit_approval'] },
  { key: 'switch_release_cta', title: 'Switch CTA from pre-save to listen/save/share', offsetDays: 0, owner: 'agent', blocking: false, dependsOn: ['harvest_platform_links'] },
  { key: 'thank_you_post', title: 'Thank-you/save/share post', offsetDays: 1, owner: 'ken', blocking: false },
  { key: 'outreach_follow_up', title: 'Outreach follow-up', offsetDays: 3, owner: 'agent', blocking: false, dependsOn: ['outreach_wave_1'] },
  { key: 'performance_snapshot', title: 'Performance snapshot', offsetDays: 7, owner: 'agent', blocking: false, dependsOn: ['harvest_platform_links'] },
  { key: 'catalog_push', title: 'Catalog push', offsetDays: 14, owner: 'agent', blocking: false, dependsOn: ['performance_snapshot'] },
  { key: 'campaign_retrospective', title: 'Campaign retrospective', offsetDays: 30, owner: 'agent', blocking: false, dependsOn: ['catalog_push'] },
]);

export function createMagicReleaseCampaign({ releaseType, releaseId, albumSingles = [] } = {}) {
  const release = getReleaseEntity(releaseType, releaseId);
  if (release.type === 'album' && albumSingles.length) assignAlbumSingles(release.id, albumSingles);
  const context = buildCampaignContext(release);
  const campaign = upsertReleaseCampaign({
    release_type: release.type,
    release_id: release.id,
    title: release.title,
    release_date: release.releaseDate,
    status: 'draft',
    lifecycle_state: 'planned',
    current_gate: 'plan_generation',
    campaign_plan: { generated_at: new Date().toISOString(), task_count: TASK_TEMPLATES.length },
    context,
    links: collectReleaseLinks(release),
    asset_selection: {},
    run_summary: {},
  });
  refreshMagicReleasePlan({ releaseType: release.type, releaseId: release.id });
  addReleaseCockpitLog({
    releaseType: release.type,
    releaseId: release.id,
    action: 'magic_release_create',
    status: 'success',
    message: 'Magic Release campaign created.',
    payload: { campaignId: campaign.id },
  });
  return getMagicReleaseState(release.type, release.id);
}

export function refreshMagicReleasePlan({ releaseType, releaseId } = {}) {
  const release = getReleaseEntity(releaseType, releaseId);
  const campaign = ensureCampaignForRelease(release.type, release.id);
  for (const template of TASK_TEMPLATES) {
    const task = buildTaskFromTemplate({ campaign, release, template });
    upsertReleaseCampaignTask(task);
  }
  recomputeTaskStatuses(campaign.id);
  return getMagicReleaseState(release.type, release.id);
}

export function getMagicReleaseState(releaseType, releaseId) {
  const release = getReleaseEntity(releaseType, releaseId);
  const campaign = ensureCampaignForRelease(release.type, release.id, { createIfMissing: false });
  if (!campaign) return null;
  const tasks = recomputeTaskStatuses(campaign.id);
  const runs = listReleaseCampaignRuns(campaign.id);
  const blockedTasks = tasks.filter(task => ['blocked', 'needs_ken', 'failed'].includes(task.status));
  const readyTasks = tasks.filter(task => task.status === 'ready');
  return {
    release,
    campaign,
    tasks,
    runs,
    blockedTasks,
    readyTasks,
    overdueTasks: tasks.filter(task => task.status !== 'complete' && task.due_date && task.due_date < new Date().toISOString().slice(0, 10)),
    next7Days: tasks.filter(task => task.due_date && Math.abs(daysBetween(new Date().toISOString().slice(0, 10), task.due_date)) <= 7),
    needsKenTasks: blockedTasks.filter(task => task.status === 'needs_ken'),
    selectedVisualAssets: campaign.asset_selection || {},
    capturedLinks: campaign.links || {},
  };
}

export async function runNextMagicReleaseTask({ releaseType, releaseId, dryRun = false } = {}) {
  const state = getMagicReleaseState(releaseType, releaseId) || createMagicReleaseCampaign({ releaseType, releaseId });
  const task = state.tasks.find(item => item.status === 'ready');
  if (!task) return { ok: true, skipped: true, reason: 'No ready tasks.' };
  return runMagicReleaseTask({ campaignId: state.campaign.id, taskKey: task.task_key, dryRun });
}

export async function runMagicReleaseWorker({ nowIso = new Date().toISOString(), dryRun = true } = {}) {
  const readyTasks = getReadyReleaseCampaignTasks({ nowIso })
    .filter(task => task.owner !== 'ken')
    .filter(task => !['youtube_teaser_schedule', 'short_form_schedule', 'thank_you_post'].includes(task.task_key));
  const processed = [];
  for (const task of readyTasks) {
    const campaign = upsertReleaseCampaign({ id: task.campaign_id });
    const result = await runMagicReleaseTask({ campaignId: campaign.id, taskKey: task.task_key, dryRun });
    processed.push({ taskKey: task.task_key, campaignId: campaign.id, result });
  }
  return { ok: true, processed };
}

export async function runMagicReleaseTask({ campaignId, taskKey, dryRun = false } = {}) {
  const campaign = upsertReleaseCampaign({ id: campaignId });
  const task = getReleaseCampaignTaskByKey(campaign.id, taskKey);
  if (!task) throw new Error(`Release campaign task not found: ${taskKey}`);
  const release = getReleaseEntity(campaign.release_type, campaign.release_id);
  if (task.owner === 'ken') {
    return markNeedsKenTask(task, 'Human gate preserved for this step.');
  }
  if (task.owner === 'agent') {
    return runAgentTask({ campaign, task, release, dryRun });
  }
  if (task.owner === 'browsy') {
    return runBrowsyTask({ campaign, task, release, dryRun });
  }
  return markNeedsKenTask(task, 'Task requires manual platform review.');
}

export async function ingestBrowsyResult({ resultPath, campaignId = null, taskKey = null } = {}) {
  // System boundary: Browsy posts this callback with a local result file path.
  // Validate explicitly so a malformed callback yields a clear error instead of a
  // cryptic "path must be a string" / ENOENT / SyntaxError.
  const cleanPath = typeof resultPath === 'string' ? resultPath.trim() : '';
  if (!cleanPath) throw new Error('Browsy result ingest requires a result_path.');
  if (!fs.existsSync(cleanPath)) throw new Error(`Browsy result file not found: ${cleanPath}`);
  let result;
  try {
    result = JSON.parse(fs.readFileSync(cleanPath, 'utf8'));
  } catch (error) {
    throw new Error(`Browsy result file is not valid JSON (${cleanPath}): ${error.message}`);
  }
  const campaign = campaignId
    ? upsertReleaseCampaign({ id: campaignId })
    : ensureCampaignForRelease(result.entity_type, result.entity_id);
  const task = taskKey
    ? getReleaseCampaignTaskByKey(campaign.id, taskKey)
    : findTaskForWorkflow(campaign.id, result.workflow_id);
  if (!task) throw new Error(`No campaign task found for Browsy workflow ${result.workflow_id}`);
  const nextStatus = mapBrowsyStatus(result.status);
  // Prefer the concrete failure reason Browsy reported (e.g. an auth-profile lock)
  // over the generic mapBrowsyStatus copy, so the cockpit and the UI banner show
  // the actionable cause instead of "Browsy workflow failed."
  const blockingActionRequest = (result.client_action_requests || []).find(req => req?.severity === 'blocking') || null;
  const detailedReason = nextStatus.status === 'complete'
    ? null
    : (result.next_required_action || blockingActionRequest?.reason || (result.errors || []).slice(-1)[0] || null);
  const updatedTask = upsertReleaseCampaignTask({
    id: task.id,
    campaign_id: campaign.id,
    task_key: task.task_key,
    status: nextStatus.status,
    result: result,
    result_path: cleanPath,
    source_workflow_id: result.workflow_id,
    source_run_id: result.run_id || null,
    reason: detailedReason || nextStatus.reason || task.reason,
    suggested_action: blockingActionRequest?.suggested_action || nextStatus.suggestedAction || task.suggested_action,
    completed_at: nextStatus.status === 'complete' ? new Date().toISOString() : null,
  });
  if (result.captured_outputs) applyCapturedOutputs(campaign, result.captured_outputs, result);
  for (const request of result.client_action_requests || []) {
    createNeedsKenTaskFromActionRequest(campaign, task, request, cleanPath, result);
  }
  addReleaseCockpitLog({
    releaseType: campaign.release_type,
    releaseId: campaign.release_id,
    action: 'magic_release_ingest',
    status: nextStatus.logStatus,
    message: `Browsy result ingested for ${result.workflow_id}.`,
    payload: {
      taskKey: task.task_key,
      resultPath: cleanPath,
      workflowStatus: result.status,
      workflowRef: result.workflow_id,
      runId: result.run_id || null,
    },
  });
  recomputeTaskStatuses(campaign.id);
  return {
    ok: true,
    task: updatedTask,
    campaign: getMagicReleaseState(campaign.release_type, campaign.release_id),
  };
}

export function summarizeMagicReleaseForCockpit(releaseType, releaseId) {
  const state = getMagicReleaseState(releaseType, releaseId);
  if (!state) return null;
  return {
    campaignId: state.campaign.id,
    status: state.campaign.status,
    lifecycleState: state.campaign.lifecycle_state,
    currentGate: state.campaign.current_gate,
    readyCount: state.readyTasks.length,
    blockedCount: state.blockedTasks.length,
    needsKenCount: state.needsKenTasks.length,
    overdueCount: state.overdueTasks.length,
    nextTask: state.readyTasks[0] || null,
    capturedLinks: state.campaign.links || {},
    selectedVisualAssets: state.campaign.asset_selection || {},
    runs: state.runs.slice(0, 10),
    tasks: state.tasks,
  };
}

// Non-blocking summary of the Browsy integration for the Release Cockpit. It
// reports configuration and the last persisted run without making a network
// call, so building the cockpit view model stays fast. Reachability is checked
// explicitly via the cockpit's "preview/run" actions, not here.
export function summarizeBrowsyIntegration(releaseType, releaseId) {
  const config = getBrowsyConfig();
  const state = getMagicReleaseState(releaseType, releaseId);
  const runs = state?.runs || [];
  const lastRun = runs.find(run => run.workflow_id) || null;
  const log = lastRun?.log || {};
  return {
    configured: Boolean(config.baseUrl),
    baseUrl: config.baseUrl,
    appId: config.appId,
    mode: config.dryRun === true ? 'dry_run' : (config.dryRun === false ? 'replay' : config.mode),
    dryRunForced: config.dryRun,
    workflowIds: BROWSY_WORKFLOW_IDS,
    lastRun: lastRun ? {
      id: lastRun.id,
      workflowId: lastRun.workflow_id,
      workflowVersion: log.workflow_version || null,
      browsyRunId: log.browsy_run_id || lastRun.run_id || null,
      status: lastRun.status,
      browsyStatus: log.browsy_status || null,
      pancakeStatus: log.pancake_status || null,
      mode: log.mode || null,
      dryRun: Boolean(log.dry_run),
      reachable: log.reachable !== false,
      timedOut: Boolean(log.timed_out),
      resultPath: lastRun.result_path || null,
      packagePath: lastRun.package_path || null,
      artifactPaths: log.artifact_paths || [],
      error: log.error || null,
      finishedAt: log.finished_at || lastRun.updated_at || null,
    } : null,
  };
}

function getReleaseEntity(releaseType, releaseId) {
  if (String(releaseType || '').toLowerCase() === 'album') {
    const album = getAlbum(releaseId);
    if (!album) throw new Error(`Album not found: ${releaseId}`);
    const tracks = getSongsForAlbum(releaseId);
    return {
      type: 'album',
      id: album.id,
      title: album.album_title || album.album_theme || album.id,
      releaseDate: album.release_date || null,
      tracks,
      singles: tracks.filter(track => track.album_role === 'single').sort((a, b) => (a.single_priority || 999) - (b.single_priority || 999)),
      album,
    };
  }
  const song = getSong(releaseId);
  if (!song) throw new Error(`Song not found: ${releaseId}`);
  return {
    type: 'single',
    id: song.id,
    title: song.title || song.topic || song.id,
    releaseDate: song.release_date || null,
    tracks: [song],
    singles: [],
    song,
  };
}

function buildCampaignContext(release) {
  return {
    release_type: release.type,
    release_id: release.id,
    release_date: release.releaseDate,
    title: release.title,
    tracks: release.tracks.map(track => ({
      id: track.id,
      title: track.title || track.topic || track.id,
      track_number: track.track_number || null,
      album_role: track.album_role || 'track',
      single_priority: track.single_priority || null,
      single_visual_asset_id: track.single_visual_asset_id || null,
      single_custom_video_requested: track.single_custom_video_requested || false,
    })),
    album_singles: release.singles.map(track => track.id),
    hyperfollow_status: Boolean((collectReleaseLinks(release).hyperfollow_url || '').trim()) ? 'captured' : 'missing',
    asset_readiness: release.tracks.some(track => Object.keys(getSongMarketingKit(track.id).marketing_assets || {}).length) ? 'partial' : 'missing',
    social_readiness: 'draft_only',
    outreach_readiness: 'draft_only',
    platform_links: collectReleaseLinks(release),
  };
}

function collectReleaseLinks(release) {
  const aggregated = {};
  for (const track of release.tracks) {
    for (const link of getReleaseLinks(track.id)) {
      const key = normalizeLinkKey(link.platform);
      if (!aggregated[key]) aggregated[key] = link.url;
    }
    const kitLinks = getSongMarketingKit(track.id).marketing_links || {};
    for (const [key, value] of Object.entries(kitLinks)) {
      if (value && !aggregated[key]) aggregated[key] = value;
    }
  }
  return aggregated;
}

function buildTaskFromTemplate({ campaign, release, template }) {
  const dueDate = computeDueDate(release.releaseDate, template.offsetDays);
  return {
    campaign_id: campaign.id,
    task_key: template.key,
    title: template.title,
    description: buildTaskDescription(template, release),
    owner: template.owner,
    status: 'pending',
    due_date: dueDate,
    offset_days: template.offsetDays,
    depends_on: template.dependsOn || [],
    blocking: template.blocking,
    action_url: `/releases/${encodeURIComponent(release.type)}/${encodeURIComponent(release.id)}/magic-release/tasks/${encodeURIComponent(template.key)}/run`,
    source_workflow_id: typeof template.workflowId === 'function' ? template.workflowId(release) : (template.workflowId || null),
  };
}

function buildTaskDescription(template, release) {
  if (template.key === 'decide_custom_video' && release.type === 'album') {
    return `Album singles: ${release.singles.map(track => track.title || track.id).join(', ') || 'none assigned yet'}.`;
  }
  return `${template.title} for ${release.title}.`;
}

function ensureCampaignForRelease(releaseType, releaseId, { createIfMissing = true } = {}) {
  let campaign = getReleaseCampaignByRelease(releaseType, releaseId);
  if (!campaign && createIfMissing) {
    campaign = createMagicReleaseCampaign({ releaseType, releaseId }).campaign;
  }
  return campaign;
}

function recomputeTaskStatuses(campaignId) {
  const tasks = listReleaseCampaignTasks(campaignId);
  const byKey = new Map(tasks.map(task => [task.task_key, task]));
  for (const task of tasks) {
    const nextStatus = deriveTaskStatus(task, byKey);
    if (nextStatus !== task.status) {
      upsertReleaseCampaignTask({
        id: task.id,
        campaign_id: task.campaign_id,
        task_key: task.task_key,
        status: nextStatus,
      });
    }
  }
  return listReleaseCampaignTasks(campaignId);
}

function deriveTaskStatus(task, byKey) {
  if (['running', 'complete', 'needs_ken', 'failed', 'blocked', 'skipped'].includes(task.status)) return task.status;
  const dependencies = (task.depends_on || []).map(key => byKey.get(key)).filter(Boolean);
  if (dependencies.some(dep => ['failed', 'blocked', 'needs_ken'].includes(dep.status) && dep.blocking)) return 'blocked';
  if (dependencies.some(dep => dep.status !== 'complete' && dep.status !== 'skipped')) return 'pending';
  return 'ready';
}

async function runAgentTask({ campaign, task, release, dryRun }) {
  upsertReleaseCampaignTask({ id: task.id, campaign_id: campaign.id, task_key: task.task_key, status: 'running' });
  let payload = {};
  if (task.task_key === 'verify_release_metadata' || task.task_key === 'distrokid_package_readiness') {
    payload = { tracks: release.tracks.length, ready: true };
  } else if (task.task_key === 'select_visual_assets') {
    payload = selectVisualAssetsForCampaign(release);
    const currentSelection = campaign.asset_selection || {};
    upsertReleaseCampaign({
      id: campaign.id,
      asset_selection: {
        ...currentSelection,
        [task.task_key]: payload,
      },
      current_gate: payload.needs_ken ? 'visual_asset_review' : campaign.current_gate,
    });
    if (payload.needs_ken) {
      upsertReleaseCampaignTask({
        campaign_id: campaign.id,
        task_key: 'request_custom_video',
        title: payload.needs_ken.title,
        owner: 'ken',
        status: 'needs_ken',
        blocking: false,
        due_date: task.due_date,
        reason: payload.needs_ken.reason,
        suggested_action: payload.needs_ken.suggested_action,
        action_url: `/releases/${encodeURIComponent(release.type)}/${encodeURIComponent(release.id)}`,
      });
    }
  } else if (task.task_key === 'outreach_wave_1' || task.task_key === 'outreach_follow_up') {
    payload = createReleaseOutreachWave(release, dryRun);
  } else if (task.task_key === 'pre_save_push' || task.task_key === 'catalog_push' || task.task_key === 'switch_release_cta' || task.task_key === 'thank_you_post') {
    payload = createReleaseSocialDrafts(release, task.task_key, dryRun);
  } else if (task.task_key === 'performance_snapshot' || task.task_key === 'campaign_retrospective') {
    payload = { ok: true, notes: `${task.title} recorded.` };
  }
  const status = payload.needs_ken ? 'needs_ken' : 'complete';
  const updatedTask = upsertReleaseCampaignTask({
    id: task.id,
    campaign_id: campaign.id,
    task_key: task.task_key,
    status,
    result: payload,
    completed_at: status === 'complete' ? new Date().toISOString() : null,
    reason: payload.needs_ken?.reason || task.reason,
    suggested_action: payload.needs_ken?.suggested_action || task.suggested_action,
  });
  addReleaseCockpitLog({
    releaseType: campaign.release_type,
    releaseId: campaign.release_id,
    action: 'magic_release_task',
    status: status === 'complete' ? 'success' : 'warning',
    message: `${task.title} ${status}.`,
    payload: { taskKey: task.task_key, dryRun, result: status },
  });
  recomputeTaskStatuses(campaign.id);
  return { ok: true, task: updatedTask, payload };
}

async function runBrowsyTask({ campaign, task, release, dryRun }) {
  const config = getBrowsyConfig();
  const effectiveDryRun = config.dryRun === null ? Boolean(dryRun) : config.dryRun;
  upsertReleaseCampaignTask({ id: task.id, campaign_id: campaign.id, task_key: task.task_key, status: 'running' });
  const packageResult = writeBrowsyWorkflowPackage({ campaign, task, release, dryRun: effectiveDryRun });
  const run = addReleaseCampaignRun({
    campaign_id: campaign.id,
    task_id: task.id,
      workflow_id: task.source_workflow_id,
      status: 'running',
      package_path: packageResult.packagePath,
      log: {
      mode: effectiveDryRun ? 'dry_run' : 'replay',
      browsy_base_url: config.baseUrl,
      browsy_app_id: config.appId,
      started_at: new Date().toISOString(),
    },
  });

  const execution = await runBrowsyWorkflow({
    workflowId: task.source_workflow_id,
    packagePath: packageResult.packagePath,
    payload: packageResult.payload,
    dryRun: effectiveDryRun,
    config,
    // Persist the Browsy runId + awaiting-confirmation marker the instant the run
    // starts, so a cockpit reload can render the "Confirm & resume live submit"
    // button while this call is still blocked polling the parked run.
    onRunStart: ({ runId, awaitingConfirmation }) => {
      updateReleaseCampaignRun(run.id, {
        run_id: runId,
        log: { ...(run.log || {}), browsy_run_id: runId, awaiting_submit_confirmation: Boolean(awaitingConfirmation), awaiting_since: new Date().toISOString() },
      });
    },
  });

  updateReleaseCampaignRun(run.id, {
    run_id: execution.runId || execution.result?.run_id || null,
    status: execution.runRecordStatus || (execution.ok ? 'complete' : 'failed'),
    result_path: execution.resultPath || null,
    log: {
      mode: effectiveDryRun ? 'dry_run' : 'replay',
      browsy_base_url: config.baseUrl,
      browsy_app_id: config.appId,
      workflow_id: task.source_workflow_id,
      workflow_version: config.workflowVersion || null,
      browsy_run_id: execution.runId || null,
      browsy_workflow_ref: execution.workflowRef || null,
      browsy_status: execution.browsyStatus || null,
      pancake_status: execution.resultStatus || null,
      artifact_paths: execution.artifactPaths || [],
      finished_at: new Date().toISOString(),
      error: execution.error || null,
      reachable: execution.reachable !== false,
      dry_run: effectiveDryRun,
      timed_out: Boolean(execution.timedOut),
    },
  });

  if (execution.resultPath && fs.existsSync(execution.resultPath)) {
    return ingestBrowsyResult({ resultPath: execution.resultPath, campaignId: campaign.id, taskKey: task.task_key });
  }

  // No result file was written (only happens on an internal error). Surface a
  // clear failure instead of pretending the run completed.
  const updatedTask = upsertReleaseCampaignTask({
    id: task.id,
    campaign_id: campaign.id,
    task_key: task.task_key,
    status: 'failed',
    result: execution,
    reason: execution.error || 'Browsy run did not produce a result.',
  });
  recomputeTaskStatuses(campaign.id);
  return { ok: false, task: updatedTask, execution };
}

function markNeedsKenTask(task, reason) {
  const updatedTask = upsertReleaseCampaignTask({
    id: task.id,
    campaign_id: task.campaign_id,
    task_key: task.task_key,
    status: 'needs_ken',
    reason,
    suggested_action: task.suggested_action || task.title,
  });
  return { ok: true, task: updatedTask, needsKen: true };
}

function mapBrowsyStatus(status) {
  switch (status) {
    case 'dry_run_passed':
      return { status: 'complete', logStatus: 'success' };
    case 'replay_run_gated':
      return { status: 'needs_ken', logStatus: 'warning', reason: 'Browsy replay paused for human approval before final submit.', suggestedAction: 'Review the DistroKid browser session and click the final submit button manually if everything is correct.' };
    case 'replay_run_completed':
      return { status: 'complete', logStatus: 'success' };
    case 'live_run_gated':
      return { status: 'needs_ken', logStatus: 'warning', reason: 'Browsy paused for human approval before final submit.', suggestedAction: 'Approve the DistroKid final submit gate.' };
    case 'live_run_completed':
      return { status: 'complete', logStatus: 'success' };
    case 'blocked_auth':
      return { status: 'needs_ken', logStatus: 'warning', reason: 'Browsy needs an authenticated session (login/2FA).', suggestedAction: 'Complete login in the Browsy session, then rerun.' };
    case 'blocked_validation':
      return { status: 'needs_ken', logStatus: 'warning', reason: 'Browsy could not resolve required inputs automatically.', suggestedAction: 'Resolve the flagged inputs, then rerun.' };
    case 'blocked':
      return { status: 'needs_ken', logStatus: 'warning', reason: 'Browsy returned a blocking result.' };
    case 'not_configured':
      return { status: 'blocked', logStatus: 'error', reason: 'Browsy is not configured or unreachable. No automation ran and nothing was submitted.', suggestedAction: 'Start the Browsy service or set PANCAKE_BROWSY_DRY_RUN=true.' };
    case 'contract_not_ready':
      return { status: 'needs_ken', logStatus: 'warning', reason: 'Browsy workflow has no recorded/imported contract yet (scaffold-only or missing). No automation ran.', suggestedAction: 'Record/import Browsy workflow first.' };
    case 'timeout':
      return { status: 'failed', logStatus: 'error', reason: 'Browsy run timed out before reaching a terminal state.' };
    default:
      return { status: 'failed', logStatus: 'error', reason: 'Browsy workflow failed.' };
  }
}

function applyCapturedOutputs(campaign, outputs, result) {
  const release = getReleaseEntity(campaign.release_type, campaign.release_id);
  const links = { ...(campaign.links || {}) };
  const updateTrackLinks = (platform, url) => {
    for (const track of release.tracks) upsertReleaseLink(track.id, platform, url);
  };
  for (const [key, raw] of Object.entries(outputs)) {
    // Browsy surfaces captured outputs as { status, value, selector, required }
    // objects; simpler callers may pass a raw string. Normalize to the value.
    const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    if (!value) continue;
    if (['smart_link_url', 'hyperfollow_url'].includes(key)) {
      links.smart_link_url = value;
      links.hyperfollow_url = value;
      updateTrackLinks('HyperFollow', value);
      for (const track of release.tracks) saveSongMarketingKit(track.id, { marketing_links: { smart_link: value } });
    } else if (['external_release_url', 'distrokid_release_url'].includes(key)) {
      links.distrokid_release_url = value;
      updateTrackLinks('DistroKid', value);
    } else if (/spotify/i.test(key)) {
      links.spotify_url = value;
      updateTrackLinks('Spotify', value);
    } else if (/apple/i.test(key)) {
      links.apple_music_url = value;
      updateTrackLinks('Apple Music', value);
    } else if (/youtube/i.test(key)) {
      links.youtube_url = value;
      updateTrackLinks('YouTube', value);
    } else if (/media_path|downloaded_media_path/i.test(key)) {
      links[key] = value;
    } else {
      links[key] = value;
    }
  }
  upsertReleaseCampaign({
    id: campaign.id,
    links,
    run_summary: {
      ...(campaign.run_summary || {}),
      last_result_status: result.status,
      last_run_id: result.run_id || null,
    },
  });
}

function createNeedsKenTaskFromActionRequest(campaign, sourceTask, request, resultPath, result) {
  const taskKey = normalizeTaskKey(request.suggested_action || request.reason || request.type || 'needs_ken');
  upsertReleaseCampaignTask({
    campaign_id: campaign.id,
    task_key: taskKey,
    title: request.suggested_action || request.type || 'Needs review',
    owner: 'ken',
    status: request.severity === 'blocking' ? 'needs_ken' : 'ready',
    blocking: request.severity === 'blocking',
    due_date: new Date().toISOString().slice(0, 10),
    action_url: `/releases/${encodeURIComponent(campaign.release_type)}/${encodeURIComponent(campaign.release_id)}`,
    reason: request.reason || 'Browsy requested human review.',
    suggested_action: request.suggested_action || 'Review task',
    related_item_id: request.related_item_id || request.relatedItemId || request.related_field || null,
    result_path: resultPath,
    source_workflow_id: result.workflow_id,
    source_run_id: result.run_id || null,
  });
}

function selectVisualAssetsForCampaign(release) {
  const releaseType = release.type;
  const releaseId = release.id;
  const bySong = {};
  let needsKen = null;
  for (const track of release.tracks) {
    const selection = selectReusableAssetOrSuggestCustomVideo({
      releaseType,
      releaseId,
      songId: track.id,
      platform: 'instagram',
      usageContext: track.album_role === 'single' ? 'single_teaser' : 'album_teaser',
    });
    bySong[track.id] = selection.asset;
    if (!selection.asset && selection.needsKenTask) needsKen = selection.needsKenTask;
  }
  return {
    selected_assets: bySong,
    recommendations: recommendVisualAssets({ releaseType, releaseId, limit: 10 }),
    library_asset_count: listVisualLibraryAssets().length,
    needs_ken: needsKen,
  };
}

function createReleaseOutreachWave(release, dryRun) {
  const outlets = getCanonicalEmailOutletsForSelection().slice(0, 10);
  if (!outlets.length) {
    return {
      ok: true,
      draftOnly: true,
      skipped: true,
      notes: 'No eligible outlets were available.',
    };
  }
  const songIds = release.type === 'album' ? release.tracks.map(track => track.id) : [release.id];
  return createOutreachRun({
    song_ids: songIds,
    outlet_ids: outlets.map(outlet => outlet.id),
    mode: release.type === 'album' ? 'bundle' : 'single_release',
    dry_run: dryRun !== false,
  });
}

function createReleaseSocialDrafts(release, campaignMoment, dryRun) {
  const primarySongId = release.type === 'album'
    ? (release.singles[0]?.id || release.tracks[0]?.id)
    : release.id;
  const platforms = campaignMoment === 'pre_save_push' ? ['instagram', 'facebook'] : ['instagram', 'facebook', 'youtube'];
  const campaigns = platforms.map(platform => createOrRefreshReleaseSocialCampaign({
    releaseType: release.type,
    releaseId: release.id,
    campaignId: null,
    date: release.releaseDate || new Date().toISOString().slice(0, 10),
    platform,
    campaignMoment: mapTaskToMoment(campaignMoment),
    songId: primarySongId,
    visualAssetId: null,
    dryRun,
  }));
  return { ok: true, campaigns };
}

function mapTaskToMoment(taskKey) {
  switch (taskKey) {
    case 'pre_save_push': return 'pre_save_announcement';
    case 'catalog_push': return 'catalog_push';
    case 'thank_you_post': return 'post_release_save_share';
    default: return 'release_day';
  }
}

function writeBrowsyWorkflowPackage({ campaign, task, release, dryRun }) {
  const workflowDir = path.join(WORKFLOW_ROOT, campaign.id, task.task_key);
  fs.mkdirSync(workflowDir, { recursive: true });
  const packagePath = path.join(workflowDir, 'workflow-package.json');
  const manifestPath = path.join(workflowDir, 'manifest.json');
  const canonicalPayload = /distrokid/i.test(task.source_workflow_id || '')
    ? buildCanonicalDistroKidPayload({ releaseType: release.type, releaseId: release.id })
    : {
        release_title: release.title,
        release_date: release.releaseDate,
        tracks: release.tracks.map(track => ({
          id: track.id,
          title: track.title || track.topic || track.id,
          track_number: track.track_number || null,
        })),
      };
  const payload = {
    workflow_id: task.source_workflow_id,
    source_system: 'pancake_robot',
    entity_type: release.type,
    entity_id: release.id,
    mode: dryRun ? 'dry_run' : 'preview',
    pancake_mode: dryRun ? 'dry_run' : 'replay',
    human_gate: true,
    manifest_path: path.relative(REPO_ROOT, manifestPath),
    canonical_payload: canonicalPayload,
    assets: buildBrowsyPackageAssets(canonicalPayload),
    capture_outputs: defaultCaptureOutputs(task.source_workflow_id),
    on_failure: 'stop_and_return_blocked_result',
    return_contract_version: 'automation-result-v1',
  };
  fs.writeFileSync(manifestPath, JSON.stringify({
    campaign_id: campaign.id,
    task_key: task.task_key,
    generated_at: new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(packagePath, JSON.stringify(payload, null, 2));
  return { packagePath, manifestPath, payload };
}

// Runs (or explicitly dry-runs) a Browsy workflow and writes a pancake-contract
// result.json that ingestBrowsyResult understands. There is no silent fake
// success: an explicit dry-run is clearly marked, and a replay that cannot reach
// Browsy is recorded as not_configured rather than a passing run.
async function runBrowsyWorkflow({ workflowId, packagePath, payload, dryRun, config = getBrowsyConfig(), onRunStart = null }) {
  const resultPath = path.join(path.dirname(packagePath), 'result.json');
  const packagePayload = payload || JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const entityType = packagePayload.entity_type;
  const entityId = packagePayload.entity_id;
  const captureOutputs = packagePayload.capture_outputs || [];
  // One correlation id ties a Pancake release run to its Browsy run across both
  // systems' logs. It rides the HTTP body to Browsy and is echoed in cockpit
  // logs and result.json so a failed live run is traceable end-to-end.
  const correlationId = makeBrowsyCorrelationId(entityType, entityId);

  if (dryRun) {
    addReleaseCockpitLog({
      releaseType: entityType,
      releaseId: entityId,
      action: 'browsy_run',
      status: 'info',
      message: 'Browsy preview started.',
      payload: { workflowId, correlationId, dryRun: true, mode: 'preview' },
    });
    const result = baseResult({ workflowId, entityType, entityId, captureOutputs, correlationId });
    result.status = 'dry_run_passed';
    result.dry_run = true;
    result.mode = 'preview';
    result.note = 'Explicit Browsy dry-run. No browser automation was executed and nothing was submitted.';
    writeJson(resultPath, result);
    return {
      ok: true,
      dryRun: true,
      resultPath,
      runRecordStatus: 'complete',
      resultStatus: 'dry_run_passed',
      browsyStatus: null,
      reachable: true,
      result,
    };
  }

  // Replays are gated on contract readiness. Before any browser automation we
  // fetch the workflow contract from Browsy and verify it is a real
  // recorded/imported workflow — not a scaffold-only stub. A missing or
  // incomplete contract is reported as a blocking result, never a fake run.
  const contractGate = await getBrowsyWorkflowContract({ workflowId, version: config.workflowVersion || '', config });
  if (contractGate.reachable === false) {
    const result = baseResult({ workflowId, entityType, entityId, captureOutputs, correlationId });
    result.status = 'not_configured';
    result.mode = 'preview';
    result.pancake_mode = 'replay';
    result.errors = [contractGate.error || 'Browsy service was unreachable while fetching the workflow contract.'];
    result.next_required_action = `Start Browsy at ${config.baseUrl} and rerun, or set PANCAKE_BROWSY_DRY_RUN=true for a dry run.`;
    writeJson(resultPath, result);
    return {
      ok: false,
      resultPath,
      runRecordStatus: 'blocked',
      resultStatus: 'not_configured',
      reachable: false,
      error: contractGate.error || 'Browsy unreachable',
      result,
    };
  }

  const completeness = evaluateBrowsyContractCompleteness(contractGate.contract, workflowId);
  if (!completeness.ready) {
    const result = baseResult({ workflowId, entityType, entityId, captureOutputs, correlationId });
    result.status = 'contract_not_ready';
    result.mode = 'preview';
    result.pancake_mode = 'replay';
    result.errors = [completeness.summary];
    result.contract_completeness = completeness;
    result.next_required_action = 'Record/import the Browsy workflow first.';
    writeJson(resultPath, result);
    return {
      ok: false,
      resultPath,
      runRecordStatus: 'blocked',
      resultStatus: 'contract_not_ready',
      reachable: true,
      error: completeness.summary,
      result,
    };
  }

  const variables = buildBrowsyRunVariables(packagePayload);
  addReleaseCockpitLog({
    releaseType: entityType,
    releaseId: entityId,
    action: 'browsy_run',
    status: 'info',
    message: 'Browsy replay started.',
    payload: {
      workflowId,
      correlationId,
      mode: 'preview',
      releaseId: variables.releaseId,
      variablesResolved: ['releaseId', 'album.coverArtPath', 'tracks[].audioPath', 'tracks.length'],
      authProfileRef: contractGate.contract?.authProfileRef || contractGate.contract?.auth?.[0]?.authProfileId || contractGate.contract?.auth?.[0]?.siteId || null,
    },
  });
  // End-to-end auto-submit is opt-in via env flag and OFF by default, so a normal
  // run still parks at the human checkpoint. When enabled, the live run still
  // requires a human confirm (Browsy parks until POST /api/runs/:id/confirm-submit)
  // before it clicks final submit and harvests the HyperFollow link.
  const autoSubmit = process.env.PANCAKE_DISTROKID_AUTO_SUBMIT === 'true';
  const execution = await executeBrowsyWorkflowRun({
    workflowId,
    payload: variables,
    mode: 'preview',
    callerId: 'pancake-robot',
    correlationId,
    // A live auto-submit run parks at the checkpoint waiting for a human confirm;
    // surface the runId immediately so the cockpit can show a "Confirm & resume"
    // button while we keep polling for the final HyperFollow capture.
    onStart: autoSubmit ? (runId => onRunStart?.({ runId, awaitingConfirmation: true })) : null,
    options: {
      leaveBrowserOpen: true,
      usePersistentProfile: true,
      authProfileId: contractGate.contract?.authProfileRef || contractGate.contract?.auth?.[0]?.authProfileId || contractGate.contract?.auth?.[0]?.siteId || 'distrokid',
      requireHumanApproval: true,
      autoSubmit,
      confirmBeforeSubmit: true,
    },
    config,
  });

  // Browsy unreachable / not configured: surface a clear blocked status.
  if (execution.reachable === false) {
    const result = baseResult({ workflowId, entityType, entityId, captureOutputs, correlationId });
    result.status = 'not_configured';
    result.mode = 'preview';
    result.pancake_mode = 'replay';
    result.errors = [execution.error || 'Browsy service was unreachable.'];
    result.next_required_action = `Start Browsy at ${config.baseUrl} and rerun, or set PANCAKE_BROWSY_DRY_RUN=true for a dry run.`;
    writeJson(resultPath, result);
    return {
      ok: false,
      resultPath,
      runRecordStatus: 'blocked',
      resultStatus: 'not_configured',
      reachable: false,
      error: execution.error || 'Browsy unreachable',
      result,
    };
  }

  if (execution.timedOut) {
    const result = resultFromBrowsyRun({ workflowId, entityType, entityId, captureOutputs, execution, correlationId });
    result.status = 'timeout';
    result.mode = 'preview';
    result.pancake_mode = 'replay';
    result.errors = [`Browsy run ${execution.runId} did not reach a terminal state within the timeout.`];
    writeJson(resultPath, result);
    return {
      ok: false,
      resultPath,
      runId: execution.runId,
      workflowRef: execution.workflowRef,
      runRecordStatus: 'failed',
      resultStatus: 'timeout',
      browsyStatus: execution.status,
      artifactPaths: result.artifact_paths,
      reachable: true,
      timedOut: true,
      result,
    };
  }

  const result = resultFromBrowsyRun({ workflowId, entityType, entityId, captureOutputs, execution, correlationId });
  result.status = mapCategoryToResultStatus(execution.category);
  result.mode = 'preview';
  result.pancake_mode = 'replay';
  writeJson(resultPath, result);
  const failureReason = execution.category === 'success'
    ? null
    : (result.next_required_action || result.errors[result.errors.length - 1] || 'Browsy workflow did not complete.');
  return {
    ok: execution.category === 'success',
    resultPath,
    runId: execution.runId,
    workflowRef: execution.workflowRef,
    runRecordStatus: execution.category === 'success' ? 'complete' : (execution.category === 'failed' ? 'failed' : 'blocked'),
    resultStatus: result.status,
    browsyStatus: execution.status,
    artifactPaths: result.artifact_paths,
    reachable: true,
    error: failureReason,
    clientActionRequests: result.client_action_requests,
    result,
  };
}

// Derives a stable, greppable correlation id for a Browsy run. The id is shared
// across Pancake cockpit logs, the Browsy HTTP body, and Browsy's own run logs.
function makeBrowsyCorrelationId(entityType, entityId) {
  const slug = String(`${entityType || 'release'}-${entityId || 'unknown'}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `pr-${slug}-${Date.now().toString(36)}`;
}

function baseResult({ workflowId, entityType, entityId, captureOutputs, correlationId = null }) {
  return {
    ok: true,
    workflow_id: workflowId,
    run_id: null,
    correlation_id: correlationId,
    source_system: 'pancake_robot',
    entity_type: entityType,
    entity_id: entityId,
    status: null,
    captured_outputs: {},
    requested_outputs: captureOutputs,
    filled_fields: [],
    skipped_fields: [],
    errors: [],
    screenshots: [],
    artifact_paths: [],
    manual_checkpoints: [],
    client_action_requests: [],
    next_required_action: null,
  };
}

// Translates a live Browsy run (buildRunResult shape) into the pancake-contract
// result.json shape consumed by ingestBrowsyResult.
function resultFromBrowsyRun({ workflowId, entityType, entityId, captureOutputs, execution, correlationId }) {
  const runResult = execution.result || {};
  const runRecord = execution.run || {};
  const artifactGroups = runResult.artifacts || {};
  const screenshots = (artifactGroups.screenshots || []).map(a => a.path || a.name).filter(Boolean);
  const artifactPaths = ['screenshots', 'downloads', 'trace', 'logs']
    .flatMap(key => (artifactGroups[key] || []).map(a => a.path).filter(Boolean));
  const checkpoints = runResult.checkpoints || [];
  const category = execution.category;
  // Browsy records the concrete failure reason (e.g. an auth-profile lock) on the
  // run record's validationErrors. Pull it through so the cockpit/UI shows the real
  // cause instead of a generic "Browsy workflow failed".
  const validationErrors = (Array.isArray(runResult.validationErrors) && runResult.validationErrors.length
    ? runResult.validationErrors
    : (Array.isArray(runRecord.validationErrors) ? runRecord.validationErrors : []))
    .map(e => String(e)).filter(Boolean);
  const lockError = validationErrors.find(e => /locked by another browser/i.test(e)) || null;
  // A hard failure reason (lock / validation error) takes precedence over any
  // stale "waiting on approval" blockingReason left on the run.
  const blockingReason = lockError || (execution.category === 'failed' ? validationErrors[0] : null) || runResult.blockingReason || validationErrors[0] || null;
  const clientActionRequests = [];
  if (lockError) {
    clientActionRequests.push({
      type: 'browser_profile_locked',
      severity: 'blocking',
      reason: lockError,
      suggested_action: 'Close the open DistroKid automation browser window, then run the automation again.',
    });
  }
  if (category === 'blocked_human_approval') {
    clientActionRequests.push({
      type: 'human_decision_required',
      severity: 'blocking',
      reason: blockingReason || 'Browsy paused for human approval before completing.',
      suggested_action: 'Review and approve the Browsy run before final submission.',
    });
  } else if (category === 'blocked_auth') {
    clientActionRequests.push({
      type: 'auth_required',
      severity: 'blocking',
      reason: blockingReason || 'Browsy needs an authenticated session.',
      suggested_action: 'Complete login/2FA in the Browsy session, then rerun.',
    });
  } else if (category === 'blocked_validation') {
    clientActionRequests.push({
      type: 'human_decision_required',
      severity: 'blocking',
      reason: blockingReason || 'Browsy could not resolve required inputs automatically.',
      suggested_action: 'Resolve the flagged inputs, then rerun.',
    });
  }

  return {
    ok: category === 'success',
    workflow_id: workflowId,
    run_id: execution.runId || null,
    correlation_id: correlationId || null,
    browsy_run_id: execution.runId || null,
    browsy_status: execution.status || null,
    source_system: 'pancake_robot',
    entity_type: entityType,
    entity_id: entityId,
    status: null,
    captured_outputs: runResult.outputs || {},
    requested_outputs: captureOutputs,
    filled_fields: runResult.completedSteps || [],
    skipped_fields: runResult.skippedSteps || [],
    errors: [...(runResult.failedSteps || []), ...validationErrors],
    screenshots,
    artifact_paths: artifactPaths,
    manual_checkpoints: checkpoints,
    client_action_requests: clientActionRequests,
    next_required_action: blockingReason,
  };
}

function mapCategoryToResultStatus(category) {
  switch (category) {
    case 'success': return 'replay_run_completed';
    case 'blocked_human_approval': return 'replay_run_gated';
    case 'blocked_auth': return 'blocked_auth';
    case 'blocked_validation': return 'blocked_validation';
    default: return 'failed';
  }
}

// Domain-specific runtime variables Pancake hands to Browsy. Browsy only
// consumes these and the recorded steps; it does not resolve DistroKid fields.
function buildBrowsyRunVariables(packagePayload) {
  const canonical = packagePayload.canonical_payload || {};
  const releaseId = canonical.releaseId || canonical.release_id || packagePayload.entity_id;
  const idKey = packagePayload.entity_type === 'album' ? 'albumId' : 'songId';
  // Two DISTINCT fields (don't conflate them):
  //  - Artist/band + performer credit = the umbrella artist name ("Figment
  //    Factory" for any non-default brand, "Pancake Robot" for the default),
  //    resolved upstream as canonical.artist ([[project_distrokid_artist_rule]]).
  //  - Album title = the brand profile DISPLAY NAME (e.g. "Mac Miller"), or
  //    "Figment Factory" only when a release spans multiple brands — resolved
  //    upstream as canonical.releaseTitle.
  const brandDisplayName = canonical.artist || canonical.artistName || canonical.release_title || canonical.releaseTitle || '';
  const albumTitle = canonical.releaseTitle || canonical.release_title || brandDisplayName;
  // DistroKid's ai_gate radio value: "1" = all audio performed by AI, "2" = part
  // AI + humans, "0" = none. Per the Figment Factory spec every track always
  // answers Yes → "All of the audio", so the gate is forced to "1" (scope "full")
  // regardless of stored disclosure. The actual modal handling is owned by the
  // Browsy ai_disclosure executor / the captured DistroKid recording.
  const AI_GATE_ALL_AUDIO = '1';
  const splitName = (raw) => {
    const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
    return { first: parts[0] || '', last: parts.length > 1 ? parts.slice(1).join(' ') : '' };
  };
  const tracks = Array.isArray(canonical.tracks)
    ? canonical.tracks.map(track => {
        // Songwriter is always the human owner, never the brand display name
        // that DistroKid uses for the performer/artist credit.
        const sw = splitName(SONGWRITER_LEGAL_NAME);
        const disclosure = track.aiDisclosure || track.ai_disclosure || {};
        return pruneEmptyValues({
          songId: track.songId || track.song_id,
          title: track.title || track.trackTitle || track.track_title,
          trackNumber: track.trackNumber || track.track_number,
          audioPath: track.audioPath || track.audio_path,
          lyrics: track.lyrics,
          explicit: track.explicit,
          instrumental: track.instrumental,
          isAiGenerated: track.isAiGenerated || track.is_ai_generated,
          isrc: track.isrc,
          songwriterCredits: track.songwriterCredits || track.songwriter_credits,
          aiDisclosure: disclosure,
          // Derived per-track values the Browsy repeat-group loop fills directly
          // ([[browsy-repeat-groups]]). Kept flat so each iteration resolves
          // track.<field> without further parsing on the Browsy side.
          songwriterFirst: sw.first,
          songwriterLast: sw.last,
          performerName: brandDisplayName,
          performerRole: 'Performer',
          producerName: SONGWRITER_LEGAL_NAME,
          producerRole: 'Executive Producer',
          aiGate: AI_GATE_ALL_AUDIO,
          aiRecordingScope: 'full',
        });
      })
    : [];
  const artworkPath = canonical.artworkPath || canonical.artwork_path || null;
  const firstAudioPath = tracks.find(track => track.audioPath)?.audioPath || null;
  const songwriterFirst = tracks[0]?.songwriterFirst || '';
  const songwriterLast = tracks[0]?.songwriterLast || '';
  const appleMusicCredits = {
    performer: { name: brandDisplayName, role: 'Performer' },
    producer: { name: SONGWRITER_LEGAL_NAME, role: 'Executive Producer' },
  };
  const canonicalWithCredits = { ...canonical, apple_music_credits: appleMusicCredits };
  return pruneEmptyValues({
    appId: getBrowsyConfig().appId,
    releaseId,
    albumId: packagePayload.entity_type === 'album' ? releaseId : undefined,
    [idKey]: releaseId,
    mode: packagePayload.mode,
    distrokid_payload: canonicalWithCredits,
    inputs: pruneEmptyValues({
      howmanysongs: tracks.length,
      track_count: tracks.length,
      numberOfSongs: tracks.length,
      artwork: artworkPath,
      file: firstAudioPath,
      releaseDate: canonical.releaseDate || canonical.release_date,
      genre1: DISTROKID_FIGMENT_GENRE,
      label: DISTROKID_FIGMENT_LABEL,
      albumtitle: albumTitle,
      songwriterRealNameFirst1: songwriterFirst,
      songwriterRealNameLast1: songwriterLast,
      performerName: brandDisplayName,
      producerName: SONGWRITER_LEGAL_NAME,
    }),
    howmanysongs: tracks.length,
    track_count: tracks.length,
    numberOfSongs: tracks.length,
    files: pruneEmptyValues({
      artwork: artworkPath,
      cover_art: artworkPath,
      coverArt: artworkPath,
      file: firstAudioPath,
      audio: firstAudioPath,
      audio_file: firstAudioPath,
      track_1_audio: firstAudioPath,
    }),
    album: pruneEmptyValues({
      id: releaseId,
      releaseId,
      title: canonical.releaseTitle || canonical.release_title,
      artistName: canonical.artistName || canonical.artist,
      releaseDate: canonical.releaseDate || canonical.release_date,
      language: canonical.language || 'English',
      labelName: DISTROKID_FIGMENT_LABEL,
      primaryGenre: DISTROKID_FIGMENT_GENRE,
      secondaryGenre: canonical.secondaryGenre || canonical.secondary_genre,
      coverArtPath: canonical.artworkPath || canonical.artwork_path,
    }),
    release: pruneEmptyValues({
      title: canonical.release_title,
      artist: canonical.artist,
      label: DISTROKID_FIGMENT_LABEL,
      releaseDate: canonical.release_date,
      genre: DISTROKID_FIGMENT_GENRE,
      subgenre: canonical.secondary_genre,
    }),
    artworkPath,
    tracks,
    derived: { numberOfSongs: tracks.length },
    // The five mandatory DistroKid agreement checkboxes ("Important checkboxes")
    // are all checked by the automation before the human checkpoint. These map to
    // checkbox global fields in the Browsy field-map (agreements.*).
    agreements: {
      tandc: true,
      otherArtist: true,
      promoServices: true,
      recorded: true,
      youtube: true,
    },
    expected_human_gates: packagePayload.human_gate ? ['final_submit_approval'] : [],
    expected_outputs: packagePayload.capture_outputs || [],
  });
}

function buildBrowsyPackageAssets(canonical = {}) {
  const assets = [];
  const artworkPath = canonical.artworkPath || canonical.artwork_path || null;
  if (artworkPath) assets.push({ type: 'artwork', id: 'artwork', path: artworkPath });
  const firstTrack = Array.isArray(canonical.tracks) ? canonical.tracks[0] : null;
  const audioPath = firstTrack?.audioPath || firstTrack?.audio_path || null;
  if (audioPath) assets.push({ type: 'audio', id: 'file', track_number: firstTrack?.trackNumber || firstTrack?.track_number || 1, path: audioPath });
  return assets;
}

function pruneEmptyValues(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function findTaskForWorkflow(campaignId, workflowId) {
  return listReleaseCampaignTasks(campaignId).find(task => task.source_workflow_id === workflowId) || null;
}

function normalizeLinkKey(platform) {
  return String(platform || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function defaultCaptureOutputs(workflowId) {
  if (/distrokid/i.test(workflowId || '')) {
    return ['external_release_url', 'smart_link_url', 'submission_status', 'review_page_screenshot'];
  }
  if (/platform-link-harvest/i.test(workflowId || '')) {
    return ['spotify_url', 'apple_music_url', 'youtube_music_url'];
  }
  return ['artifact_paths'];
}

function normalizeTaskKey(value) {
  return String(value || 'needs_ken')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'needs_ken';
}

function computeDueDate(releaseDate, offsetDays) {
  if (!releaseDate) return null;
  const base = new Date(`${releaseDate}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + Number(offsetDays || 0));
  return base.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const aDate = new Date(`${a}T00:00:00Z`);
  const bDate = new Date(`${b}T00:00:00Z`);
  return Math.round((bDate.getTime() - aDate.getTime()) / (24 * 60 * 60 * 1000));
}
