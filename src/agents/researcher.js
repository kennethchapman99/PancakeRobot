/**
 * Researcher Agent — Children's music trend analysis
 *
 * Performs autonomous web research on what kids 4-10 actually listen to.
 * Outputs structured research-report.json.
 */

import { runAgent, parseAgentJson, loadConfig } from '../shared/managed-agent.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESEARCH_PATH = join(__dirname, '../../output/research/research-report.json');

export const RESEARCHER_DEF = {
  name: 'Pancake Robot Researcher',
  system: `You are a children's music market analyst obsessed with streaming data, YouTube trends, and what makes kids replay songs until parents beg for mercy.

You specialize in:
- Analyzing what children ages 4-10 actually listen to (not what parents think they listen to)
- Understanding the psychology of viral kids content — repetition, physical engagement, humor
- Reading streaming charts, YouTube trending data, and social media signals
- Identifying lyric patterns, tempo ranges, and song structures that dominate kids' playlists
- Competitive analysis of top kids music brands (Cocomelon, Pinkfong, Blippi, etc.)

You produce structured, actionable research reports that inform music creation decisions.
Always cite specific examples with real songs and their approximate stream counts when available.
Format your final output as valid JSON.`,
};

const RESEARCH_TASK = `Research children's music trends for a new brand called "Pancake Robot" (ages 4-10).

Do 2-3 targeted web searches maximum, then synthesize. Focus on:
1. TOP TOPICS: 5 themes dominating kids music + why each works psychologically
2. LYRIC PATTERNS: 3 techniques that drive replay (repetition, call-and-response, etc.)
3. SONG SPECS: ideal length, BPM range, key signatures for kids
4. AVOID: top 3 mistakes that kill replay
5. FIRST SONG IDEAS: 3 specific concepts well-suited for a brand-new channel

Output compact JSON only:
{
  "top_topics": [{"topic": "...", "why_it_works": "...", "example_songs": ["..."]}],
  "lyric_patterns": [{"pattern": "...", "why_effective": "..."}],
  "ideal_length_seconds": 150,
  "ideal_bpm_range": [90, 130],
  "viral_signals": ["..."],
  "avoid": ["..."],
  "recommended_first_topics": [
    {"title": "...", "concept": "...", "hook_line": "...", "why_it_will_work": "..."}
  ],
  "last_updated": "ISO timestamp"
}`;

/**
 * Run the researcher agent and save the report.
 * Returns the parsed research report.
 */
export async function runResearcher() {
  fs.mkdirSync(join(__dirname, '../../output/research'), { recursive: true });

  const result = await runAgent('researcher', RESEARCHER_DEF, RESEARCH_TASK);

  let report;
  try {
    report = parseAgentJson(result.text);
    report.last_updated = new Date().toISOString();
  } catch {
    report = {
      raw_text: result.text,
      last_updated: new Date().toISOString(),
      parse_error: true,
    };
  }

  // Validate meaningful content exists before writing
  const hasContent = report.top_topics?.length > 0 || report.raw_text?.length > 200;
  if (!hasContent) {
    throw new Error('Research produced no usable content');
  }

  fs.writeFileSync(RESEARCH_PATH, JSON.stringify(report, null, 2));
  console.log(`\nResearch report saved to ${RESEARCH_PATH}`);

  // Update config with last research timestamp
  const config = loadConfig();
  config.last_research = new Date().toISOString();
  const { saveConfig } = await import('../shared/managed-agent.js');
  saveConfig(config);

  return report;
}

/**
 * Load existing research report if it's fresh enough (default: 30 days)
 */
export function loadResearchReport(maxAgeDays = 30) {
  if (!fs.existsSync(RESEARCH_PATH)) return null;

  try {
    const report = JSON.parse(fs.readFileSync(RESEARCH_PATH, 'utf8'));
    if (report.last_updated) {
      const age = (Date.now() - new Date(report.last_updated)) / (1000 * 60 * 60 * 24);
      if (age > maxAgeDays) return null; // Stale
    }
    return report;
  } catch {
    return null;
  }
}
