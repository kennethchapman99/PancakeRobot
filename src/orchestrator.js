/**
 * Pancake Robot — Master Orchestrator
 *
 * Commands:
 *   node src/orchestrator.js --setup                         First-time setup
 *   node src/orchestrator.js --new "topic: ..."              Full pipeline for new song
 *   node src/orchestrator.js --research                      Research only
 *   node src/orchestrator.js --report                        Financial report
 *   node src/orchestrator.js --approve <song-id>             Approve a song
 *   node src/orchestrator.js --reject <song-id> "reason"     Reject a song
 *   node src/orchestrator.js --suggest                       Suggest next song topic
 *   node src/orchestrator.js --schedule                      Start recurring scheduler
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../.env'), override: true });

import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';

import { loadConfig, saveConfig, runAgent, parseAgentJson } from './shared/managed-agent.js';
import { upsertSong, getSong, getAllSongs, createIdea } from './shared/db.js';
import { approveSong } from './shared/approval-gate.js';
import { formatCost } from './shared/costs.js';

import { runResearcher, loadResearchReport } from './agents/researcher.js';
import { buildBrand, reviewSong, loadBrandBible } from './agents/brand-manager.js';
import { writeLyrics } from './agents/lyricist.js';
import { researchDistribution, generateMetadata } from './agents/product-manager.js';
import { researchServices, updateFinancialReport, generateFullReport } from './agents/financial-manager.js';
import { generateThumbnails } from './agents/creative-manager.js';
import { runQAChecklist, generateHumanTasks, startScheduler } from './agents/ops-manager.js';
import { generateMusic } from './agents/music-generator.js';

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function generateSongId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SONG_${ts}_${rand}`;
}

function printBanner() {
  console.log(chalk.bgYellow.black('\n ══════════════════════════════════════════ '));
  console.log(chalk.bgYellow.black(' 🥞  PANCAKE ROBOT — Autonomous Music Pipeline '));
  console.log(chalk.bgYellow.black(' ══════════════════════════════════════════ \n'));
}

function printUsage() {
  console.log(chalk.bold('Usage:'));
  console.log('  node src/orchestrator.js --setup                       First-time setup');
  console.log('  node src/orchestrator.js --new "song topic here"       New song pipeline');
  console.log('  node src/orchestrator.js --research                    Run researcher only');
  console.log('  node src/orchestrator.js --report                      Generate financial report');
  console.log('  node src/orchestrator.js --approve <song-id>           Approve a song');
  console.log('  node src/orchestrator.js --reject <song-id> "reason"   Reject a song');
  console.log('  node src/orchestrator.js --suggest                     Suggest next song topic');
  console.log('  node src/orchestrator.js --schedule                    Start recurring scheduler');
  console.log('  node src/orchestrator.js --list                        List all songs');
  console.log('');
}

function validateEnv() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red('ERROR: ANTHROPIC_API_KEY not set in .env'));
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
    console.error(chalk.red('ERROR: ANTHROPIC_API_KEY looks invalid (should start with sk-ant-)'));
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// SETUP PIPELINE
// ─────────────────────────────────────────────────────────────

async function runSetup() {
  printBanner();
  console.log(chalk.bold.cyan('SETUP MODE — Building brand, research, and distribution config\n'));

  const config = loadConfig();

  // Step 1: Research FIRST — brand builder will use these findings as context
  const researchPath = join(__dirname, '../output/research/research-report.json');
  const researchFresh = fs.existsSync(researchPath) && (() => {
    try {
      const r = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
      return (r.top_topics?.length > 0 || r.raw_text?.length > 200);
    } catch { return false; }
  })();
  if (researchFresh) {
    console.log(chalk.green('✓ Research already exists — skipping'));
  } else {
    console.log(chalk.bold('\n📌 Step 1/4: Researching kids music trends (feeds into brand)...\n'));
    await runResearcher();
    console.log(chalk.green('\n✓ Research complete'));
  }

  // Step 2: Build brand — informed by research findings
  const brandBiblePath = join(__dirname, '../output/brand/brand-bible.md');
  const brandBibleExists = fs.existsSync(brandBiblePath) && fs.statSync(brandBiblePath).size > 500;
  if ((config.brand?.character || config.brand?.raw_text?.length > 100) || brandBibleExists) {
    if (brandBibleExists && !config.brand) {
      config.brand = { raw_text: fs.readFileSync(brandBiblePath, 'utf8'), created_at: new Date().toISOString(), recovered: true };
      saveConfig(config);
      console.log(chalk.yellow('⚠ Brand recovered from brand-bible.md file'));
    }
    console.log(chalk.green('✓ Brand already exists — skipping brand builder'));
    console.log(chalk.dim('  (Delete config.brand in pancake-robot.config.json to rebuild)\n'));
  } else {
    console.log(chalk.bold('\n📌 Step 2/4: Building Pancake Robot brand identity...\n'));
    await buildBrand();
    console.log(chalk.green('\n✓ Brand created and saved'));
  }

  // Step 3: Distribution research
  const distPath = join(__dirname, '../output/distribution/distribution-research.json');
  const distFresh = fs.existsSync(distPath) && (() => {
    try {
      const d = JSON.parse(fs.readFileSync(distPath, 'utf8'));
      return !d.parse_error && !d.raw_text?.length === 0;
    } catch { return false; }
  })();
  if (distFresh) {
    console.log(chalk.green('✓ Distribution research already exists — skipping'));
  } else {
    console.log(chalk.bold('\n📌 Step 3/4: Researching distribution services...\n'));
    await new Promise(r => setTimeout(r, 3000));
    await researchDistribution();
    console.log(chalk.green('\n✓ Distribution research complete'));
  }

  // Step 4: Service cost research
  console.log(chalk.bold('\n📌 Step 4/4: Researching music generation services...\n'));
  await new Promise(r => setTimeout(r, 3000));
  await researchServices();
  console.log(chalk.green('\n✓ Service research complete'));

  // Generate initial financial report
  await generateFullReport();

  console.log(chalk.bgGreen.black('\n ✓ SETUP COMPLETE \n'));
  console.log('Next steps:');
  console.log('  1. Review output/brand/brand-bible.md');
  console.log('  2. Review output/research/research-report.json');
  console.log('  3. Review output/distribution/distribution-research.md');
  console.log('  4. Run: node src/orchestrator.js --new "a robot who loves making pancakes"');
}

// ─────────────────────────────────────────────────────────────
// NEW SONG PIPELINE
// ─────────────────────────────────────────────────────────────

async function runNewSongPipeline(topic) {
  if (!topic) {
    console.error(chalk.red('ERROR: Please provide a topic: --new "your topic here"'));
    process.exit(1);
  }

  printBanner();
  console.log(chalk.bold.green(`NEW SONG PIPELINE — Topic: "${topic}"\n`));

  const songId = generateSongId();
  const songDir = join(__dirname, `../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  const config = loadConfig();
  let totalCost = 0;

  // Initialize song in DB
  upsertSong({
    id: songId,
    topic,
    status: 'draft',
    distributor: 'TuneCore',
    total_cost_usd: 0,
  });

  // ─────────────────────────────
  // 1. Load or refresh research
  // ─────────────────────────────
  let researchReport = loadResearchReport(30);
  if (!researchReport) {
    console.log(chalk.bold('\n📌 Step 1/8: Running researcher (research is >30 days old)...\n'));
    researchReport = await runResearcher();
  } else {
    console.log(chalk.green('✓ Using cached research report\n'));
  }

  // Ensure brand exists
  if (!config.brand) {
    console.log(chalk.bold('\n📌 Building brand first (required)...\n'));
    await buildBrand();
    const updatedConfig = loadConfig();
    config.brand = updatedConfig.brand;
  }

  // ─────────────────────────────
  // 2. Write lyrics (with revision loop)
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 2/8: Writing lyrics...\n'));

  let lyricsResult;
  let brandReview;
  let revisionNotes = null;
  const MAX_REVISIONS = 3;

  for (let attempt = 1; attempt <= MAX_REVISIONS; attempt++) {
    if (attempt > 1) {
      console.log(chalk.yellow(`\n↺ Revision attempt ${attempt}/${MAX_REVISIONS}...\n`));
    }

    lyricsResult = await writeLyrics({
      songId,
      topic,
      researchReport,
      brandData: config.brand,
      revisionNotes,
    });
    totalCost += lyricsResult.costUsd || 0;

    // ─────────────────────────────
    // 3. Brand review
    // ─────────────────────────────
    console.log(chalk.bold(`\n📌 Step 3/8: Brand review (attempt ${attempt})...\n`));

    brandReview = await reviewSong({
      songId,
      title: lyricsResult.title,
      topic,
      lyricsText: lyricsResult.lyricsText,
      audioPromptText: lyricsResult.audioPromptText,
    });
    totalCost += brandReview.costUsd || 0;

    const score = brandReview.scores?.overall || 0;
    console.log(`\nBrand Score: ${chalk.bold(score)}/100`);

    if (score >= 75) {
      console.log(chalk.green('✓ Brand review passed'));
      break;
    } else if (attempt < MAX_REVISIONS) {
      console.log(chalk.yellow(`✗ Score ${score} < 75 — sending revision notes to lyricist`));
      revisionNotes = brandReview.revision_notes;
    } else {
      console.log(chalk.red(`✗ Score ${score} < 75 after ${MAX_REVISIONS} attempts — escalating to human`));
      console.log(chalk.red('\nBrand review failed repeatedly. Review manually:'));
      console.log(chalk.red(`  output/songs/${songId}/brand-review.json`));
      console.log(chalk.red('  You can still proceed — the song needs your judgment.'));
    }
  }

  // Update song record
  upsertSong({
    id: songId,
    topic,
    title: lyricsResult.title,
    status: 'draft',
    lyrics_path: lyricsResult.lyricsPath,
    audio_prompt_path: lyricsResult.audioPromptPath,
    brand_score: brandReview.scores?.overall,
    total_cost_usd: totalCost,
  });

  // ─────────────────────────────
  // 4. Generate metadata
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 4/8: Generating metadata...\n'));
  const { metadata, metadataPath } = await generateMetadata({
    songId,
    title: lyricsResult.title,
    topic,
    lyrics: lyricsResult.lyricsText,
    brandData: config.brand,
    bpm: lyricsResult.songData?.audio_prompt?.tempo_bpm,
    researchReport,
  });

  upsertSong({
    id: songId,
    topic,
    title: lyricsResult.title,
    status: 'draft',
    lyrics_path: lyricsResult.lyricsPath,
    audio_prompt_path: lyricsResult.audioPromptPath,
    metadata_path: metadataPath,
    brand_score: brandReview.scores?.overall,
    total_cost_usd: totalCost,
  });

  // ─────────────────────────────
  // 5. Generate music
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 5/8: Generating music...\n'));
  const musicResult = await generateMusic({
    songId,
    title: lyricsResult.title,
    lyricsText: lyricsResult.lyricsText,
    audioPromptData: lyricsResult.songData?.audio_prompt,
  });

  if (musicResult.audioFiles?.length > 0) {
    console.log(chalk.green(`✓ Music generated: ${musicResult.audioFiles.length} version(s)`));
  } else if (musicResult.skipped || musicResult.apiError) {
    // Music generation skipped or API unavailable — manual instructions saved, pipeline continues
    console.log(chalk.yellow('⚠ Music generation skipped — manual instructions saved to audio/MUSIC_GENERATION_INSTRUCTIONS.md'));
    if (musicResult.apiError) {
      console.log(chalk.dim(`  API error: ${musicResult.apiError.substring(0, 120)}`));
    }
  }

  // ─────────────────────────────
  // 6. Generate thumbnails
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 6/9: Generating thumbnails...\n'));
  const thumbnailResult = await generateThumbnails({
    songId,
    title: lyricsResult.title,
    topic,
    metadata,
    brandData: config.brand,
  });

  // Block if thumbnails were skipped (no CF credentials)
  if (thumbnailResult.skipped) {
    const forceSkip = process.argv.includes('--force-skip-media');
    if (!forceSkip) {
      throw new Error(
        'Thumbnail generation skipped — CF_ACCOUNT_ID and CF_API_TOKEN are required.\n' +
        'Get them at https://dash.cloudflare.com → AI → Workers AI\n' +
        'To bypass during dev/testing: add --force-skip-media flag'
      );
    }
    console.log(chalk.yellow('⚠ Thumbnails skipped (--force-skip-media set)'));
  }

  upsertSong({
    id: songId,
    topic,
    title: lyricsResult.title,
    status: 'draft',
    lyrics_path: lyricsResult.lyricsPath,
    audio_prompt_path: lyricsResult.audioPromptPath,
    metadata_path: metadataPath,
    thumbnail_path: thumbnailResult.thumbDir,
    brand_score: brandReview.scores?.overall,
    total_cost_usd: totalCost,
  });

  // ─────────────────────────────
  // 7. OPS QA
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 7/9: Running QA checklist...\n'));
  const qaReport = runQAChecklist({
    songId,
    songDir,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    brandReview,
    metadata,
    thumbnails: thumbnailResult.generatedThumbnails,
  });

  // QA warnings shown, failures throw inside approval gate as second safety net
  if (qaReport.warnings.length > 0) {
    console.log(chalk.yellow('\n⚠ QA Warnings:'));
    qaReport.warnings.forEach(w => console.log(chalk.yellow(`  • ${w}`)));
  }
  if (qaReport.passed) {
    console.log(chalk.green('\n✓ QA passed — all checks green\n'));
  }

  // ─────────────────────────────
  // 8. Human approval gate
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 8/9: Human approval gate...\n'));
  const approval = await approveSong({
    songId,
    title: lyricsResult.title,
    topic,
    brandScore: brandReview.scores?.overall,
    costUsd: totalCost,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    qaReport,
    songDir,
  });

  if (approval.decision === 'yes') {
    upsertSong({
      id: songId,
      topic,
      title: lyricsResult.title,
      status: 'approved',
      lyrics_path: lyricsResult.lyricsPath,
      audio_prompt_path: lyricsResult.audioPromptPath,
      metadata_path: metadataPath,
      thumbnail_path: thumbnailResult.thumbDir,
      brand_score: brandReview.scores?.overall,
      total_cost_usd: totalCost,
    });

    // Build distribution package — pre-organized folder for DistroKid upload
    console.log(chalk.bold('\n📌 Step 9/9: Building distribution package...\n'));
    const { distDir } = await generateHumanTasks({
      songId,
      title: lyricsResult.title,
      topic,
      songDir,
      metadata,
      lyricsPath: lyricsResult.lyricsPath,
      audioPromptPath: lyricsResult.audioPromptPath,
      thumbnailDir: thumbnailResult.thumbDir,
      brandScore: brandReview.scores?.overall,
      totalCost,
    });

    console.log(chalk.bgGreen.black('\n ✓ SONG APPROVED — READY FOR DISTRIBUTION \n'));
    console.log(`  Distribution package: ${chalk.bold(distDir)}`);
    console.log(`  Open DISTROKID-UPLOAD.md for pre-filled upload values`);

  } else if (approval.decision === 'revise') {
    console.log(chalk.yellow('\n↺ Song sent for revision'));
    console.log('Re-running with revision notes...\n');

    // Re-run the pipeline with revision notes
    await runNewSongPipeline(`${topic} [REVISION: ${approval.notes}]`);
    return;

  } else {
    upsertSong({
      id: songId,
      topic,
      title: lyricsResult.title,
      status: 'rejected',
      lyrics_path: lyricsResult.lyricsPath,
      audio_prompt_path: lyricsResult.audioPromptPath,
      total_cost_usd: totalCost,
    });
    console.log(chalk.red('\n✗ Song rejected'));
  }

  // ─────────────────────────────
  // 8. Update financial report
  // ─────────────────────────────
  await updateFinancialReport({ songId, title: lyricsResult.title, totalCost });

  console.log(`\n${chalk.dim('Total pipeline cost:')} ${chalk.bold(formatCost(totalCost))}`);
  console.log(`${chalk.dim('Song ID:')} ${songId}\n`);
}

// ─────────────────────────────────────────────────────────────
// SUGGEST NEXT SONG
// ─────────────────────────────────────────────────────────────

async function suggestNextSong() {
  printBanner();
  console.log(chalk.bold.cyan('SONG SUGGESTER — What should Pancake Robot make next?\n'));

  const config = loadConfig();
  const songs = getAllSongs();
  const researchPath = join(__dirname, '../output/research/research-report.json');

  // Load research if available
  let researchSummary = '';
  try {
    const report = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
    const topics = (report.top_topics || []).slice(0, 5).map(t => `- ${t.topic}: ${t.pancake_robot_angle || t.why_it_works || ''}`).join('\n');
    const viral = (report.viral_signals || []).slice(0, 3).join('; ');
    researchSummary = `\nMARKET RESEARCH:\nTop topics:\n${topics}\nViral signals: ${viral}`;
  } catch { /* no research yet */ }

  // Summarize existing songs
  const existingSongs = songs.length > 0
    ? `\nEXISTING SONGS (avoid repeating these themes):\n${songs.map(s => `- "${s.title}" (${s.topic}) — score: ${s.brand_score || '?'}`).join('\n')}`
    : '\nEXISTING SONGS: None yet — this will be the first!';

  // Brand context
  const brandSummary = config.brand?.voice?.recurring_themes
    ? `Brand themes: ${config.brand.voice.recurring_themes.join(', ')}`
    : 'Brand: Pancake Robot — cheerful robot who loves pancakes and silly adventures, ages 4-10';

  const task = `You are the song strategist for Pancake Robot, a children's music brand (ages 4-10).

${brandSummary}
${existingSongs}
${researchSummary}

Recommend the 5 best next song topics for Pancake Robot. For each:
1. Pick topics that are NOT already covered by existing songs
2. Prioritize high replay-ability and viral potential
3. Consider the season/timing (current date: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})
4. Mix educational + pure fun topics

Output as JSON:
{
  "recommendations": [
    {
      "rank": 1,
      "title": "Suggested song title",
      "topic": "One-line topic description for --new command",
      "why": "Why this will work for Pancake Robot right now (2-3 sentences)",
      "hook_idea": "The key lyrical or musical hook concept",
      "physical_action": "Suggested body movement kids can do",
      "bpm_target": 110,
      "urgency": "evergreen|seasonal|trending"
    }
  ],
  "recommended_next": "topic string to paste directly into --new command"
}`;

  const suggesterDef = {
    name: 'Pancake Robot Song Suggester',
    model: 'claude-haiku-4-5-20251001',
    noTools: true,
    system: 'You are a children\'s music strategist. You recommend song topics that maximize replay-ability, virality, and brand consistency. Always output valid JSON.',
  };

  const result = await runAgent('product-manager', suggesterDef, task);

  let suggestions;
  try {
    suggestions = parseAgentJson(result.text);
  } catch {
    console.log('\n' + result.text);
    return;
  }

  console.log(chalk.bold('\n🎵 Next Song Recommendations:\n'));
  for (const rec of suggestions.recommendations || []) {
    const urgencyColor = rec.urgency === 'trending' ? chalk.red : rec.urgency === 'seasonal' ? chalk.yellow : chalk.green;
    console.log(chalk.bold(`${rec.rank}. ${rec.title}`));
    console.log(`   Topic: ${chalk.cyan(rec.topic)}`);
    console.log(`   ${rec.why}`);
    console.log(`   Hook: ${chalk.italic(rec.hook_idea)}`);
    console.log(`   Action: ${rec.physical_action} | BPM: ${rec.bpm_target} | ${urgencyColor(rec.urgency)}`);
    console.log('');
  }

  if (suggestions.recommended_next) {
    console.log(chalk.bgCyan.black(' ▶ TOP PICK — run this command: '));
    console.log(chalk.bold(`\n  node src/orchestrator.js --new "${suggestions.recommended_next}"\n`));
  }

  // Save suggestions to file
  const outPath = join(__dirname, '../output/suggestions.json');
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), ...suggestions }, null, 2));
  console.log(chalk.dim(`Suggestions saved to output/suggestions.json`));

  // Auto-save each suggestion to Idea Vault
  let savedCount = 0;
  for (const rec of suggestions.recommendations || []) {
    try {
      createIdea({
        title: rec.title,
        concept: rec.why || null,
        hook: rec.hook_idea || null,
        target_age_range: '4-10',
        category: rec.urgency === 'seasonal' ? 'seasonal' : null,
        mood: rec.bpm_target ? `upbeat, ${rec.bpm_target} BPM` : null,
        tags: [rec.urgency || 'evergreen'].filter(Boolean),
        lyric_seed: rec.hook_idea || null,
        notes: rec.physical_action ? `Physical action: ${rec.physical_action}` : null,
        source_type: 'generated',
        source_ref: `suggest_${new Date().toISOString().slice(0, 10)}`,
      });
      savedCount++;
    } catch { /* idea may already exist */ }
  }
  if (savedCount > 0) {
    console.log(chalk.dim(`✓ ${savedCount} idea(s) saved to Idea Vault (view at http://localhost:3737/ideas)`));
  }
}

