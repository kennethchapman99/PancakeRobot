import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import express from 'express';
import { getWorkflowRunEvents, getWorkflowRunRecord, listWorkflowRuns } from '../shared/workflow-runs-db.js';

const app = express();
const PORT = process.env.WORKFLOW_ADMIN_PORT || 3747;
const PUBLIC_APP_BASE_URL = String(process.env.PUBLIC_APP_BASE_URL || 'http://localhost:3737').replace(/\/$/, '');

app.get('/', (_req, res) => res.redirect('/workflow-runs'));

app.get('/workflow-runs', (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim() : null;
  const runs = listWorkflowRuns({ limit: 100, status });
  res.type('html').send(renderPage('Workflow Runs', `
    <div class="header">
      <h1>Workflow Runs</h1>
      <div class="filters">
        <a href="/workflow-runs">All</a>
        <a href="/workflow-runs?status=running">Running</a>
        <a href="/workflow-runs?status=completed">Completed</a>
        <a href="/workflow-runs?status=failed">Failed</a>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Status</th>
          <th>Step</th>
          <th>Song</th>
          <th>Theme</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        ${runs.map(run => `
          <tr>
            <td><a href="/workflow-runs/${encodeURIComponent(run.id)}">${escapeHtml(run.id)}</a></td>
            <td><span class="pill ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
            <td>${escapeHtml(run.current_step || '—')}</td>
            <td>${run.song_id ? `<a href="${PUBLIC_APP_BASE_URL}/songs/${encodeURIComponent(run.song_id)}">${escapeHtml(run.song_id)}</a>` : '—'}</td>
            <td>${escapeHtml(run.theme || '—')}</td>
            <td>${escapeHtml(run.created_at || '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `));
});

app.get('/workflow-runs/:runId', (req, res) => {
  const run = getWorkflowRunRecord(req.params.runId);
  if (!run) return res.status(404).type('html').send(renderPage('Workflow Run Not Found', `<h1>Run not found</h1><p>${escapeHtml(req.params.runId)}</p>`));
  const events = getWorkflowRunEvents(req.params.runId);
  res.type('html').send(renderPage(run.id, `
    <div class="header">
      <h1>${escapeHtml(run.id)}</h1>
      <a href="/workflow-runs">Back to runs</a>
    </div>

    <section class="card">
      <h2>Summary</h2>
      <dl>
        ${summaryRow('Status', `<span class="pill ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>`)}
        ${summaryRow('Workflow', escapeHtml(run.workflow_name || '—'))}
        ${summaryRow('Source', escapeHtml(run.source || '—'))}
        ${summaryRow('Requested by', escapeHtml(run.requested_by || '—'))}
        ${summaryRow('Theme', escapeHtml(run.theme || '—'))}
        ${summaryRow('Brand', escapeHtml(run.brand_id || '—'))}
        ${summaryRow('Mode', escapeHtml(run.mode || '—'))}
        ${summaryRow('Current step', escapeHtml(run.current_step || '—'))}
        ${summaryRow('Song', run.song_id ? `<a href="${PUBLIC_APP_BASE_URL}/songs/${encodeURIComponent(run.song_id)}">${escapeHtml(run.song_id)}</a>` : '—')}
        ${summaryRow('Release kit', run.song_id ? `<a href="${PUBLIC_APP_BASE_URL}/release-kit/${encodeURIComponent(run.song_id)}?preview=1">open release kit</a>` : '—')}
        ${summaryRow('Created', escapeHtml(run.created_at || '—'))}
        ${summaryRow('Updated', escapeHtml(run.updated_at || '—'))}
      </dl>
    </section>

    ${run.error && Object.keys(run.error).length ? `
      <section class="card error">
        <h2>Error</h2>
        <pre>${escapeHtml(JSON.stringify(run.error, null, 2))}</pre>
      </section>
    ` : ''}

    ${run.result && Object.keys(run.result).length ? `
      <section class="card">
        <h2>Result</h2>
        <pre>${escapeHtml(JSON.stringify(run.result, null, 2))}</pre>
      </section>
    ` : ''}

    <section class="card">
      <h2>Events</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Step / Stage</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          ${events.map(event => `
            <tr>
              <td>${escapeHtml(event.timestamp || '—')}</td>
              <td>${escapeHtml(event.event_type || '—')}</td>
              <td>${escapeHtml(event.step_id || event.stage || '—')}</td>
              <td>${escapeHtml(event.message || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `));
});

app.listen(PORT, () => {
  console.log(`Workflow run debug server: http://localhost:${PORT}/workflow-runs`);
});

function renderPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Workflow Debug</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #fafafa; color: #18181b; }
    main { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 28px; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e4e4e7; border-radius: 12px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e4e4e7; text-align: left; vertical-align: top; font-size: 14px; }
    th { background: #f4f4f5; color: #52525b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    tr:last-child td { border-bottom: 0; }
    .card { background: white; border: 1px solid #e4e4e7; border-radius: 12px; padding: 18px; margin-bottom: 18px; }
    .card.error { border-color: #fecaca; background: #fff7f7; }
    dl { display: grid; grid-template-columns: 160px 1fr; gap: 8px 16px; margin: 0; }
    dt { color: #71717a; }
    dd { margin: 0; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; background: #18181b; color: #fafafa; padding: 14px; border-radius: 10px; font-size: 13px; }
    .filters { display: flex; gap: 10px; }
    .pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #f4f4f5; color: #52525b; }
    .pill.completed { background: #dcfce7; color: #166534; }
    .pill.running { background: #dbeafe; color: #1d4ed8; }
    .pill.failed { background: #fee2e2; color: #991b1b; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function summaryRow(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
