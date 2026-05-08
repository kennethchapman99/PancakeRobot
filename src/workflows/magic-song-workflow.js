import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { createWorkflowRunId, runWorkflow, WorkflowError } from '../../packages/openclaw-core/index.js';
import { getSong } from '../shared/db.js';
import { loadBrandProfileById, resolveBrandProfilePath, DEFAULT_PROFILE_ID } from '../shared/brand-profile.js';
import {
  createWorkflowRunRecord,
  getWorkflowRunByIdempotencyKey,
  recordWorkflowEvent,
  updateWorkflowRunRecord,
} from '../shared/workflow-runs-db.js';
import { runMagicPipelineService } from '../services/magic-pipeline-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
const WORKFLOW_RUNS_DIR = join(ROOT_DIR, 'output/workflow-runs');

export const MAGIC_SONG_WORKFLOW_NAME = 'magic_song';

export const MAGIC_SONG_MODES = Object.freeze({
  DRAFT: 'draft',
  HUMAN_REVIEW: 'human_review',
  AUTONOMOUS: 'autonomous',
});

export function createSongId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SONG_${ts}_${rand}`;
}

export function normalizeMagicSongInput(input = {}) {
  const theme = String(input.theme || '').trim();
  if (!theme) throw new WorkflowError('Magic Song workflow requires a theme');

  const brandId = String(input.brandId || process.env.DEFAULT_BRAND_ID || DEFAULT_PROFILE_ID).trim();
  const mode = Object.values(MAGIC_SONG_MODES).includes(input.mode)
    ? input.mode
    : MAGIC_SONG_MODES.HUMAN_REVIEW;

  return {
    theme,
    brandId,
    requestedBy: String(input.requestedBy || 'unknown').trim(),
    source: input.source || 'api',
    mode,
    songId: input.songId || createSongId(),
    runId: input.runId || createWorkflowRunId('MAGIC'),
    idempotencyKey: input.idempotencyKey || null,
  };
}

export async function runMagicSongWorkflow(input, options = {}) {
  const normalizedInput = normalizeMagicSongInput(input);
  const existingRun = normalizedInput.idempotencyKey
    ? getWorkflowRunByIdempotencyKey(normalizedInput.idempotencyKey)
    : null;

  if (existingRun) {
    return {
      runId: existingRun.id,
      name: MAGIC_SONG_WORKFLOW_NAME,
      input: normalizedInput,
      status: existingRun.status,
      result: existingRun.result,
      error: existingRun.error,
      stepResults: { hydrate_result: existingRun.result },
      reusedExistingRun: true,
    };
  }

  const runPath = getWorkflowRunPath(normalizedInput.runId);
  fs.mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  createWorkflowRunRecord({
    runId: normalizedInput.runId,
    workflowName: MAGIC_SONG_WORKFLOW_NAME,
    status: 'created',
    source: normalizedInput.source,
    requestedBy: normalizedInput.requestedBy,
    theme: normalizedInput.theme,
    brandId: normalizedInput.brandId,
    mode: normalizedInput.mode,
    songId: normalizedInput.songId,
    idempotencyKey: normalizedInput.idempotencyKey,
  });

  return runWorkflow({
    name: MAGIC_SONG_WORKFLOW_NAME,
    input: normalizedInput,
    runId: normalizedInput.runId,
    onEvent: async event => {
      appendWorkflowEvent(runPath, event);
      recordWorkflowEvent(normalizedInput.runId, event);
      if (options.onEvent) await options.onEvent(event);
    },
    steps: [
      {
        id: 'load_brand_profile',
        label: 'Load brand profile',
        run: async ({ state }) => {
          const profile = loadBrandProfileById(state.input.brandId);
          const profilePath = resolveBrandProfilePath(state.input.brandId);
          state.context.brandProfilePath = profilePath;
          state.context.brandName = profile.brand_name || state.input.brandId;
          return {
            brandId: state.input.brandId,
            brandName: state.context.brandName,
            profilePath,
          };
        },
      },
      {
        id: 'run_magic_pipeline_service',
        label: 'Run Magic pipeline service',
        run: async ({ state, emit }) => {
          const serviceResult = await runMagicPipelineService({
            topic: state.input.theme,
            existingSongId: state.input.songId,
            mode: state.input.mode,
            onEvent: event => emit(event),
          });
          state.context.serviceResult = serviceResult;
          return serviceResult;
        },
      },
      {
        id: 'hydrate_result',
        label: 'Hydrate song result',
        run: async ({ state }) => {
          const song = getSong(state.input.songId);
          const serviceResult = state.context.serviceResult || {};
          const releaseRecommendation = song?.release_recommendation || {};
          const recommendation = serviceResult.recommendation || releaseRecommendation?.recommendation || {};
          const publicBaseUrl = String(process.env.PUBLIC_APP_BASE_URL || '').replace(/\/$/, '');

          const result = {
            runId: state.runId,
            songId: state.input.songId,
            title: serviceResult.title || song?.title || state.input.theme,
            status: serviceResult.status || mapRecommendationToStatus(recommendation.value),
            score: recommendation.score ?? releaseRecommendation.score ?? null,
            rationale: extractRationale(releaseRecommendation),
            previewUrl: publicBaseUrl ? `${publicBaseUrl}/songs/${state.input.songId}` : `/songs/${state.input.songId}`,
            releaseKitUrl: publicBaseUrl ? `${publicBaseUrl}/release-kit/${state.input.songId}?preview=1` : `/release-kit/${state.input.songId}?preview=1`,
            audioUrl: null,
            brandId: state.input.brandId,
            brandName: state.context.brandName,
            mode: state.input.mode,
            totalCost: serviceResult.totalCost ?? null,
            releaseCandidate: Boolean(serviceResult.releaseCandidate),
            marketingDashboardUrl: serviceResult.marketingDashboardUrl || null,
          };

          state.result = result;
          updateWorkflowRunRecord(state.runId, {
            status: 'completed',
            current_step: 'hydrate_result',
            song_id: state.input.songId,
            result,
          });
          writeWorkflowRunSnapshot(state.runId, {
            runId: state.runId,
            input: state.input,
            result,
            service: state.context.serviceResult,
            completedAt: new Date().toISOString(),
          });
          return result;
        },
      },
    ],
  });
}

function mapRecommendationToStatus(value) {
  if (value === 'recommend_to_publish') return 'recommended_to_publish';
  if (value === 'recommend_to_archive') return 'recommended_to_archive';
  return 'draft';
}

function extractRationale(releaseRecommendation) {
  const candidates = [
    releaseRecommendation?.rationale,
    releaseRecommendation?.recommendation?.rationale,
    releaseRecommendation?.summary,
    releaseRecommendation?.why,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(Boolean).map(String);
    if (typeof candidate === 'string' && candidate.trim()) return [candidate.trim()];
  }

  return [];
}

function getWorkflowRunPath(runId) {
  return join(WORKFLOW_RUNS_DIR, `${runId}.jsonl`);
}

function appendWorkflowEvent(filePath, event) {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
}

function writeWorkflowRunSnapshot(runId, snapshot) {
  fs.mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  fs.writeFileSync(join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify(snapshot, null, 2) + '\n');
}
