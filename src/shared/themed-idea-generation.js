/**
 * Themed idea generation preload.
 *
 * Intercepts the existing web suggest endpoints so the Generate Ideas UI can
 * send optional theme/vibe guidance without editing the large web server file.
 * Blank themePrompt preserves the existing unrelated-ideas behavior.
 */

import express from 'express';
import { runSuggestPipeline } from './suggest.js';

const THEMED_IDEAS_ROUTES_KEY = Symbol.for('pancakeRobot.themedIdeasRoutesRegistered');
const suggestJobs = new Map();

function registerThemedIdeaRoutes(app, originalGet, originalPost) {
  if (app[THEMED_IDEAS_ROUTES_KEY]) return;
  app[THEMED_IDEAS_ROUTES_KEY] = true;

  originalPost.call(app, '/api/suggest/run', (req, res) => {
    const jobId = `job_${Date.now().toString(36)}`;
    const themePrompt = typeof req.body?.themePrompt === 'string'
      ? req.body.themePrompt.trim()
      : '';

    suggestJobs.set(jobId, {
      status: 'running',
      logs: [],
      results: null,
      error: null,
      startedAt: Date.now(),
      themePrompt,
    });

    runSuggestPipeline((msg) => {
      const job = suggestJobs.get(jobId);
      if (job) job.logs.push(msg);
    }, { themePrompt }).then((results) => {
      const job = suggestJobs.get(jobId);
      if (job) {
        job.status = 'done';
        job.results = results;
      }
    }).catch((err) => {
      const job = suggestJobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = err.message;
      }
    });

    res.json({ ok: true, jobId });
  });

  originalGet.call(app, '/api/suggest/stream/:jobId', (req, res) => {
    const { jobId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let lastLogIndex = 0;
    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const tick = () => {
      const job = suggestJobs.get(jobId);
      if (!job) {
        send('error', { message: 'Job not found' });
        res.end();
        return;
      }

      const newLogs = job.logs.slice(lastLogIndex);
      for (const line of newLogs) send('log', { message: line });
      lastLogIndex = job.logs.length;

      if (job.status === 'done') {
        send('complete', { results: job.results });
        res.end();
      } else if (job.status === 'error') {
        send('error', { message: job.error });
        res.end();
      } else {
        setTimeout(tick, 500);
      }
    };

    req.on('close', () => {});
    tick();
  });

  originalGet.call(app, '/api/suggest/status/:jobId', (req, res) => {
    const job = suggestJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });
}

const previousGet = express.application.get;
const previousPost = express.application.post;
let registering = false;

express.application.get = function patchedGet(path, ...handlers) {
  if (!registering && typeof path === 'string') {
    registering = true;
    try { registerThemedIdeaRoutes(this, previousGet, previousPost); }
    finally { registering = false; }
  }
  return previousGet.call(this, path, ...handlers);
};

express.application.post = function patchedPost(path, ...handlers) {
  if (!registering && typeof path === 'string') {
    registering = true;
    try { registerThemedIdeaRoutes(this, previousGet, previousPost); }
    finally { registering = false; }
  }
  return previousPost.call(this, path, ...handlers);
};