// ─────────────────────────────────────────────────────────────
// APPROVE / REJECT
// ─────────────────────────────────────────────────────────────

async function approveSongCommand(songId) {
  const song = getSong(songId);
  if (!song) {
    console.error(chalk.red(`Song not found: ${songId}`));
    process.exit(1);
  }

  upsertSong({ ...song, status: 'approved' });
  console.log(chalk.green(`✓ Song ${songId} approved`));

  // Generate human tasks if not already done
  const humanTaskPath = join(__dirname, `../output/human-tasks/${songId}-human-tasks.md`);
  if (!fs.existsSync(humanTaskPath)) {
    console.log('Generating human task instructions...');
    await generateHumanTasks({
      songId,
      title: song.title,
      topic: song.topic,
      songDir: join(__dirname, `../output/songs/${songId}`),
      metadata: null,
      lyricsPath: song.lyrics_path,
      audioPromptPath: song.audio_prompt_path,
      thumbnailDir: song.thumbnail_path,
      brandScore: song.brand_score,
      totalCost: song.total_cost_usd,
    });
  }

  console.log(`\nHuman tasks: output/human-tasks/${songId}-human-tasks.md`);
}

async function rejectSongCommand(songId, reason) {
  const song = getSong(songId);
  if (!song) {
    console.error(chalk.red(`Song not found: ${songId}`));
    process.exit(1);
  }

  upsertSong({ ...song, status: 'rejected' });
  console.log(chalk.red(`✗ Song ${songId} rejected. Reason: ${reason || 'none'}`));
}

