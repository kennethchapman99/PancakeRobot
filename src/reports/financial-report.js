/**
 * Financial Report Generator
 * Produces HTML report + PNG charts using Chart.js + canvas
 */

import { createCanvas } from 'canvas';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Title, Tooltip, Legend, ArcElement, Filler } from 'chart.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { formatCost, formatTokens } from '../shared/costs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Register Chart.js components
Chart.register(
  BarController, BarElement, CategoryScale, LinearScale,
  LineController, LineElement, PointElement,
  Title, Tooltip, Legend, ArcElement, Filler
);

const REPORTS_DIR = join(__dirname, '../../output/reports');
const CHARTS_DIR = join(REPORTS_DIR, 'charts');

/**
 * Generate a bar chart as a PNG Buffer
 */
function generateBarChart({ labels, data, title, color = 'rgba(99, 102, 241, 0.8)' }) {
  const width = 800;
  const height = 400;
  const canvas = createCanvas(width, height);

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: title,
        data,
        backgroundColor: color,
        borderColor: color.replace('0.8', '1'),
        borderWidth: 1,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
        legend: { display: false },
      },
      scales: {
        y: { beginAtZero: true },
      },
    },
  });

  const buffer = canvas.toBuffer('image/png');
  chart.destroy();
  return buffer;
}

/**
 * Generate a line chart as a PNG Buffer
 */
function generateLineChart({ labels, data, title }) {
  const width = 800;
  const height = 400;
  const canvas = createCanvas(width, height);

  // Compute cumulative
  let cumulative = 0;
  const cumulativeData = data.map(v => { cumulative += v; return +cumulative.toFixed(5); });

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Daily Spend',
          data,
          borderColor: 'rgba(99, 102, 241, 0.8)',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          tension: 0.3,
        },
        {
          label: 'Cumulative',
          data: cumulativeData,
          borderColor: 'rgba(245, 101, 101, 0.8)',
          backgroundColor: 'transparent',
          tension: 0.3,
          borderDash: [5, 5],
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: { display: true, text: title, font: { size: 16 } },
      },
      scales: {
        y: { beginAtZero: true },
      },
    },
  });

  const buffer = canvas.toBuffer('image/png');
  chart.destroy();
  return buffer;
}

/**
 * Generate full financial report (HTML + PNG charts)
 */
export async function generateFinancialReport({ costData, serviceData, songData }) {
  fs.mkdirSync(CHARTS_DIR, { recursive: true });

  const totals = costData?.totals || {};
  const byAgent = costData?.byAgent || [];
  const dailyCosts = costData?.dailyCosts || [];

  // Generate charts
  let agentChartB64 = '';
  let spendChartB64 = '';

  if (byAgent.length > 0) {
    try {
      const agentBuf = generateBarChart({
        labels: byAgent.map(a => a.agent_name),
        data: byAgent.map(a => +(a.cost || 0).toFixed(5)),
        title: 'Cost by Agent ($)',
        color: 'rgba(99, 102, 241, 0.8)',
      });
      fs.writeFileSync(join(CHARTS_DIR, 'cost-by-agent.png'), agentBuf);
      agentChartB64 = agentBuf.toString('base64');
    } catch (err) {
      console.log(`[REPORT] Chart generation warning: ${err.message}`);
    }
  }

  if (dailyCosts.length > 0) {
    try {
      const spendBuf = generateLineChart({
        labels: dailyCosts.map(d => d.date),
        data: dailyCosts.map(d => +(d.cost || 0).toFixed(5)),
        title: 'Daily & Cumulative Spend ($)',
      });
      fs.writeFileSync(join(CHARTS_DIR, 'spend-over-time.png'), spendBuf);
      spendChartB64 = spendBuf.toString('base64');
    } catch (err) {
      console.log(`[REPORT] Chart generation warning: ${err.message}`);
    }
  }

  // Build HTML
  const html = buildHtmlReport({
    totals,
    byAgent,
    dailyCosts,
    serviceData: serviceData || [],
    agentChartB64,
    spendChartB64,
  });

  const reportPath = join(REPORTS_DIR, 'financial-report.html');
  fs.writeFileSync(reportPath, html);

  return reportPath;
}

