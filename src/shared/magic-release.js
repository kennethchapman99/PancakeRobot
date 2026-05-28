import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
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
import { runReleaseBrowsyPipeline } from './browsy-release-pipeline.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW_ROOT = path.join(REPO_ROOT, 'output', 'release-workflows');

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
  { key: 'distrokid_submit_dry_run', title: 'Launch Browsy DistroKid submit dry-run', offsetDays: -28, owner: 'browsy', blocking: true, workflowId: release => release.type === 'album' ? 'distrokid-album-submit' : 'distrokid-single-submit' },
  { key: 'distrokid_final_submit_approval', title: 'Ken approval gate for DistroKid final submit', offsetDays: -27, owner: 'ken', blocking: true, dependsOn: ['distrokid_submit_dry_run'] },
  { key: 'hyperfollow_capture', title: 'Capture HyperFollow URL', offsetDays: -26, owner: 'browsy', blocking: true, workflowId: 'distrokid-hyperfollow-capture', dependsOn: ['distrokid_final_submit_approval'] },
  { key: 'hyperfollow_enrich', title: 'Enrich HyperFollow page', offsetDays: -25, owner: 'browsy', blocking: false, workflowId: 'distrokid-hyperfollow-enrich', dependsOn: ['hyperfollow_capture'] },
  { key: 'select_visual_assets', title: 'Select reusable visual assets', offsetDays: -24, owner: 'agent', blocking: true },
  { key: 'decide_custom_video', title: 'Decide whether any album singles need custom video', offsetDays: -23, owner: 'ken', blocking: false, dependsOn: ['select_visual_assets'] },
  { key: 'youtube_teaser_schedule', title: 'Create/schedule YouTube teaser', offsetDays: -21, owner: 'ken', blocking: false, workflowId: 'youtube-upload-schedule', dependsOn: ['select_visual_assets'] },
  { key: 'short_form_schedule', title: 'Create/schedule short-form posts', offsetDays: -18, owner: 'ken', blocking: false, workflowId: 'meta-instagram-facebook-schedule', dependsOn: ['select_visual_assets'] },
  { key: 'outreach_wave_1', title: 'Outreach wave 1', offsetDays: -14, owner: 'agent', blocking: false, dependsOn: ['hyperfollow_capture'] },
  { key: 'pre_save_push', title: 'Pre-save push', offsetDays: -10, owner: 'agent', blocking: false, dependsOn: ['hyperfollow_capture', 'select_visual_assets'] },
  { key: 'final_pre_release_checklist', title: 'Final pre-release checklist', offsetDays: -7, owner: 'ken', blocking: true },
  { key: 'release_week_posts_approved', title: 'Release-week posts approved', offsetDays: -3, owner: 'ken', blocking: false },
  { key: 'harvest_platform_links', title: 'Harvest platform links', offsetDays: 0, owner: 'browsy', blocking: true, workflowId: 'platform-link-harvest', dependsOn: ['distrokid_final_submit_approval'] },
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
  addReleaseCockpitLog(release.type, release.id, 'magic_release_create', 'success', 'Magic Release campaign created.', { campaignId: campaign.id });
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
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const campaign = campaignId
    ? upsertReleaseCampaign({ id: campaignId })
    : ensureCampaignForRelease(result.entity_type, result.entity_id);
  const task = taskKey
    ? getReleaseCampaignTaskByKey(campaign.id, taskKey)
    : findTaskForWorkflow(campaign.id, result.workflow_id);
  if (!task) throw new Error(`No campaign task found for Browsy workflow ${result.workflow_id}`);
  const nextStatus = mapBrowsyStatus(result.status);
  const updatedTask = upsertReleaseCampaignTask({
    id: task.id,
    campaign_id: campaign.id,
    task_key: task.task_key,
    status: nextStatus.status,
    result: result,
    result_path: resultPath,
    source_workflow_id: result.workflow_id,
    source_run_id: result.run_id || null,
    reason: nextStatus.reason || task.reason,
    suggested_action: nextStatus.suggestedAction || task.suggested_action,
    completed_at: nextStatus.status === 'complete' ? new Date().toISOString() : null,
  });
  if (result.captured_outputs) applyCapturedOutputs(campaign, result.captured_outputs, result);
  for (const request of result.client_action_requests || []) {
    createNeedsKenTaskFromActionRequest(campaign, task, request, resultPath, result);
  }
  addReleaseCockpitLog(campaign.release_type, campaign.release_id, 'magic_release_ingest', nextStatus.logStatus, `Browsy result ingested for ${result.workflow_id}.`, {
    taskKey: task.task_key,
    resultPath,
    workflowStatus: result.status,
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
  addReleaseCockpitLog(campaign.release_type, campaign.release_id, 'magic_release_task', status === 'complete' ? 'success' : 'warning', `${task.title} ${status}.`, { taskKey: task.task_key, dryRun });
  recomputeTaskStatuses(campaign.id);
  return { ok: true, task: updatedTask, payload };
}

function browsyHttpTransportEnabled() {
  return ['http', 'api', 'rest'].includes(
    String(process.env.BROWSY_TRANSPORT || process.env.PANCAKE_BROWSY_TRANSPORT || '').trim().toLowerCase(),
  );
}

async function runBrowsyTask({ campaign, task, release, dryRun }) {
  if (browsyHttpTransportEnabled()) {
    return runBrowsyTaskViaHttp({ campaign, task, release, dryRun });
  }
  upsertReleaseCampaignTask({ id: task.id, campaign_id: campaign.id, task_key: task.task_key, status: 'running' });
  const packageResult = writeBrowsyWorkflowPackage({ campaign, task, release, dryRun });
  const run = addReleaseCampaignRun({
    campaign_id: campaign.id,
    task_id: task.id,
    workflow_id: task.source_workflow_id,
    status: 'running',
    package_path: packageResult.packagePath,
    log: { mode: dryRun ? 'dry_run' : 'live' },
  });
  const execution = await runBrowsyWorkflow({
    workflowId: task.source_workflow_id,
    packagePath: packageResult.packagePath,
    mode: dryRun ? 'dry_run' : 'live',
  });
  updateReleaseCampaignRun(run.id, {
    run_id: execution.result?.run_id || execution.runId || null,
    status: execution.ok ? 'complete' : 'failed',
    result_path: execution.resultPath,
    stdout_path: execution.stdoutPath,
    stderr_path: execution.stderrPath,
    log: execution,
  });
  if (execution.resultPath && fs.existsSync(execution.resultPath)) {
    return ingestBrowsyResult({ resultPath: execution.resultPath, campaignId: campaign.id, taskKey: task.task_key });
  }
  const status = execution.ok ? 'complete' : 'failed';
  const updatedTask = upsertReleaseCampaignTask({
    id: task.id,
    campaign_id: campaign.id,
    task_key: task.task_key,
    status,
    result: execution,
    result_path: execution.resultPath || null,
    completed_at: status === 'complete' ? new Date().toISOString() : null,
  });
  recomputeTaskStatuses(campaign.id);
  return { ok: execution.ok, task: updatedTask, execution };
}

/**
 * HTTP transport for Browsy tasks: drives the async contract pipeline
 * (dry_run -> preview -> optional live) and reuses ingestBrowsyResult() for
 * persistence by translating the contract result into the legacy
 * automation-result-v1 shape the rest of the cockpit already understands.
 */
async function runBrowsyTaskViaHttp({ campaign, task, release, dryRun }) {
  upsertReleaseCampaignTask({ id: task.id, campaign_id: campaign.id, task_key: task.task_key, status: 'running' });
  const workflowDir = path.join(WORKFLOW_ROOT, campaign.id, task.task_key);
  fs.mkdirSync(workflowDir, { recursive: true });
  const stages = dryRun ? ['dry_run', 'preview'] : ['dry_run', 'preview', 'live'];
  const run = addReleaseCampaignRun({
    campaign_id: campaign.id,
    task_id: task.id,
    workflow_id: task.source_workflow_id,
    status: 'running',
    log: { mode: dryRun ? 'dry_run' : 'live', transport: 'http', stages },
  });

  let pipeline;
  try {
    pipeline = await runReleaseBrowsyPipeline({
      releaseType: release.type,
      releaseId: release.id,
      workflowId: task.source_workflow_id,
      stages,
      approvalToken: process.env.BROWSY_APPROVAL_TOKEN || '',
      approvedBy: process.env.BROWSY_APPROVED_BY || 'pancake-robot',
      autoApproveSubmit: false, // human approval gate stays with Ken
      // ingestBrowsyResult handles persistence below — avoid double-writing.
      persist: false,
    });
  } catch (error) {
    updateReleaseCampaignRun(run.id, { status: 'failed', log: { error: error.message } });
    const failedTask = upsertReleaseCampaignTask({
      id: task.id,
      campaign_id: campaign.id,
      task_key: task.task_key,
      status: 'failed',
      reason: error.message,
    });
    addReleaseCockpitLog({
      releaseType: campaign.release_type,
      releaseId: campaign.release_id,
      action: 'magic_release_browsy_http',
      status: 'error',
      message: `Browsy HTTP run failed for ${task.source_workflow_id}: ${error.message}`,
      payload: { taskKey: task.task_key },
    });
    recomputeTaskStatuses(campaign.id);
    return { ok: false, task: failedTask, error: error.message };
  }

  const legacyResult = browsyPipelineToLegacyResult({ pipeline, release });
  const resultPath = path.join(workflowDir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify(legacyResult, null, 2));
  updateReleaseCampaignRun(run.id, {
    run_id: legacyResult.run_id,
    status: legacyResult.status === 'failed' || legacyResult.status === 'blocked'
      ? 'failed'
      : (pipeline.needsHuman ? 'needs_ken' : 'complete'),
    result_path: resultPath,
    log: pipeline,
  });
  return ingestBrowsyResult({ resultPath, campaignId: campaign.id, taskKey: task.task_key });
}

function browsyPipelineToLegacyResult({ pipeline, release }) {
  const stages = pipeline.stages || [];
  const lastStage = stages[stages.length - 1] || {};
  const liveStage = stages.find(stage => stage.mode === 'live');
  const result = lastStage.result || {};

  const capturedOutputs = {};
  for (const [id, output] of Object.entries(result.outputs || {})) {
    if (output && output.status === 'captured' && output.value !== undefined && output.value !== null) {
      capturedOutputs[id] = output.value;
    }
  }

  let status;
  if (pipeline.needsHuman) status = 'live_run_gated';
  else if (lastStage.status === 'failed') status = 'failed';
  else if (lastStage.status === 'blocked' || lastStage.status === 'canceled') status = 'blocked';
  else if (liveStage && liveStage.status === 'completed') status = 'live_run_completed';
  else status = 'dry_run_passed';

  const screenshots = [];
  const artifactPaths = [];
  for (const stage of stages) {
    for (const item of (stage.result?.artifacts?.screenshots) || []) {
      if (item?.path) screenshots.push(item.path);
    }
    for (const group of Object.values(stage.result?.artifacts || {})) {
      for (const item of group || []) {
        if (item?.path && !artifactPaths.includes(item.path)) artifactPaths.push(item.path);
      }
    }
  }

  const clientActionRequests = pipeline.needsHuman
    ? [{
        type: 'human_decision_required',
        severity: 'blocking',
        reason: result.blockingReason || `Browsy paused at status "${lastStage.status}" and needs a human.`,
        suggested_action: `Resolve "${lastStage.status}" in Browsy, then approve to resume.`,
      }]
    : [];

  return {
    ok: status !== 'failed',
    workflow_id: pipeline.workflowId,
    run_id: liveStage?.runId || lastStage.runId || null,
    source_system: 'pancake_robot',
    entity_type: release.type,
    entity_id: release.id,
    status,
    captured_outputs: capturedOutputs,
    filled_fields: result.completedSteps || [],
    skipped_fields: result.skippedSteps || [],
    errors: result.failedSteps || [],
    screenshots,
    artifact_paths: artifactPaths,
    manual_checkpoints: (result.checkpoints || []).map(checkpoint => checkpoint?.title || checkpoint?.id || 'checkpoint'),
    client_action_requests: clientActionRequests,
    next_required_action: pipeline.needsHuman ? `Resolve "${lastStage.status}" in Browsy` : null,
    contract_version: pipeline.contractVersion || null,
  };
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
    case 'live_run_gated':
      return { status: 'needs_ken', logStatus: 'warning', reason: 'Browsy returned a live human gate.' };
    case 'live_run_completed':
      return { status: 'complete', logStatus: 'success' };
    case 'blocked':
      return { status: 'needs_ken', logStatus: 'warning', reason: 'Browsy returned a blocking result.' };
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
  for (const [key, value] of Object.entries(outputs)) {
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
    mode: dryRun ? 'dry_run' : 'live',
    human_gate: true,
    manifest_path: path.relative(REPO_ROOT, manifestPath),
    canonical_payload: canonicalPayload,
    assets: [],
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

async function runBrowsyWorkflow({ workflowId, packagePath, mode }) {
  const browsyBin = process.env.PANCAKE_BROWSY_BIN || '';
  const browsyRepoPath = process.env.PANCAKE_BROWSY_REPO_PATH || '';
  if (!browsyBin && !browsyRepoPath) {
    const resultPath = path.join(path.dirname(packagePath), 'result.json');
    fs.writeFileSync(resultPath, JSON.stringify({
      ok: true,
      workflow_id: workflowId,
      run_id: `stub_${Date.now().toString(36)}`,
      source_system: 'pancake_robot',
      entity_type: JSON.parse(fs.readFileSync(packagePath, 'utf8')).entity_type,
      entity_id: JSON.parse(fs.readFileSync(packagePath, 'utf8')).entity_id,
      status: mode === 'dry_run' ? 'dry_run_passed' : 'live_run_gated',
      captured_outputs: {},
      filled_fields: [],
      skipped_fields: [],
      errors: [],
      screenshots: [],
      artifact_paths: [],
      manual_checkpoints: mode === 'live' ? ['Human approval required'] : [],
      client_action_requests: mode === 'live' ? [{
        type: 'human_decision_required',
        severity: 'blocking',
        reason: 'Live workflow requires human approval before external action.',
        suggested_action: 'Approve live workflow',
      }] : [],
      next_required_action: mode === 'live' ? 'Approve live workflow' : null,
    }, null, 2));
    return { ok: true, stubbed: true, resultPath, result: JSON.parse(fs.readFileSync(resultPath, 'utf8')) };
  }
  const stdoutPath = path.join(path.dirname(packagePath), 'stdout.log');
  const stderrPath = path.join(path.dirname(packagePath), 'stderr.log');
  const resultPath = path.join(path.dirname(packagePath), 'result.json');
  const executable = browsyBin || path.join(browsyRepoPath, 'bin', 'browsy');
  const args = [
    'workflow:run',
    '--workflow', workflowId,
    '--package', packagePath,
    '--mode', mode,
    '--result-path', resultPath,
  ];
  const output = await execFileAsync(executable, args, {
    cwd: browsyRepoPath || REPO_ROOT,
    timeout: Number(process.env.PANCAKE_BROWSY_TIMEOUT_MS || 20 * 60 * 1000),
    maxBuffer: 1024 * 1024 * 4,
  });
  fs.writeFileSync(stdoutPath, output.stdout || '');
  fs.writeFileSync(stderrPath, output.stderr || '');
  return {
    ok: true,
    stdoutPath,
    stderrPath,
    resultPath,
    result: fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null,
  };
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
