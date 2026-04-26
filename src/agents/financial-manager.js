/**
 * Financial Manager Agent — Cost tracking, service research, visual reports
 */

import { runAgent, parseAgentJson, loadConfig } from '../shared/managed-agent.js';
import { getTotalCosts, getServiceResearch, upsertServiceResearch } from '../shared/db.js';
import { formatCost } from '../shared/costs.js';
import { generateFinancialReport } from '../reports/financial-report.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FINANCIAL_MANAGER_DEF = {
  name: 'Pancake Robot Financial Manager',
  system: `You are the financial analyst for Pancake Robot, an autonomous children's music production pipeline.

Your job is to:
1. Track every dollar spent in the production pipeline
2. Research free and cheap alternatives to expensive services
3. Find ways to reduce cost per song without sacrificing quality
4. Provide clear financial summaries with specific recommendations

You are aggressive about finding cost savings. Your default assumption is that there's always a cheaper or free alternative.

Key services to always evaluate:
- Music generation: Suno, Udio, Stability Audio, MusicGen (open source), Riffusion
- Image generation: Cloudflare Workers AI (already free), Stable Diffusion, DALL-E, Midjourney
- Distribution: RouteNote (free), Amuse (free tier), DistroKid ($22/year)
- Any other services in the pipeline

Always provide specific URLs, pricing tiers, and free tier limits when researching services.
Output valid JSON.`,
};

const SERVICE_RESEARCH_TASK = `Do 2-3 web searches to find current pricing for music production services. Research:

1. Music generation: Suno and Udio free tier limits + cost per song on paid
2. Distribution: RouteNote free tier details, DistroKid annual cost
3. Images: Cloudflare Workers AI Flux Schnell free tier confirmation

Output compact JSON only:
{
  "services": [
    {
      "category": "music_generation|distribution|image_generation",
      "service_name": "...",
      "free_tier": "exact limits",
      "cost_per_song_usd": 0.05,
      "api_available": true,
      "notes": "...",
      "recommended": true,
      "url": "..."
    }
  ],
  "recommended_stack": {
    "music_generation": "...",
    "distribution": "...",
    "estimated_cost_per_song_usd": 0.70
  },
  "top_savings_opportunities": [
    {
      "area": "...",
      "potential_savings": "...",
      "action": "..."
    }
  ]
}`;

/**
 * Research free/cheap services (runs on first use and monthly)
 */
export async function researchServices() {
  const result = await runAgent('financial-manager', FINANCIAL_MANAGER_DEF, SERVICE_RESEARCH_TASK);

  let research;
  try {
    research = parseAgentJson(result.text);
  } catch {
    research = { raw_text: result.text, parse_error: true };
  }

  // Save to SQLite
  if (research.services) {
    for (const svc of research.services) {
      upsertServiceResearch({
        service_name: svc.service_name || 'Unknown',
        free_tier: svc.free_tier || '',
        cost_per_song_usd: svc.cost_per_song_usd || 0,
        api_available: svc.api_available || false,
        notes: `${svc.notes || ''} URL: ${svc.url || ''}`,
        recommended: svc.recommended || false,
      });
    }
  }

  return research;
}

/**
 * Update financial report after a song run
 */
export async function updateFinancialReport(songData) {
  const costData = getTotalCosts();
  const serviceData = getServiceResearch();

  await generateFinancialReport({ costData, serviceData, songData });
}

/**
 * Generate a full financial analysis (on-demand)
 */
export async function generateFullReport() {
  const costData = getTotalCosts();
  const serviceData = getServiceResearch();

  // Generate visual report
  await generateFinancialReport({ costData, serviceData });

  // If we have substantial cost data, also get AI recommendations
  if (costData.totals?.total_runs > 0) {
    const analysisTask = `Analyze this cost data for Pancake Robot's autonomous music pipeline and provide recommendations.

TOTAL COSTS:
- Total Spent: ${formatCost(costData.totals?.total_cost || 0)}
- Total Runs: ${costData.totals?.total_runs || 0}
- Total Input Tokens: ${costData.totals?.total_input_tokens?.toLocaleString() || 0}
- Total Output Tokens: ${costData.totals?.total_output_tokens?.toLocaleString() || 0}

COST BY AGENT:
${JSON.stringify(costData.byAgent, null, 2)}

KNOWN SERVICES:
${JSON.stringify(serviceData.slice(0, 10), null, 2)}

Provide:
1. Which agent is most expensive and why?
2. What's the actual cost per song?
3. Top 3 specific ways to reduce cost (with estimated savings)
4. Is the current cost per song sustainable for a kids music brand?

Keep response concise and actionable.`;

    await runAgent('financial-manager', FINANCIAL_MANAGER_DEF, analysisTask);
  }

  const reportPath = join(__dirname, '../../output/reports/financial-report.html');
  console.log(`\nFinancial report saved to ${reportPath}`);
  return reportPath;
}
