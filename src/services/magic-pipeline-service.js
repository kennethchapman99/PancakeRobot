import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

import { upsertSong, getSong } from '../shared/db.js';
import { SONG_STATUSES } from '../shared/song-status.js';
import { formatCost } from '../shared/costs.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import { runResearcher, loadResearchReport } from '../agents/researcher.js';
import { reviewSong } from '../agents/brand-manager.js';
import { writeLyrics } from '../agents/lyricist.js';
import { generateMetadata } from '../agents/product-manager.js';
import { updateFinancialReport } from '../agents/financial-manager.js';
import { runQAChecklist, generateHumanTasks } from '../agents/ops-manager.js';
import { generateMusic } from '../agents/music-generator.js';
import { analyzeSongForReleaseSelection } from '../agents/release-selection-agent.js';
import { buildReleaseSelectionRevisionBrief } from '../lib/release-selection/regeneration-brief.js';
import { buildSongReleaseAssets } from '../shared/song-release-assets-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const APP_TITLE = BRAND_PROFILE.app_title || BRAND_NAME;
const DEFAULT_DISTRIBUTOR = BRAND_PROFILE.distribution.default_distributor;

export function createMagicSongId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SONG_${ts}_${rand}`;
}

export async function runMagicPipelineService({
  topic,
  existingSongId = null,
  mode = 'human_review',
  onEvent = null,
  logger = console,
} = {}) {
  const cleanTopic = String(topic || '').trim();
  if (!cleanTopic) throw new Error('Magic pipeline requires a topic');

  const emit = async (event) => {
    const normalized = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    if (typeof onEvent === 'function') await onEvent(normalized);
    return normalized;
  };

  printBanner(logger);
  logger.log(chalk.bold.magenta(`MAGIC PIPELINE — Topic: "${cleanTopic}"\n`));
  logger.log(chalk.dim('Flow: create → score → improve once if needed → build marketing assets only for release candidates\n'));

  const songId = existingSongId || createMagicSongId();
  const songDir = join(ROOT_DIR, `output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  const reuseExistingDraft = existingSongId && process.env.REGENERATE_FROM_EXISTING === '1';
  const existingDraftPayload = reuseExistingDraft ? loadExistingDraftPayload(songId, songDir) : null;
  let totalCost = 0;
  let finalPass = null;
  let finalized = null;

  upsertSong({
    id: songId,
    topic: cleanTopic,
    status: SONG_STATUSES.DRAFT,
    distributor: DEFAULT_DISTRIBUTOR,
    total_cost_usd: 0,
  });

  await emit({ type: 'pipeline_progress', stage: 'loading_research', line: 'Loading or refreshing research' });
  const researchReport = await loadFreshResearchReport({ logger, emit });

  const firstPass = await runSongBuildPass({
    songId,
    topic: cleanTopic,
    researchReport,
    totalCost,
    draftPayload: existingDraftPayload,
    passLabel: 'Magic Pass 1/2',
    logger,
    emit,
  });
  totalCost = firstPass.totalCost;

  if (isReleaseCandidate(firstPass.releaseSelectionResult)) {
    logger.log(chalk.green('\n✓ First pass is already a release candidate'));
    finalPass = firstPass;
    finalized = await finalizeMagicPipelineSuccess({
      songId,
      topic: cleanTopic,
      lyricsResult: firstPass.lyricsResult,
      metadata: firstPass.metadata,
      metadataPath: firstPass.metadataPath,
      brandReview: firstPass.brandReview,
      totalCost,
      logger,
      emit,
    });
  } else {
    const draftSong = getSong(songId) || {};
    const combinedRevisionBrief = buildReleaseSelectionRevisionBrief(
      draftSong,
      firstPass.brandReview.revision_notes || 'Improve the weakest release-selection dimensions while preserving the strongest hook.'
    );
    fs.writeFileSync(join(songDir, 'latest-regeneration-brief.md'), combinedRevisionBrief + '\n');

    logger.log(chalk.yellow('\n↺ First pass did not clear the release threshold. Spending the single allowed regeneration.\n'));
    await emit({ type: 'pipeline_progress', stage: 'regenerating_song', line: 'First pass missed release threshold; running one regeneration' });

    const secondPass = await runSongBuildPass({
      songId,
      topic: cleanTopic,
      researchReport,
      totalCost,
      revisionNotes: combinedRevisionBrief,
      existingLyrics: firstPass.lyricsResult.lyricsText,
      passLabel: 'Magic Pass 2/2',
      logger,
      emit,
    });
    totalCost = secondPass.totalCost;
    finalPass = secondPass;

    if (isReleaseCandidate(secondPass.releaseSelectionResult)) {
      logger.log(chalk.green('\n✓ Second pass cleared the release threshold'));
      finalized = await finalizeMagicPipelineSuccess({
        songId,
        topic: cleanTopic,
        lyricsResult: secondPass.lyricsResult,
        metadata: secondPass.metadata,
        metadataPath: secondPass.metadataPath,
        brandReview: secondPass.brandReview,
        totalCost,
        logger,
        emit,
      });
    } else {
      logger.log(chalk.yellow('\n⚠ Second pass still did not clear the release threshold. Keeping draft for human review.\n'));
      await emit({ type: 'pipeline_progress', stage: 'needs_human_review', line: 'Second pass did not clear release threshold; draft kept for review' });
      persistSongState({
        songId,
        topic: cleanTopic,
        title: secondPass.lyricsResult.title,
        lyricsPath: secondPass.lyricsResult.lyricsPath,
        audioPromptPath: secondPass.lyricsResult.audioPromptPath,
        metadataPath: secondPass.metadataPath,
        brandScore: secondPass.brandReview.scores?.overall,
        totalCost,
        extra: {
          pipeline_stage: 'magic_needs_human_review',
        },
      });
    }
  }

  if (finalPass?.lyricsResult?.title) {
    await updateFinancialReport({ songId, title: finalPass.lyricsResult.title, totalCost });
  }

  const recommendation = finalPass?.releaseSelectionResult?.recommendation || {};
  const result = {
    songId,
    title: finalPass?.lyricsResult?.title || cleanTopic,
    topic: cleanTopic,
    mode,
    totalCost,
    recommendation,
    status: mapRecommendationToStatus(recommendation.value),
    releaseCandidate: recommendation.value === 'recommend_to_publish',
    finalized: Boolean(finalized),
    distDir: finalized?.distDir || null,
    marketingDashboardUrl: finalized?.marketingResult?.dashboardUrl || null,
  };

  logger.log(`\n${chalk.dim('Total pipeline cost:')} ${chalk.bold(formatCost(totalCost))}`);
  logger.log(`${chalk.dim('Song ID:')} ${songId}\n`);
  await emit({ type: 'pipeline_progress', stage: 'done', line: 'Magic pipeline service complete', result });

  return result;
}

