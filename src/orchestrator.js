/**
 * Music Pipeline — Master Orchestrator
 *
 * Commands:
 *   node src/orchestrator.js --setup                         First-time setup
 *   node src/orchestrator.js --new "topic: ..."              Full pipeline for new song
 *   node src/orchestrator.js --magic "topic: ..."            One-click create → rank → improve once → market
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

import { upsertSong, getSong, getAllSongs } from './shared/db.js';
import { approveSong } from './shared/approval-gate.js';
import { SONG_STATUSES, getSongStatusLabel, normalizeSongStatus } from './shared/song-status.js';
import { formatCost } from './shared/costs.js';
import { loadBrandProfile } from './shared/brand-profile.js';
import { runSuggestPipeline } from './shared/suggest.js';

import { runResearcher, loadResearchReport } from './agents/researcher.js';
import { buildBrand, reviewSong, loadBrandBible } from './agents/brand-manager.js';
import { writeLyrics } from './agents/lyricist.js';
import { researchDistribution, generateMetadata } from './agents/product-manager.js';
import { researchServices, updateFinancialReport, generateFullReport } from './agents/financial-manager.js';
import { runQAChecklist, generateHumanTasks, startScheduler } from './agents/ops-manager.js';
import { generateMusic } from './agents/music-generator.js';
import { analyzeSongForReleaseSelection } from './agents/release-selection-agent.js';
import { buildReleaseSelectionRevisionBrief } from './lib/release-selection/regeneration-brief.js';
import { buildSongReleaseAssets } from './shared/song-release-assets-service.js';

const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const APP_TITLE = BRAND_PROFILE.app_title || BRAND_NAME;
const AUDIENCE_DESCRIPTION = BRAND_PROFILE.audience.description;
const DEFAULT_DISTRIBUTOR = BRAND_PROFILE.distribution.default_distributor;

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
  console.log(chalk.bgYellow.black(` ${APP_TITLE.toUpperCase()} — Autonomous Music Pipeline `));
  console.log(chalk.bgYellow.black(' ══════════════════════════════════════════ \n'));
}

function printUsage() {
  console.log(chalk.bold('Usage:'));
  console.log('  node src/orchestrator.js --setup                       First-time setup');
  console.log('  node src/orchestrator.js --new "song topic here"       New song pipeline');
  console.log('  node src/orchestrator.js --magic "song topic here"     Magic pipeline');
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

function loadExistingDraftPayload(songId, songDir) {
  try {
    const dataPath = join(songDir, 'lyrics-data.json');
    const lyricsPath = join(songDir, 'lyrics.md');
    const audioPromptPath = join(songDir, 'audio-prompt.md');
    if (!fs.existsSync(dataPath) || !fs.existsSync(lyricsPath) || !fs.existsSync(audioPromptPath)) {
      return null;
    }

    const songData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const lyricsText = fs.readFileSync(lyricsPath, 'utf8');
    const audioPromptText = fs.readFileSync(audioPromptPath, 'utf8');
    return {
      songData,
      title: songData.title || `Regenerated ${songId}`,
      lyricsText,
      audioPromptText,
      lyricsPath,
      audioPromptPath,
      wordCount: countApproxWords(lyricsText),
      costUsd: 0,
    };
  } catch {
    return null;
  }
}

function countApproxWords(text = '') {
  return String(text)
    .replace(/\[[^\]]+\]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function parseTopicArgs(args) {
  const idFlagIdx = args.indexOf('--id');
  return {
    existingSongId: idFlagIdx !== -1 ? args[idFlagIdx + 1] : null,
    topic: args
      .slice(1)
      .filter((_, i) => (i + 1) !== idFlagIdx && (i + 1) !== idFlagIdx + 1)
      .join(' '),
  };
}

function persistSongState({
  songId,
  topic,
  title,
  lyricsPath,
  audioPromptPath,
  metadataPath = null,
  brandScore = null,
  totalCost = 0,
  extra = {},
}) {
  upsertSong({
    id: songId,
    topic,
    title,
    status: SONG_STATUSES.DRAFT,
    lyrics_path: lyricsPath,
    audio_prompt_path: audioPromptPath,
    metadata_path: metadataPath,
    brand_score: brandScore,
    total_cost_usd: totalCost,
    ...extra,
  });
}

function isReleaseCandidate(releaseSelectionResult) {
  return releaseSelectionResult?.recommendation?.value === 'recommend_to_publish';
}

async function loadFreshResearchReport() {
  let researchReport = loadResearchReport(30);
  if (!researchReport) {
    console.log(chalk.bold('\n📌 Step 1: Running researcher (research is >30 days old)...\n'));
    researchReport = await runResearcher();
  } else {
    console.log(chalk.green('✓ Using cached research report\n'));
  }
  return researchReport;
}

async function runSongBuildPass({
  songId,
  topic,
  researchReport,
  totalCost = 0,
  draftPayload = null,
  revisionNotes = null,
  existingLyrics = null,
  passLabel = 'Pass',
}) {
  let lyricsResult;

  if (draftPayload) {
    console.log(chalk.bold(`\n📌 ${passLabel}: Reusing current lyrics and audio prompt...\n`));
    lyricsResult = draftPayload;
    console.log(chalk.green(`✓ Reusing current draft: ${lyricsResult.title}`));
  } else {
    console.log(chalk.bold(`\n📌 ${passLabel}: Writing lyrics...\n`));
    lyricsResult = await writeLyrics({
      songId,
      topic,
      researchReport,
      revisionNotes,
      existingLyrics,
    });
    totalCost += lyricsResult.costUsd || 0;
  }

  console.log(chalk.bold(`\n📌 ${passLabel}: Brand review...\n`));
  const brandReview = await reviewSong({
    songId,
    title: lyricsResult.title,
    topic,
    lyricsText: lyricsResult.lyricsText,
    audioPromptText: lyricsResult.audioPromptText,
  });
  totalCost += brandReview.costUsd || 0;
  console.log(`\nBrand Score: ${chalk.bold(brandReview.scores?.overall || 0)}/100`);

  persistSongState({
    songId,
    topic,
    title: lyricsResult.title,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    brandScore: brandReview.scores?.overall,
    totalCost,
  });

  console.log(chalk.bold(`\n📌 ${passLabel}: Generating metadata...\n`));
  const { metadata, metadataPath } = await generateMetadata({
    songId,
    title: lyricsResult.title,
    topic,
    lyrics: lyricsResult.lyricsText,
    bpm: lyricsResult.songData?.audio_prompt?.tempo_bpm,
    researchReport,
  });

  persistSongState({
    songId,
    topic,
    title: lyricsResult.title,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    metadataPath,
    brandScore: brandReview.scores?.overall,
    totalCost,
  });

  console.log(chalk.bold(`\n📌 ${passLabel}: Generating music...\n`));
  const musicResult = await generateMusic({
    songId,
    title: lyricsResult.title,
    lyricsText: lyricsResult.lyricsText,
    audioPromptData: lyricsResult.songData?.audio_prompt,
  });

  if (musicResult.audioFiles?.length > 0) {
    console.log(chalk.green(`✓ Music generated: ${musicResult.audioFiles.length} version(s)`));
  } else if (musicResult.skipped || musicResult.apiError) {
    console.log(chalk.yellow('⚠ Music generation skipped — manual instructions saved to audio/MUSIC_GENERATION_INSTRUCTIONS.md'));
    if (musicResult.apiError) {
      console.log(chalk.dim(`  API error: ${musicResult.apiError.substring(0, 120)}`));
    }
  }

  persistSongState({
    songId,
    topic,
    title: lyricsResult.title,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    metadataPath,
    brandScore: brandReview.scores?.overall,
    totalCost,
  });

  console.log(chalk.bold(`\n📌 ${passLabel}: Running release selection analysis...\n`));
  const releaseSelectionResult = await analyzeSongForReleaseSelection(songId);
  console.log(chalk.green(`✓ Release recommendation: ${releaseSelectionResult.recommendation.value} (${releaseSelectionResult.recommendation.score}/100)`));

  console.log(chalk.bold(`\n📌 ${passLabel}: Running QA checklist...\n`));
  const songDir = join(__dirname, `../output/songs/${songId}`);
  const qaReport = runQAChecklist({
    songId,
    songDir,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    brandReview,
    metadata,
  });

  if (qaReport.warnings.length > 0) {
    console.log(chalk.yellow('\n⚠ QA Warnings:'));
    qaReport.warnings.forEach(w => console.log(chalk.yellow(`  • ${w}`)));
  }
  if (qaReport.passed) {
    console.log(chalk.green('\n✓ QA passed — all checks green\n'));
  }

  return {
    lyricsResult,
    brandReview,
    metadata,
    metadataPath,
    musicResult,
    releaseSelectionResult,
    qaReport,
    totalCost,
  };
}

async function finalizeMagicPipelineSuccess({
  songId,
  topic,
  lyricsResult,
  metadata,
  metadataPath,
  brandReview,
  totalCost,
}) {
  console.log(chalk.bold('\n📌 Magic Finalize: Building distribution package...\n'));
  const songDir = join(__dirname, `../output/songs/${songId}`);
  const { distDir } = await generateHumanTasks({
    songId,
    title: lyricsResult.title,
    topic,
    songDir,
    metadata,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    brandScore: brandReview.scores?.overall,
    totalCost,
  });

  console.log(chalk.bold('\n📌 Magic Finalize: Building marketing assets...\n'));
  const marketingResult = await buildSongReleaseAssets(songId, {
    mode: 'render_from_existing_visuals',
    renderVideos: false,
  });

  persistSongState({
    songId,
    topic,
    title: lyricsResult.title,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    metadataPath,
    brandScore: brandReview.scores?.overall,
    totalCost,
  });

  console.log(chalk.bgGreen.black('\n ✓ MAGIC PIPELINE READY \n'));
  console.log(`  Distribution package: ${chalk.bold(distDir)}`);
  if (marketingResult.dashboardUrl) {
    console.log(`  Marketing dashboard: ${chalk.bold(marketingResult.dashboardUrl)}`);
  }
  if (marketingResult.qaWarnings?.length) {
    console.log(chalk.yellow('\n  Marketing warnings:'));
    marketingResult.qaWarnings.forEach(warning => console.log(chalk.yellow(`  • ${warning}`)));
  }
}

// ─────────────────────────────────────────────────────────────
// SETUP PIPELINE
// ─────────────────────────────────────────────────────────────

async function runSetup() {
  printBanner();
  console.log(chalk.bold.cyan('SETUP MODE — Building brand, research, and distribution config\n'));

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
    console.log(chalk.bold(`\n📌 Step 1/4: Researching music trends for ${AUDIENCE_DESCRIPTION}...\n`));
    await runResearcher();
    console.log(chalk.green('\n✓ Research complete'));
  }

  // Step 2: Build optional human-readable brand bible from the active profile
  const brandBiblePath = join(__dirname, '../output/brand/brand-bible.md');
  const brandBibleExists = fs.existsSync(brandBiblePath) && fs.statSync(brandBiblePath).size > 500;
  if (brandBibleExists) {
    console.log(chalk.green('✓ Brand bible already exists — skipping brand bible builder'));
    console.log(chalk.dim('  (Active brand truth still comes from config/brand-profile*.json)\n'));
  } else {
    console.log(chalk.bold(`\n📌 Step 2/4: Building ${BRAND_NAME} brand bible from active profile...\n`));
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
  console.log('  4. Run: node src/orchestrator.js --new "song topic here"');
}

// ─────────────────────────────────────────────────────────────
// NEW SONG PIPELINE
// ─────────────────────────────────────────────────────────────

async function runNewSongPipeline(topic, existingSongId = null) {
  if (!topic) {
    console.error(chalk.red('ERROR: Please provide a topic: --new "your topic here"'));
    process.exit(1);
  }

  printBanner();
  console.log(chalk.bold.green(`NEW SONG PIPELINE — Topic: "${topic}"\n`));

  const songId = existingSongId || generateSongId();
  const songDir = join(__dirname, `../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });
  const reuseExistingDraft = existingSongId && process.env.REGENERATE_FROM_EXISTING === '1';
  const existingDraftPayload = reuseExistingDraft ? loadExistingDraftPayload(songId, songDir) : null;

  let totalCost = 0;

  // Initialize song in DB (upsert preserves existing fields when reusing an ID)
  upsertSong({
    id: songId,
    topic,
    status: 'draft',
    distributor: DEFAULT_DISTRIBUTOR,
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

  // ─────────────────────────────
  // 2. Write or reuse lyrics
  // ─────────────────────────────
  let lyricsResult;
  let brandReview;
  let revisionNotes = null;
  const MAX_REVISIONS = 3;

  if (existingDraftPayload) {
    console.log(chalk.bold('\n📌 Step 2/9: Reusing existing revised lyrics and audio prompt...\n'));
    lyricsResult = existingDraftPayload;
    console.log(chalk.green(`✓ Reusing current draft: ${lyricsResult.title}`));
  } else {
    console.log(chalk.bold('\n📌 Step 2/9: Writing lyrics...\n'));
    for (let attempt = 1; attempt <= MAX_REVISIONS; attempt++) {
      if (attempt > 1) {
        console.log(chalk.yellow(`\n↺ Revision attempt ${attempt}/${MAX_REVISIONS}...\n`));
      }

      lyricsResult = await writeLyrics({
        songId,
        topic,
        researchReport,
        revisionNotes,
      });
      totalCost += lyricsResult.costUsd || 0;

      console.log(chalk.bold(`\n📌 Step 3/9: Brand review (attempt ${attempt})...\n`));

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
  }

  if (!brandReview) {
    console.log(chalk.bold('\n📌 Step 3/9: Brand review on current draft...\n'));
    brandReview = await reviewSong({
      songId,
      title: lyricsResult.title,
      topic,
      lyricsText: lyricsResult.lyricsText,
      audioPromptText: lyricsResult.audioPromptText,
    });
    totalCost += brandReview.costUsd || 0;
    console.log(`\nBrand Score: ${chalk.bold(brandReview.scores?.overall || 0)}/100`);
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
  console.log(chalk.bold('\n📌 Step 4/9: Generating metadata...\n'));
  const { metadata, metadataPath } = await generateMetadata({
    songId,
    title: lyricsResult.title,
    topic,
    lyrics: lyricsResult.lyricsText,
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
  console.log(chalk.bold('\n📌 Step 5/9: Generating music...\n'));
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
  // 6. Release selection analysis
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 6/9: Running release selection analysis...\n'));
  const releaseSelectionResult = await analyzeSongForReleaseSelection(songId);
  console.log(chalk.green(`✓ Release recommendation: ${releaseSelectionResult.recommendation.value} (${releaseSelectionResult.recommendation.score}/100)`));

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
      status: SONG_STATUSES.DRAFT,
      lyrics_path: lyricsResult.lyricsPath,
      audio_prompt_path: lyricsResult.audioPromptPath,
      metadata_path: metadataPath,
      brand_score: brandReview.scores?.overall,
      total_cost_usd: totalCost,
    });

    // Build distribution package with active-profile metadata and upload instructions
    console.log(chalk.bold('\n📌 Step 9/9: Building distribution package...\n'));
    const { distDir } = await generateHumanTasks({
      songId,
      title: lyricsResult.title,
      topic,
      songDir,
      metadata,
      lyricsPath: lyricsResult.lyricsPath,
      audioPromptPath: lyricsResult.audioPromptPath,
      brandScore: brandReview.scores?.overall,
      totalCost,
    });

    console.log(chalk.bgGreen.black('\n ✓ SONG PACKAGE READY \n'));
    console.log(`  Distribution package: ${chalk.bold(distDir)}`);
    console.log(`  Open DISTRIBUTOR-UPLOAD.md for pre-filled upload values`);

  } else if (approval.decision === 'revise') {
    console.log(chalk.yellow('\n↺ Song sent for revision'));
    console.log('Re-running with revision notes...\n');

    // Re-run the pipeline with revision notes
    await runNewSongPipeline(`${topic} [REVISION: ${approval.notes}]`);
    return;

  } else if (approval.decision === 'defer') {
    upsertSong({
      id: songId,
      topic,
      title: lyricsResult.title,
      status: SONG_STATUSES.DRAFT,
      lyrics_path: lyricsResult.lyricsPath,
      audio_prompt_path: lyricsResult.audioPromptPath,
      metadata_path: metadataPath,
      total_cost_usd: totalCost,
    });
    console.log(chalk.cyan('\n↺ Operator approval deferred to the web UI after release-selection analysis'));
  } else {
    upsertSong({
      id: songId,
      topic,
      title: lyricsResult.title,
      status: SONG_STATUSES.DRAFT,
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

async function runMagicPipeline(topic, existingSongId = null) {
  if (!topic) {
    console.error(chalk.red('ERROR: Please provide a topic: --magic "your topic here"'));
    process.exit(1);
  }

  printBanner();
  console.log(chalk.bold.magenta(`MAGIC PIPELINE — Topic: "${topic}"\n`));
  console.log(chalk.dim('Flow: create → score → improve once if needed → build marketing assets only for release candidates\n'));

  const songId = existingSongId || generateSongId();
  const songDir = join(__dirname, `../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });
  const reuseExistingDraft = existingSongId && process.env.REGENERATE_FROM_EXISTING === '1';
  const existingDraftPayload = reuseExistingDraft ? loadExistingDraftPayload(songId, songDir) : null;
  let totalCost = 0;

  upsertSong({
    id: songId,
    topic,
    status: SONG_STATUSES.DRAFT,
    distributor: DEFAULT_DISTRIBUTOR,
    total_cost_usd: 0,
  });

  const researchReport = await loadFreshResearchReport();

  const firstPass = await runSongBuildPass({
    songId,
    topic,
    researchReport,
    totalCost,
    draftPayload: existingDraftPayload,
    passLabel: 'Magic Pass 1/2',
  });
  totalCost = firstPass.totalCost;

  if (isReleaseCandidate(firstPass.releaseSelectionResult)) {
    console.log(chalk.green('\n✓ First pass is already a release candidate'));
    await finalizeMagicPipelineSuccess({
      songId,
      topic,
      lyricsResult: firstPass.lyricsResult,
      metadata: firstPass.metadata,
      metadataPath: firstPass.metadataPath,
      brandReview: firstPass.brandReview,
      totalCost,
    });
  } else {
    const draftSong = getSong(songId) || {};
    const combinedRevisionBrief = buildReleaseSelectionRevisionBrief(
      draftSong,
      firstPass.brandReview.revision_notes || 'Improve the weakest release-selection dimensions while preserving the strongest hook.'
    );
    fs.writeFileSync(join(songDir, 'latest-regeneration-brief.md'), combinedRevisionBrief + '\n');

    console.log(chalk.yellow('\n↺ First pass did not clear the release threshold. Spending the single allowed regeneration.\n'));

    const secondPass = await runSongBuildPass({
      songId,
      topic,
      researchReport,
      totalCost,
      revisionNotes: combinedRevisionBrief,
      existingLyrics: firstPass.lyricsResult.lyricsText,
      passLabel: 'Magic Pass 2/2',
    });
    totalCost = secondPass.totalCost;

    if (isReleaseCandidate(secondPass.releaseSelectionResult)) {
      console.log(chalk.green('\n✓ Regenerated pass reached release-candidate status'));
      await finalizeMagicPipelineSuccess({
        songId,
        topic,
        lyricsResult: secondPass.lyricsResult,
        metadata: secondPass.metadata,
        metadataPath: secondPass.metadataPath,
        brandReview: secondPass.brandReview,
        totalCost,
      });
    } else {
      console.log(chalk.yellow('\n⚠ Magic pipeline stopped after the single allowed regeneration.'));
      console.log(chalk.yellow(`  Final recommendation: ${secondPass.releaseSelectionResult.recommendation.value} (${secondPass.releaseSelectionResult.recommendation.score}/100)`));
      console.log(chalk.yellow('  Marketing assets were not generated because the song did not clear the publish threshold.'));
      persistSongState({
        songId,
        topic,
        title: secondPass.lyricsResult.title,
        lyricsPath: secondPass.lyricsResult.lyricsPath,
        audioPromptPath: secondPass.lyricsResult.audioPromptPath,
        metadataPath: secondPass.metadataPath,
        brandScore: secondPass.brandReview.scores?.overall,
        totalCost,
      });
    }
  }

  await updateFinancialReport({
    songId,
    title: getSong(songId)?.title || topic,
    totalCost,
  });

  console.log(`\n${chalk.dim('Total pipeline cost:')} ${chalk.bold(formatCost(totalCost))}`);
  console.log(`${chalk.dim('Song ID:')} ${songId}\n`);
}

// ─────────────────────────────────────────────────────────────
// SUGGEST NEXT SONG
// ─────────────────────────────────────────────────────────────

async function suggestNextSong() {
  printBanner();
  console.log(chalk.bold.cyan(`SONG SUGGESTER — What should ${BRAND_NAME} make next?\n`));

  const suggestions = await runSuggestPipeline((msg) => console.log(msg));

  console.log(chalk.bold('\n🎵 Next Song Recommendations:\n'));
  for (const rec of suggestions.recommendations || []) {
    const urgencyColor = rec.urgency === 'trending' ? chalk.red : rec.urgency === 'seasonal' ? chalk.yellow : chalk.green;
    console.log(chalk.bold(`${rec.rank}. ${rec.title}`));
    console.log(`   Topic: ${chalk.cyan(rec.topic)}`);
    if (rec.why) console.log(`   ${rec.why}`);
    if (rec.hook_idea) console.log(`   Hook: ${chalk.italic(rec.hook_idea)}`);
    const detail = [rec.profile_specific_element, rec.bpm_target ? `${rec.bpm_target} BPM` : null, rec.urgency ? urgencyColor(rec.urgency) : null].filter(Boolean).join(' | ');
    if (detail) console.log(`   ${detail}`);
    console.log('');
  }

  if (suggestions.recommended_next) {
    console.log(chalk.bgCyan.black(' ▶ TOP PICK — run this command: '));
    console.log(chalk.bold(`\n  node src/orchestrator.js --new "${suggestions.recommended_next}"\n`));
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

  upsertSong({ ...song, status: SONG_STATUSES.DRAFT });
  console.log(chalk.green(`✓ Song ${songId} package approved; status kept as ${SONG_STATUSES.DRAFT}`));

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
      thumbnailDir: null,
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

  upsertSong({ ...song, status: SONG_STATUSES.DRAFT });
  console.log(chalk.red(`✗ Song ${songId} rejected. Status reset to ${SONG_STATUSES.DRAFT}. Reason: ${reason || 'none'}`));
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
    [SONG_STATUSES.DRAFT]: chalk.yellow,
    [SONG_STATUSES.EDITING]: chalk.cyan,
    [SONG_STATUSES.SUBMITTED_TO_DISTROKID]: chalk.magenta,
    [SONG_STATUSES.OUTREACH_COMPLETE]: chalk.green,
    [SONG_STATUSES.ARCHIVED]: chalk.gray,
  };

  console.log(chalk.bold('\nAll Songs:\n'));
  console.log(`${'ID'.padEnd(22)} ${'Title'.padEnd(30)} ${'Status'.padEnd(12)} ${'Score'.padEnd(6)} Cost`);
  console.log('─'.repeat(90));

  for (const song of songs) {
    const normalizedStatus = normalizeSongStatus(song.status);
    const color = statusColors[normalizedStatus] || chalk.white;
    console.log(
      `${song.id.padEnd(22)} ` +
      `${(song.title || '—').substring(0, 28).padEnd(30)} ` +
      `${color(getSongStatusLabel(normalizedStatus).padEnd(22))} ` +
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
      const { topic, existingSongId } = parseTopicArgs(args);
      await runNewSongPipeline(topic, existingSongId);
      break;
    }

    case '--magic': {
      const { topic, existingSongId } = parseTopicArgs(args);
      await runMagicPipeline(topic, existingSongId);
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