// ─────────────────────────────────────────────────────────────
// LIST SONGS
// ─────────────────────────────────────────────────────────────

function verifySong(songId) {
  if (!songId) {
    console.error(chalk.red('Usage: --verify <song-id>'));
    process.exit(1);
  }

  const song = getSong(songId);
  const songDir = join(__dirname, `../output/songs/${songId}`);

  console.log(chalk.bold(`\nVerifying song: ${songId}\n`));

  const checks = [];

  // Lyrics
  const lyricsOk = fs.existsSync(join(songDir, 'lyrics.md'));
  checks.push({ label: 'Lyrics (lyrics.md)', ok: lyricsOk });

  // Audio prompt
  const promptOk = fs.existsSync(join(songDir, 'audio-prompt.md'));
  checks.push({ label: 'Audio prompt (audio-prompt.md)', ok: promptOk });

  // Audio file (mp3 or wav, pipeline folder or legacy root)
  const audioDir = join(songDir, 'audio');
  const hasAudioRoot = fs.existsSync(join(songDir, 'audio.mp3')) || fs.existsSync(join(songDir, 'audio.wav'));
  const hasAudioDir = fs.existsSync(audioDir) && fs.readdirSync(audioDir).some(f => f.endsWith('.mp3') || f.endsWith('.wav'));
  const audioOk = hasAudioRoot || hasAudioDir;
  checks.push({ label: 'Audio file (MP3/WAV)', ok: audioOk, warn: !audioOk });

  // Thumbnails
  const thumbDir = join(songDir, 'thumbnails');
  const pngs = fs.existsSync(thumbDir) ? fs.readdirSync(thumbDir).filter(f => f.endsWith('.png')) : [];
  const thumbOk = pngs.length >= 1;
  checks.push({ label: `Thumbnails (${pngs.length} PNG${pngs.length !== 1 ? 's' : ''})`, ok: thumbOk, warn: !thumbOk });

  // Metadata
  const metaOk = fs.existsSync(join(songDir, 'metadata.json'));
  checks.push({ label: 'Metadata (metadata.json)', ok: metaOk });

  // Brand review
  const reviewPath = join(songDir, 'brand-review.json');
  let score = song?.brand_score || null;
  if (!score && fs.existsSync(reviewPath)) {
    try { score = JSON.parse(fs.readFileSync(reviewPath, 'utf8')).scores?.overall; } catch {}
  }
  const scoreOk = score >= 75;
  checks.push({ label: `Brand score (${score || '?'}/100, min 75)`, ok: scoreOk });

  // Print results
  for (const c of checks) {
    const icon = c.ok ? chalk.green('✓') : c.warn ? chalk.yellow('⚠') : chalk.red('✗');
    console.log(`  ${icon} ${c.label}`);
  }

  const allCritical = checks.filter(c => !c.warn).every(c => c.ok);
  const status = song?.status || 'unknown';
  console.log(`\n  Status: ${chalk.bold(status)}`);
  console.log(`  Title:  ${song?.title || '—'}`);
  if (song?.total_cost_usd) {
    console.log(`  Cost:   ${formatCost(song.total_cost_usd)}`);
  }

  if (audioOk && thumbOk && allCritical) {
    console.log(chalk.green('\n✓ Ready for distribution\n'));
  } else {
    console.log(chalk.yellow('\n⚠ Not yet ready — see items above\n'));
  }
}