function printBanner(logger) {
  logger.log(chalk.bgYellow.black('\n ══════════════════════════════════════════ '));
  logger.log(chalk.bgYellow.black(` ${APP_TITLE.toUpperCase()} — Autonomous Music Pipeline `));
  logger.log(chalk.bgYellow.black(' ══════════════════════════════════════════ \n'));
}

async function loadFreshResearchReport({ logger, emit }) {
  let researchReport = loadResearchReport(30);
  if (!researchReport) {
    logger.log(chalk.bold('\n📌 Step 1: Running researcher (research is >30 days old)...\n'));
    researchReport = await runResearcher();
  } else {
    logger.log(chalk.green('✓ Using cached research report\n'));
  }
  await emit({ type: 'pipeline_progress', stage: 'research_ready', line: 'Research ready' });
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
  logger,
  emit,
}) {
  let lyricsResult;

  if (draftPayload) {
    logger.log(chalk.bold(`\n📌 ${passLabel}: Reusing current lyrics and audio prompt...\n`));
    lyricsResult = draftPayload;
    logger.log(chalk.green(`✓ Reusing current draft: ${lyricsResult.title}`));
  } else {
    await emit({ type: 'pipeline_progress', stage: 'writing_song_brief', line: `${passLabel}: Writing lyrics` });
    logger.log(chalk.bold(`\n📌 ${passLabel}: Writing lyrics...\n`));
    lyricsResult = await writeLyrics({
      songId,
      topic,
      researchReport,
      revisionNotes,
      existingLyrics,
    });
    totalCost += lyricsResult.costUsd || 0;
  }

  await emit({ type: 'pipeline_progress', stage: 'brand_review', line: `${passLabel}: Brand review` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Brand review...\n`));
  const brandReview = await reviewSong({
    songId,
    title: lyricsResult.title,
    topic,
    lyricsText: lyricsResult.lyricsText,
    audioPromptText: lyricsResult.audioPromptText,
  });
  totalCost += brandReview.costUsd || 0;
  logger.log(`\nBrand Score: ${chalk.bold(brandReview.scores?.overall || 0)}/100`);

  persistSongState({
    songId,
    topic,
    title: lyricsResult.title,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    brandScore: brandReview.scores?.overall,
    totalCost,
  });

  await emit({ type: 'pipeline_progress', stage: 'generating_metadata', line: `${passLabel}: Generating metadata` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Generating metadata...\n`));
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

  await emit({ type: 'pipeline_progress', stage: 'generating_audio', line: `${passLabel}: Generating audio` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Generating music...\n`));
  const musicResult = await generateMusic({
    songId,
    title: lyricsResult.title,
    lyricsText: lyricsResult.lyricsText,
    audioPromptData: lyricsResult.songData?.audio_prompt,
  });

  if (musicResult.audioFiles?.length > 0) {
    logger.log(chalk.green(`✓ Music generated: ${musicResult.audioFiles.length} version(s)`));
  } else if (musicResult.skipped || musicResult.apiError) {
    logger.log(chalk.yellow('⚠ Music generation skipped — manual instructions saved to audio/MUSIC_GENERATION_INSTRUCTIONS.md'));
    if (musicResult.apiError) {
      logger.log(chalk.dim(`  API error: ${musicResult.apiError.substring(0, 120)}`));
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

  await emit({ type: 'pipeline_progress', stage: 'scoring_song', line: `${passLabel}: Running release selection analysis` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Running release selection analysis...\n`));
  const releaseSelectionResult = await analyzeSongForReleaseSelection(songId);
  logger.log(chalk.green(`✓ Release recommendation: ${releaseSelectionResult.recommendation.value} (${releaseSelectionResult.recommendation.score}/100)`));

  await emit({ type: 'pipeline_progress', stage: 'qa_checklist', line: `${passLabel}: Running QA checklist` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Running QA checklist...\n`));
  const songDir = join(ROOT_DIR, `output/songs/${songId}`);
  const qaReport = runQAChecklist({
    songId,
    songDir,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    brandReview,
    metadata,
  });

  if (qaReport.warnings.length > 0) {
    logger.log(chalk.yellow('\n⚠ QA Warnings:'));
    qaReport.warnings.forEach(w => logger.log(chalk.yellow(`  • ${w}`)));
  }
  if (qaReport.passed) {
    logger.log(chalk.green('\n✓ QA passed — all checks green\n'));
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
  logger,
  emit,
}) {
  await emit({ type: 'pipeline_progress', stage: 'building_distribution_package', line: 'Building distribution package' });
  logger.log(chalk.bold('\n📌 Magic Finalize: Building distribution package...\n'));
  const songDir = join(ROOT_DIR, `output/songs/${songId}`);
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

  await emit({ type: 'pipeline_progress', stage: 'creating_release_assets', line: 'Building marketing assets' });
  logger.log(chalk.bold('\n📌 Magic Finalize: Building marketing assets...\n'));
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
    extra: {
      pipeline_stage: 'magic_ready',
    },
  });

  logger.log(chalk.bgGreen.black('\n ✓ MAGIC PIPELINE READY \n'));
  logger.log(`  Distribution package: ${chalk.bold(distDir)}`);
  if (marketingResult.dashboardUrl) {
    logger.log(`  Marketing dashboard: ${chalk.bold(marketingResult.dashboardUrl)}`);
  }
  if (marketingResult.qaWarnings?.length) {
    logger.log(chalk.yellow('\n  Marketing warnings:'));
    marketingResult.qaWarnings.forEach(warning => logger.log(chalk.yellow(`  • ${warning}`)));
  }

  return { distDir, marketingResult };
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

function mapRecommendationToStatus(value) {
  if (value === 'recommend_to_publish') return 'recommended_to_publish';
  if (value === 'recommend_to_archive') return 'recommended_to_archive';
  return 'draft';
}
