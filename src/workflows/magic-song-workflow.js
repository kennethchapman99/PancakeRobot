import { spawn } from 'child_process';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
const ORCHESTRATOR_PATH = join(ROOT_DIR, 'src/orchestrator.js');
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

  if (existingRun && ['running', 'completed'].includes(existingRun.status)) {
    return {
      runId: existingRun.id,
      name: MAGIC_SONG_WORKFLOW_NAME,
      input: normalizedInput,
      status: existingRun.status,
      result: existingRun.result,
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
        id: 'run_existing_magic_pipeline',
        label: 'Run existing Magic pipeline',
        run: async ({ state, emit }) => {
          const cliResult = await runMagicCli({
            songId: state.input.songId,
            theme: state.input.theme,
            brandProfilePath: state.context.brandProfilePath,
            onLine: line => emit(classifyCliLine(line)),
          });
          state.context.cliResult = cliResult;
          return cliResult;
        },
      },
      {
        id: 'hydrate_result',
        label: 'Hydrate song result',
        run: async ({ state }) => {
          const song = getSong(state.input.songId);
          const releaseRecommendation = song?.release_recommendation || {};
          const recommendation = releaseRecommendation?.recommendation || {};
          const publicBaseUrl = String(process.env.PUBLIC_APP_BASE_URL || '').replace(/\/$/, '');

          const result = {
            runId: state.runId,
            songId: state.input.songId,
            title: song?.title || state.input.theme,
            status: mapRecommendationToStatus(recommendation.value),
            score: recommendation.score ?? releaseRecommendation.score ?? null,
            rationale: extractRationale(releaseRecommendation),
            previewUrl: publicBaseUrl ? `${publicBaseUrl}/songs/${state.input.songId}` : `/songs/${state.input.songId}`,
            releaseKitUrl: publicBaseUrl ? `${publicBaseUrl}/release-kit/${state.input.songId}?preview=1` : `/release-kit/${state.input.songId}?preview=1`,
            audioUrl: null,
            brandId: state.input.brandId,
            brandName: state.context.brandName,
            mode: state.input.mode,
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
            cli: state.context.cliResult,
            completedAt: new Date().toISOString(),
          });
          return result;
        },
      },
    ],
  });
}

function runMagicCli({ songId, theme, brandProfilePath, onLine }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const args = [ORCHESTRATOR_PATH, '--magic', theme, '--id', songId];
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        BRAND_PROFILE_PATH: brandProfilePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout.push(text);
      for (const line of splitLines(text)) onLine?.(line);
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr.push(text);
      for (const line of splitLines(text)) onLine?.(line);
    });

    child.on('error', error => {
      reject(new WorkflowError('Failed to start Magic pipeline process', { message: error.message }));
    });

    child.on('close', code => {
      const runtimeSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
      const result = {
        code,
        songId,
        runtimeSeconds,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
      };

      if (code === 0) {
        resolve(result);
      } else {
        reject(new WorkflowError(`Magic pipeline failed with exit code ${code}`, {
          songId,
          runtimeSeconds,
          stderrTail: result.stderr.slice(-2000),
          stdoutTail: result.stdout.slice(-2000),
        }));
      }
    });
  });
}

function classifyCliLine(line) {
  const clean = String(line || '').trim();
  if (!clean) return { type: 'pipeline_log', line: clean };

  const lower = clean.toLowerCase();
  if (lower.includes('writing lyrics')) return { type: 'pipeline_progress', stage: 'writing_song_brief', line: clean };
  if (lower.includes('generating music')) return { type: 'pipeline_progress', stage: 'generating_audio', line: clean };
  if (lower.includes('release selection')) return { type: 'pipeline_progress', stage: 'scoring_song', line: clean };
  if (lower.includes('marketing assets')) return { type: 'pipeline_progress', stage: 'creating_release_assets', line: clean };
  if (lower.includes('magic pipeline ready')) return { type: 'pipeline_progress', stage: 'done', line: clean };
  if (lower.includes('qa warning') || lower.includes('⚠')) return { type: 'pipeline_warning', line: clean };
  return { type: 'pipeline_log', line: clean };
}

function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
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
