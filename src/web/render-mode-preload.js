/**
 * Web render-mode preload
 *
 * Purpose: make the Generate Song UI's paid/free toggle actually affect the
 * child orchestrator process without rewriting the large web server file.
 *
 * It wraps the existing POST /api/songs/:id/generate route at registration time.
 * When the UI posts { renderMode: 'paid' | 'free' }, this preload sets the
 * MiniMax env vars before server.js spawns the child pipeline. spawn() copies
 * process.env synchronously, so the child receives the selected model.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const express = require('express');

const originalPost = express.application.post;
const GENERATE_ROUTE = '/api/songs/:id/generate';

function normalizeRenderMode(value) {
  return String(value || '').toLowerCase() === 'free' ? 'free' : 'paid';
}

function envForRenderMode(renderMode) {
  return renderMode === 'free'
    ? {
        MINIMAX_USE_FREE_MODEL: 'true',
        MINIMAX_MUSIC_MODEL: 'music-2.6-free',
        PANCAKE_RENDER_MODE: 'free',
      }
    : {
        MINIMAX_USE_FREE_MODEL: 'false',
        MINIMAX_MUSIC_MODEL: 'music-2.6',
        PANCAKE_RENDER_MODE: 'paid',
      };
}

express.application.post = function patchedPost(path, ...handlers) {
  if (path !== GENERATE_ROUTE) {
    return originalPost.call(this, path, ...handlers);
  }

  const wrappedHandlers = handlers.map((handler) => {
    if (typeof handler !== 'function') return handler;

    return function renderModeAwareGenerateHandler(req, res, next) {
      const renderMode = normalizeRenderMode(req.body?.renderMode || req.query?.renderMode);
      const selectedEnv = envForRenderMode(renderMode);

      const previousEnv = {
        MINIMAX_USE_FREE_MODEL: process.env.MINIMAX_USE_FREE_MODEL,
        MINIMAX_MUSIC_MODEL: process.env.MINIMAX_MUSIC_MODEL,
        PANCAKE_RENDER_MODE: process.env.PANCAKE_RENDER_MODE,
      };

      Object.assign(process.env, selectedEnv);

      const originalJson = res.json.bind(res);
      res.json = (payload) => originalJson({
        ...(payload || {}),
        renderMode,
        minimaxModel: selectedEnv.MINIMAX_MUSIC_MODEL,
      });

      console.log(`[WEB] Music render mode selected: ${renderMode} (${selectedEnv.MINIMAX_MUSIC_MODEL})`);

      try {
        return handler(req, res, next);
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };
  });

  return originalPost.call(this, path, ...wrappedHandlers);
};