function listSongs() {
  const songs = getAllSongs();
  if (songs.length === 0) {
    console.log('No songs yet. Run: node src/orchestrator.js --new "your topic here"');
    return;
  }

  const statusColors = {
    draft: chalk.yellow,
    approved: chalk.green,
    rejected: chalk.red,
    published: chalk.blue,
  };

  console.log(chalk.bold('\nAll Songs:\n'));
  console.log(`${'ID'.padEnd(22)} ${'Title'.padEnd(30)} ${'Status'.padEnd(12)} ${'Score'.padEnd(6)} Cost`);
  console.log('─'.repeat(90));

  for (const song of songs) {
    const color = statusColors[song.status] || chalk.white;
    console.log(
      `${song.id.padEnd(22)} ` +
      `${(song.title || '—').substring(0, 28).padEnd(30)} ` +
      `${color(song.status.padEnd(12))} ` +
      `${(song.brand_score?.toString() || '—').padEnd(6)} ` +
      `${formatCost(song.total_cost_usd || 0)}`
    );
  }
  console.log('');
}

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

async function main() {
  validateEnv();

  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printBanner();
    printUsage();
    return;
  }

  switch (cmd) {
    case '--setup': {
      await runSetup();
      break;
    }

    case '--new': {
      const topic = args.slice(1).join(' ');
      await runNewSongPipeline(topic);
      break;
    }

    case '--research': {
      printBanner();
      console.log(chalk.bold('Running researcher agent...\n'));
      await runResearcher();
      break;
    }

    case '--report': {
      printBanner();
      console.log(chalk.bold('Generating financial report...\n'));
      await generateFullReport();
      break;
    }

    case '--approve': {
      const songId = args[1];
      if (!songId) {
        console.error(chalk.red('Usage: --approve <song-id>'));
        process.exit(1);
      }
      await approveSongCommand(songId);
      break;
    }

    case '--reject': {
      const songId = args[1];
      const reason = args.slice(2).join(' ');
      if (!songId) {
        console.error(chalk.red('Usage: --reject <song-id> "reason"'));
        process.exit(1);
      }
      await rejectSongCommand(songId, reason);
      break;
    }

    case '--list': {
      listSongs();
      break;
    }

    case '--verify': {
      const songId = args[1];
      verifySong(songId);
      break;
    }

    case '--suggest': {
      await suggestNextSong();
      break;
    }

    case '--schedule': {
      printBanner();
      console.log(chalk.bold('Starting recurring task scheduler...\n'));
      startScheduler({
        onResearch: async () => { await runResearcher(); },
        onFinancialReport: async () => { await generateFullReport(); },
        onDistributionCheck: async () => { await researchDistribution(); },
      });
      // Keep process alive
      process.stdin.resume();
      break;
    }

    default: {
      console.error(chalk.red(`Unknown command: ${cmd}`));
      printUsage();
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(chalk.red('\nFatal error:'), err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