function buildHtmlReport({ totals, byAgent, dailyCosts, serviceData, agentChartB64, spendChartB64 }) {
  const totalCost = totals.total_cost || 0;
  const totalRuns = totals.total_runs || 0;
  const successfulRuns = totals.successful_runs || 0;
  const failedRuns = totals.failed_runs || 0;
  const totalInput = totals.total_input_tokens || 0;
  const totalOutput = totals.total_output_tokens || 0;

  const agentChartImg = agentChartB64
    ? `<img src="data:image/png;base64,${agentChartB64}" style="width:100%;max-width:800px">`
    : '<p class="muted">No data yet</p>';

  const spendChartImg = spendChartB64
    ? `<img src="data:image/png;base64,${spendChartB64}" style="width:100%;max-width:800px">`
    : '<p class="muted">No data yet</p>';

  const agentRows = byAgent.map(a => `
    <tr>
      <td>${a.agent_name}</td>
      <td>${a.runs}</td>
      <td>${formatTokens(a.input_tokens)}</td>
      <td>${formatTokens(a.output_tokens)}</td>
      <td class="cost">${formatCost(a.cost || 0)}</td>
    </tr>
  `).join('');

  const serviceRows = serviceData.slice(0, 20).map(s => `
    <tr>
      <td>${s.service_name}</td>
      <td>${s.free_tier || '—'}</td>
      <td>${s.cost_per_song_usd > 0 ? formatCost(s.cost_per_song_usd) : 'Free'}</td>
      <td>${s.api_available ? '✓' : '✗'}</td>
      <td>${s.recommended ? '<span class="badge">Recommended</span>' : ''}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Pancake Robot — Financial Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; }
    .container { max-width: 1100px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 2rem; color: #6366f1; margin-bottom: 0.5rem; }
    h2 { font-size: 1.3rem; margin: 2rem 0 1rem; color: #334155; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
    .generated { color: #94a3b8; font-size: 0.875rem; margin-bottom: 2rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card-label { font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    .card-value { font-size: 2rem; font-weight: 700; color: #6366f1; }
    .card-sub { font-size: 0.8rem; color: #94a3b8; margin-top: 0.25rem; }
    .chart-section { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #6366f1; color: white; padding: 0.75rem 1rem; text-align: left; font-size: 0.85rem; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #f1f5f9; font-size: 0.9rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f8fafc; }
    .cost { font-weight: 600; color: #6366f1; }
    .badge { background: #dcfce7; color: #166534; padding: 0.25rem 0.75rem; border-radius: 100px; font-size: 0.8rem; }
    .muted { color: #94a3b8; font-style: italic; }
    .empty-state { text-align: center; padding: 3rem; color: #94a3b8; }
  </style>
</head>
<body>
<div class="container">
  <h1>🥞 Pancake Robot — Financial Report</h1>
  <div class="generated">Generated: ${new Date().toLocaleString()}</div>

  <div class="cards">
    <div class="card">
      <div class="card-label">Total Spent</div>
      <div class="card-value">${formatCost(totalCost)}</div>
      <div class="card-sub">${successfulRuns} ok / ${failedRuns} failed runs</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Cost / Run</div>
      <div class="card-value">${totalRuns > 0 ? formatCost(totalCost / totalRuns) : '$0'}</div>
      <div class="card-sub">per agent invocation</div>
    </div>
    <div class="card">
      <div class="card-label">Input Tokens</div>
      <div class="card-value">${formatTokens(totalInput)}</div>
      <div class="card-sub">total consumed</div>
    </div>
    <div class="card">
      <div class="card-label">Output Tokens</div>
      <div class="card-value">${formatTokens(totalOutput)}</div>
      <div class="card-sub">total generated</div>
    </div>
  </div>

  <p class="muted" style="margin-bottom:1rem">All agents run on <strong>claude-sonnet-4-6</strong> ($3/MTok input · $15/MTok output)</p>
  <h2>Cost by Agent</h2>
  <div class="chart-section">${agentChartImg}</div>

  ${agentRows ? `
  <table>
    <thead><tr><th>Agent</th><th>Runs</th><th>Input Tokens</th><th>Output Tokens</th><th>Cost</th></tr></thead>
    <tbody>${agentRows}</tbody>
  </table>` : '<div class="empty-state">No runs yet</div>'}

  <h2>Spend Over Time</h2>
  <div class="chart-section">${spendChartImg}</div>

  <h2>Service Research</h2>
  ${serviceRows ? `
  <table>
    <thead><tr><th>Service</th><th>Free Tier</th><th>Cost / Song</th><th>API</th><th>Status</th></tr></thead>
    <tbody>${serviceRows}</tbody>
  </table>` : '<div class="empty-state">No service research yet. Run <code>node src/orchestrator.js --setup</code></div>'}

</div>
</body>
</html>`;
}
