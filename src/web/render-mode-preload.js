/**
 * Web render-mode bridge.
 *
 * The existing web server owns the /api/songs/:id/generate route and spawns
 * src/orchestrator.js. This preload makes the UI paid/free selector authoritative
 * without rewriting the whole server file:
 *
 * 1. Wrap the generation route handler and capture req.body.renderMode.
 * 2. Patch child_process.spawn before server.js imports it.
 * 3. When the orchestrator is spawned for that request, inject the matching
 *    MiniMax env vars into the child process.
 *
 * Paid remains the default.
 */

import { createRequire, syncBuiltinESMExports } from 'module';
import childProcess from 'child_process';

const require = createRequire(import.meta.url);
const express = require('express');

const PAID_MODEL = 'music-2.6';
const FREE_MODEL = 'music-2.6-free';

let activeRenderMode = null;

function normalizeRenderMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'free' ? 'free' : 'paid';
}

function envForRenderMode(renderMode) {
  const mode = normalizeRenderMode(renderMode);
  return {
    PIPELINE_RENDER_MODE_SOURCE: 'web-ui',
    PIPELINE_RENDER_MODE: mode,
    MINIMAX_USE_FREE_MODEL: mode === 'free' ? 'true' : 'false',
    MINIMAX_MUSIC_MODEL: mode === 'free' ? FREE_MODEL : PAID_MODEL,
  };
}

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path === '/api/songs/:id/generate') {
    handlers = handlers.map((handler) => {
      if (typeof handler !== 'function') return handler;

      return function renderModeAwareGenerateRoute(req, res, next) {
        const previousMode = activeRenderMode;
        activeRenderMode = normalizeRenderMode(req.body?.renderMode || req.query?.renderMode || 'paid');

        try {
          return handler.call(this, req, res, next);
        } finally {
          // child_process.spawn is called synchronously inside the route handler.
          activeRenderMode = previousMode;
        }
      };
    });
  }

  return originalPost.call(this, path, ...handlers);
};

const originalSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args = [], options = {}) {
  const isNode = command === 'node' || String(command).endsWith('/node');
  const argList = Array.isArray(args) ? args : [];
  const isSongPipelineSpawn = isNode && argList.some(arg => String(arg).includes('orchestrator.js')) && argList.includes('--new');

  if (isSongPipelineSpawn) {
    const renderMode = normalizeRenderMode(
      activeRenderMode ||
      options.env?.PIPELINE_RENDER_MODE ||
      process.env.PIPELINE_RENDER_MODE ||
      'paid'
    );
    const renderEnv = envForRenderMode(renderMode);

    options = {
      ...options,
      env: {
        ...process.env,
        ...(options.env || {}),
        ...renderEnv,
      },
    };
  }

  return originalSpawn.call(this, command, args, options);
};

syncBuiltinESMExports();
