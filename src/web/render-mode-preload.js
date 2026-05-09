/**
 * Web render-mode + finance bridge.
 *
 * The existing web server owns the /api/songs/:id/generate route and spawns
 * src/orchestrator.js. This preload keeps that server stable while adding:
 *
 * 1. UI paid/free selector authority for MiniMax renders.
 * 2. Finance Manager API routes and a small song detail widget.
 * 3. Post-pipeline finance sync from existing run/token telemetry.
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
let financeRoutesRegistered = false;

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

const FINANCE_WIDGET_JS = String.raw`
(() => {
  const match = window.location.pathname.match(/^\/songs\/([^/]+)\/?$/);
  if (!match) return;
  const songId = decodeURIComponent(match[1]);
  const money = (n) => '$' + Number(n || 0).toFixed(4);
  const titleize = (s) => String(s || 'unknown').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  function render(summary) {
    if (document.querySelector('[data-finance-manager-card]')) return;
    const root = document.querySelector('main > div') || document.querySelector('main');
    if (!root) return;

    const steps = Object.entries(summary.by_pipeline_step || {}).sort((a, b) => (b[1].cost_usd || 0) - (a[1].cost_usd || 0));
    const max = Math.max(0.000001, ...steps.map(([, v]) => Number(v.cost_usd || 0)));
    const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];

    const card = document.createElement('section');
    card.setAttribute('data-finance-manager-card', 'true');
    card.className = 'bg-white border border-zinc-200 rounded-xl p-5 mb-6 shadow-sm';
    card.innerHTML = '<div class="flex items-start justify-between gap-4">'
      + '<div><div class="text-xs uppercase tracking-wide text-zinc-500 font-semibold">Finance Manager</div>'
      + '<div class="mt-1 text-3xl font-bold text-zinc-950">' + money(summary.total_cost_usd) + '</div>'
      + '<div class="mt-1 text-sm text-zinc-500">Total incurred cost across LLM/provider calls, retries, and generated assets.</div></div>'
      + '<button type="button" data-finance-open class="px-3 py-2 rounded-lg bg-zinc-900 text-white text-sm font-semibold hover:bg-zinc-700">View Cost Breakdown</button>'
      + '</div>'
      + '<div class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">'
      + '<div class="rounded-lg bg-zinc-50 p-3"><div class="text-zinc-500">Events</div><div class="font-semibold text-zinc-950">' + (summary.event_count || 0) + '</div></div>'
      + '<div class="rounded-lg bg-zinc-50 p-3"><div class="text-zinc-500">Final Asset Cost</div><div class="font-semibold text-zinc-950">' + money(summary.total_final_asset_cost_usd) + '</div></div>'
      + '<div class="rounded-lg bg-zinc-50 p-3"><div class="text-zinc-500">Retry/Waste/Unknown</div><div class="font-semibold text-zinc-950">' + money(summary.total_failed_retry_cost_usd) + '</div></div>'
      + '<div class="rounded-lg bg-zinc-50 p-3"><div class="text-zinc-500">Estimated</div><div class="font-semibold text-zinc-950">' + (summary.estimated_event_count || 0) + '</div></div>'
      + '</div>'
      + '<div class="mt-4 space-y-2">' + (steps.length ? steps.map(([step, value]) => {
          const width = Math.max(2, Math.round((Number(value.cost_usd || 0) / max) * 100));
          return '<div><div class="flex justify-between text-xs text-zinc-600 mb-1"><span>' + titleize(step) + '</span><span>' + money(value.cost_usd) + '</span></div><div class="h-2 rounded-full bg-zinc-100 overflow-hidden"><div class="h-full bg-zinc-900" style="width:' + width + '%"></div></div></div>';
        }).join('') : '<div class="text-sm text-zinc-500 rounded-lg bg-zinc-50 p-3">No finance events yet. This will populate after the next pipeline run or finance sync.</div>') + '</div>'
      + (warnings.length ? '<div class="mt-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 p-3 text-sm">' + warnings.map(w => '<div>• ' + w + '</div>').join('') + '</div>' : '');

    const header = root.querySelector('h1')?.closest('div') || null;
    if (header?.parentElement) header.parentElement.insertBefore(card, header.nextSibling);
    else root.prepend(card);

    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-50 hidden items-center justify-center bg-black/50 p-4';
    modal.setAttribute('data-finance-modal', 'true');
    const rows = (summary.events || []).map(e => '<tr class="border-t border-zinc-100">'
      + '<td class="py-2 pr-3">' + titleize(e.pipeline_step) + '</td>'
      + '<td class="py-2 pr-3">' + (e.agent_name || '—') + '</td>'
      + '<td class="py-2 pr-3">' + (e.provider || '—') + '<div class="text-zinc-400">' + (e.model || '') + '</div></td>'
      + '<td class="py-2 pr-3 text-right">' + (e.input_tokens || 0) + '</td>'
      + '<td class="py-2 pr-3 text-right">' + (e.output_tokens || 0) + '</td>'
      + '<td class="py-2 pr-3 text-right font-semibold">' + money(e.computed_cost_usd) + '</td>'
      + '<td class="py-2 pr-3">' + (e.status || '—') + '</td>'
      + '</tr>').join('');
    modal.innerHTML = '<div class="bg-white rounded-2xl shadow-xl max-w-6xl w-full max-h-[85vh] overflow-hidden">'
      + '<div class="flex items-center justify-between border-b border-zinc-200 px-5 py-4"><div><div class="text-lg font-bold">Cost Breakdown</div><div class="text-sm text-zinc-500">Total incurred: ' + money(summary.total_cost_usd) + '</div></div><button type="button" data-finance-close class="text-zinc-500 hover:text-zinc-900 text-2xl leading-none">×</button></div>'
      + '<div class="p-5 overflow-auto max-h-[70vh]"><table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase tracking-wide text-zinc-500"><th class="pb-2 pr-3">Step</th><th class="pb-2 pr-3">Agent</th><th class="pb-2 pr-3">Provider</th><th class="pb-2 pr-3 text-right">In</th><th class="pb-2 pr-3 text-right">Out</th><th class="pb-2 pr-3 text-right">Cost</th><th class="pb-2 pr-3">Status</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="7" class="py-6 text-zinc-500">No cost events yet.</td></tr>')
      + '</tbody></table></div></div>';
    document.body.appendChild(modal);

    card.querySelector('[data-finance-open]')?.addEventListener('click', () => { modal.classList.remove('hidden'); modal.classList.add('flex'); });
    modal.querySelector('[data-finance-close]')?.addEventListener('click', () => { modal.classList.add('hidden'); modal.classList.remove('flex'); });
    modal.addEventListener('click', (event) => { if (event.target === modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } });
  }

  fetch('/api/songs/' + encodeURIComponent(songId) + '/finance')
    .then(res => res.ok ? res.json() : null)
    .then(data => { if (data?.ok) render(data.finance || data); })
    .catch(() => {});
})();
`;

function registerFinanceRoutes(app) {
  if (financeRoutesRegistered) return;
  financeRoutesRegistered = true;

  app.use((req, res, next) => {
    const originalSend = res.send.bind(res);
    res.send = function financeWidgetAwareSend(body) {
      const isSongDetailPage = /^\/songs\/[^/]+\/?$/.test(req.path);
      if (isSongDetailPage && typeof body === 'string' && body.includes('</body>') && !body.includes('/finance-widget.js')) {
        body = body.replace('</body>', '<script defer src="/finance-widget.js"></script></body>');
      }
      return originalSend(body);
    };
    next();
  });

  app.get('/finance-widget.js', (_req, res) => {
    res.type('application/javascript').send(FINANCE_WIDGET_JS);
  });

  app.get('/api/songs/:id/finance', async (req, res) => {
    try {
      const finance = await import('../shared/finance-manager.js');
      finance.syncSongFinanceArtifacts(req.params.id);
      res.json({ ok: true, finance: finance.getSongFinanceSummary(req.params.id) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/songs/:id/finance/sync', async (req, res) => {
    try {
      const finance = await import('../shared/finance-manager.js');
      const artifactSync = finance.syncSongFinanceArtifacts(req.params.id);
      const sinceIso = req.body?.sinceIso || req.query?.sinceIso;
      const runSync = sinceIso ? await finance.syncSongFinanceFromRuns({ songId: req.params.id, sinceIso }) : { synced: 0, events: [] };
      res.json({ ok: true, artifactSync, runSync, finance: finance.getSongFinanceSummary(req.params.id) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/runs/:id/finance', async (req, res) => {
    try {
      const finance = await import('../shared/finance-manager.js');
      res.json({ ok: true, finance: finance.getRunFinanceSummary(req.params.id) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/finance/recent', async (req, res) => {
    try {
      const finance = await import('../shared/finance-manager.js');
      res.json({ ok: true, overview: finance.getRecentFinanceOverview({ limit: Number(req.query.limit) || 25 }) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/admin/finance', async (_req, res) => {
    try {
      const finance = await import('../shared/finance-manager.js');
      const overview = finance.getRecentFinanceOverview({ limit: 50 });
      const rows = overview.rows.map(row => '<tr><td><a href="/songs/' + encodeURIComponent(row.song_id) + '">' + row.song_id + '</a></td><td>$' + Number(row.total_cost_usd || 0).toFixed(4) + '</td><td>' + row.event_count + '</td><td>' + row.estimated_event_count + '</td></tr>').join('');
      res.send('<!doctype html><html><head><title>Finance Manager</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-zinc-50 text-zinc-950"><main class="max-w-6xl mx-auto p-8"><div class="flex items-end justify-between"><div><h1 class="text-3xl font-bold">Finance Manager</h1><p class="text-zinc-500 mt-1">Total tracked spend: $' + Number(overview.total_cost_usd || 0).toFixed(4) + '</p></div><a href="/songs" class="text-sm underline">Back to songs</a></div><section class="bg-white border border-zinc-200 rounded-xl mt-6 overflow-hidden"><table class="w-full text-sm"><thead class="bg-zinc-50 text-left"><tr><th class="p-3">Song</th><th class="p-3">Total Cost</th><th class="p-3">Events</th><th class="p-3">Estimated</th></tr></thead><tbody>' + (rows || '<tr><td colspan="4" class="p-6 text-zinc-500">No finance events found yet.</td></tr>') + '</tbody></table></section></main></body></html>');
    } catch (error) {
      res.status(500).send(error.message);
    }
  });
}

const originalGet = express.application.get;
express.application.get = function patchedGet(path, ...handlers) {
  if (typeof path === 'string' && handlers.length > 0) registerFinanceRoutes(this);
  return originalGet.call(this, path, ...handlers);
};

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  registerFinanceRoutes(this);

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
  const isSongPipelineSpawn = isNode
    && argList.some(arg => String(arg).includes('orchestrator.js'))
    && (argList.includes('--new') || argList.includes('--magic'));

  const idIndex = argList.indexOf('--id');
  const spawnedSongId = idIndex >= 0 ? String(argList[idIndex + 1] || '').trim() : '';
  const financeStartedAtIso = isSongPipelineSpawn ? new Date().toISOString() : null;

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

  const child = originalSpawn.call(this, command, args, options);

  if (isSongPipelineSpawn && spawnedSongId && child?.once) {
    child.once('close', () => {
      setTimeout(async () => {
        try {
          const finance = await import('../shared/finance-manager.js');
          await finance.syncSongFinanceFromRuns({ songId: spawnedSongId, sinceIso: financeStartedAtIso });
          finance.syncSongFinanceArtifacts(spawnedSongId);
        } catch (error) {
          console.warn(`[FINANCE] Could not sync finance ledger for ${spawnedSongId}: ${error.message}`);
        }
      }, 0);
    });
  }

  return child;
};

syncBuiltinESMExports();
