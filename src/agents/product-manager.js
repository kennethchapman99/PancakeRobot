/**
 * Product Manager Agent — Distribution research + SEO metadata
 *
 * First run: researches streaming distribution services
 * Per song: generates SEO-optimized metadata.json
 */

import { runAgent, parseAgentJson, loadConfig, saveConfig } from '../shared/managed-agent.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISTRIBUTION_DIR = join(__dirname, '../../output/distribution');

export const PRODUCT_MANAGER_DEF = {
  name: 'Pancake Robot Product Manager',
  system: `You are the product manager and distribution strategist for Pancake Robot, a children's music brand.

Your expertise covers:
- Music streaming distribution platforms and their economics
- YouTube SEO for children's content (a specialized and competitive field)
- Metadata optimization for discoverability on Spotify, Apple Music, and YouTube
- Children's content platform algorithms and what they reward
- Release timing strategies for maximum algorithmic boost
- The specific requirements of kids music (COPPA compliance considerations, family-friendly tags)

You research thoroughly and provide specific, actionable recommendations with real numbers.
Always output valid JSON.`,
};

const DISTRIBUTION_RESEARCH_TASK = `Do 1-2 web searches to compare music distribution services for a children's music brand.

Focus on: RouteNote (free tier), DistroKid ($22/yr), Amuse (free tier).
Key questions: royalty split, days to publish, YouTube Content ID included?

Output compact JSON only:
{
  "services": [
    {
      "name": "...",
      "annual_cost_usd": 0,
      "royalty_split": "...",
      "days_to_publish": "...",
      "youtube_content_id": true,
      "free_tier": true,
      "recommended": true
    }
  ],
  "recommendation": {
    "service": "...",
    "reasoning": "...",
    "signup_url": "..."
  },
  "release_strategy": {
    "best_day": "Friday",
    "singles_vs_album": "singles to start",
    "release_cadence": "1-2 per month"
  }
}`;

/**
 * Research distribution services (first run)
 */
export async function researchDistribution() {
  fs.mkdirSync(DISTRIBUTION_DIR, { recursive: true });

  const result = await runAgent('product-manager', PRODUCT_MANAGER_DEF, DISTRIBUTION_RESEARCH_TASK);

  let research;
  try {
    research = parseAgentJson(result.text);
  } catch {
    research = { raw_text: result.text, parse_error: true };
  }

  // Save markdown report
  const mdPath = join(DISTRIBUTION_DIR, 'distribution-research.md');
  let md = `# Distribution Research\n\n*Researched: ${new Date().toISOString()}*\n\n`;
  if (research.services) {
    for (const svc of research.services) {
      md += `## ${svc.name}\n`;
      md += `- **Annual Cost:** $${svc.annual_cost_usd}\n`;
      md += `- **Royalty Split:** ${svc.royalty_split}\n`;
      md += `- **Days to Publish:** ${svc.days_to_publish}\n`;
      md += `- **YouTube Content ID:** ${svc.youtube_content_id ? '✓' : '✗'}\n`;
      md += `- **Free Tier:** ${svc.free_tier ? '✓' : '✗'}\n`;
      if (svc.pros) md += `- **Pros:** ${svc.pros.join(', ')}\n`;
      if (svc.cons) md += `- **Cons:** ${svc.cons.join(', ')}\n`;
      md += `\n`;
    }
    if (research.recommendation) {
      md += `## ✓ Recommendation\n\n**${research.recommendation.service}** — ${research.recommendation.reasoning}\n\n`;
    }
  } else {
    md += result.text;
  }
  fs.writeFileSync(mdPath, md);

  // Save JSON
  fs.writeFileSync(join(DISTRIBUTION_DIR, 'distribution-research.json'), JSON.stringify(research, null, 2));

  // Update config
  const config = loadConfig();
  config.distribution = {
    recommended_service: research.recommendation?.service || 'DistroKid',
    recommended_url: research.recommendation?.signup_url || 'https://distrokid.com',
    release_strategy: research.release_strategy,
    researched_at: new Date().toISOString(),
  };
  saveConfig(config);

  console.log(`\nDistribution research saved to ${mdPath}`);
  return research;
}

/**
 * Generate SEO-optimized metadata for a song
 */
export async function generateMetadata({ songId, title, topic, lyrics, brandData, bpm, researchReport }) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  const config = loadConfig();
  const releaseStrategy = config.distribution?.release_strategy;

  const metadataTask = `Generate comprehensive, SEO-optimized metadata for this Pancake Robot children's song.

SONG DETAILS:
Title: ${title}
Topic: ${topic}
BPM: ${bpm || 'unknown'}

LYRICS PREVIEW:
${(lyrics || '').substring(0, 800)}

RELEASE STRATEGY CONTEXT:
${releaseStrategy ? JSON.stringify(releaseStrategy) : 'Friday releases typically work well for kids content'}

Generate metadata optimized for:
1. Spotify discoverability (genres, mood tags)
2. YouTube SEO (title must have primary keyword first, 100 YouTube tags)
3. Apple Music categorization

Rules for YouTube title: primary keyword first, max 70 chars, no clickbait. Include "Pancake Robot" only if it appears naturally and adds searchability — it is NOT required in every title. Great kids YouTube titles are topic-first and intriguing.
Rules for YouTube tags: include at least 20 highly specific children's music search terms

Output as JSON:
{
  "title": "${title}",
  "artist": "Pancake Robot",
  "album": "Pancake Robot Vol. 1",
  "genre": "Children's Music",
  "spotify_genres": ["children's music", "kids pop", "educational"],
  "youtube_tags": ["kids songs", "children's music", "pancake robot", "...17+ more"],
  "youtube_title": "SEO title here",
  "youtube_description": "Full 500+ word description with timestamps placeholder, keywords naturally woven in, and call-to-action",
  "apple_music_genres": ["Kids & Family", "Children's Music"],
  "mood_tags": ["happy", "energetic", "silly"],
  "bpm": ${bpm || 110},
  "key": "C major",
  "duration_seconds": 145,
  "release_strategy": {
    "best_day": "Friday",
    "best_time_utc": "17:00",
    "reason": "..."
  },
  "thumbnail_specs": {
    "youtube": "1280x720",
    "spotify": "3000x3000",
    "apple_music": "3000x3000"
  },
  "isrc_needed": true,
  "content_advisory": "suitable for all ages",
  "coppa_status": "directed to children under 13"
}`;

  // Metadata is structured JSON generation — Haiku is sufficient and cheaper
  const metaDef = { ...PRODUCT_MANAGER_DEF, name: 'Pancake Robot Metadata Generator', model: 'claude-haiku-4-5-20251001', noTools: true };
  const result = await runAgent('product-manager', metaDef, metadataTask);

  let metadata;
  try {
    metadata = parseAgentJson(result.text);
  } catch {
    metadata = {
      title,
      artist: 'Pancake Robot',
      topic,
      parse_error: true,
      raw_text: result.text.substring(0, 500),
    };
  }

  const metadataPath = join(songDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`\nMetadata saved to ${metadataPath}`);

  return { metadata, metadataPath };
}
