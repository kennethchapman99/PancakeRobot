/**
 * Web generation bridge.
 *
 * The existing web server owns the /api/songs/:id/generate route and spawns
 * src/orchestrator.js. This preload keeps the UI controls authoritative without
 * rewriting the whole server file:
 *
 * 1. Wrap the generation route handler and capture req.body.renderMode.
 * 2. Read the selected song record and build a content-level generation request.
 * 3. Patch child_process.spawn before server.js imports it.
 * 4. When the orchestrator is spawned for that request, inject render mode env
 *    and replace the --new topic arg with the locked-title content request.
 *
 * Paid remains the default. Brand rules still come from the active brand profile.
 */

import { createRequire, syncBuiltinESMExports } from 'module';
import childProcess from 'child_process';
import { getSong } from '../shared/db.js';
import { buildLockedSongGenerationRequest } from '../shared/song-generation-request.js';

const require = createRequire(import.meta.url);
const express = require('express');

const PAID_MODEL = 'music-2.6';
const FREE_MODEL = 'music-2.6-free';

let activeRenderMode = null;
let activeGenerationRequest = null;

function normalizeRenderMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'free' ? 'free' : 'paid';
}

function envForRenderMode(renderMode) {
  const mode = normalizeRenderMode(renderMode);
  return {
    PANCAKE_RENDER_MODE_SOURCE: 'web-ui',
    PANCAKE_RENDER_MODE: mode,
    MINIMAX_USE_FREE_MODEL: mode === 'free' ? 'true' : 'false',
    MINIMAX_MUSIC_MODEL: mode === 'free' ? FREE_MODEL : PAID_MODEL,
  };
}

function buildGenerationEnv(request) {
  if (!request?.lockedTitle) return {};
  return {
    PANCAKE_SOURCE_SONG_ID: request.sourceSongId || '',
    PANCAKE_LOCKED_TITLE: request.lockedTitle,
  };
}

function replaceNewTopicArg(args, request) {
  if (!request?.topic) return args;
  const nextArgs = [...args];
  const newIndex = nextArgs.findIndex(arg => String(arg) === '--new');
  if (newIndex >= 0 && newIndex + 1 < nextArgs.length) {
    nextArgs[newIndex + 1] = request.topic;
  }
  return nextArgs;
}

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path === '/api/songs/:id/generate') {
    handlers = handlers.map((handler) => {
      if (typeof handler !== 'function') return handler;

      return function generationAwareRoute(req, res, next) {
        const previousMode = activeRenderMode;
        const previousRequest = activeGenerationRequest;
        activeRenderMode = normalizeRenderMode(req.body?.renderMode || req.query?.renderMode || 'paid');

        try {
          const song = getSong(req.params?.id);
          activeGenerationRequest = song ? buildLockedSongGenerationRequest(song) : null;
          return handler.call(this, req, res, next);
        } finally {
          // child_process.spawn is called synchronously inside the route handler.
          activeRenderMode = previousMode;
          activeGenerationRequest = previousRequest;
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
    const renderMode = normalizeRenderMode(activeRenderMode || options.env?.PANCAKE_RENDER_MODE || process.env.PANCAKE_RENDER_MODE || 'paid');
    const renderEnv = envForRenderMode(renderMode);
    const requestEnv = buildGenerationEnv(activeGenerationRequest);

    args = replaceNewTopicArg(argList, activeGenerationRequest);
    options = {
      ...options,
      env: {
        ...process.env,
        ...(options.env || {}),
        ...renderEnv,
        ...requestEnv,
      },
    };
  }

  return originalSpawn.call(this, command, args, options);
};

syncBuiltinESMExports();
