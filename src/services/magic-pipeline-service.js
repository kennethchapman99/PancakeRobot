import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

import { upsertSong, getSong } from '../shared/db.js';
import { SONG_STATUSES } from '../shared/song-status.js';
import { formatCost } from '../shared/costs.js';
import {
  clearBrandProfileCache,
  DEFAULT_PROFILE_ID,
  loadBrandProfileById,
  resolveBrandProfilePath,
} from '../shared/brand-profile.js';
import { buildReleaseSelectionRevisionBrief } from '../lib/release-selection/regeneration-brief.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');

let magicRunQueue = Promise.resolve();

export const MAGIC_PIPELINE_STAGES = Object.freeze({
  SONG_ONLY: 'song_only',
  FULL: 'full',
});

export function normalizeMagicPipelineStage(value = process.env.MAGIC_PIPELINE_STAGE || process.env.MAGIC_SONG_PIPELINE_STAGE || MAGIC_PIPELINE_STAGES.SONG_ONLY) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === MAGIC_PIPELINE_STAGES.FULL) return MAGIC_PIPELINE_STAGES.FULL;
  if (['song', 'song-only', 'song_only', 'audio', 'audio_only', 'create_song'].includes(normalized)) return MAGIC_PIPELINE_STAGES.SONG_ONLY;
  return MAGIC_PIPELINE_STAGES.SONG_ONLY;
}

export function createMagicSongId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SONG_${ts}_${rand}`;
}

export async function runMagicPipelineService(args = {}) {
  const run = magicRunQueue.then(
    () => runMagicPipelineServiceInner(args),
    () => runMagicPipelineServiceInner(args)
  );
  magicRunQueue = run.catch(() => {});
  return run;
}

async function runMagicPipelineServiceInner({
  topic,
  existingSongId = null,
  brandId = process.env.DEFAULT_BRAND_ID || DEFAULT_PROFILE_ID,
  mode = 'human_review',
  pipelineStage = process.env.MAGIC_PIPELINE_STAGE || process.env.MAGIC_SONG_PIPELINE_STAGE || MAGIC_PIPELINE_STAGES.SONG_ONLY,
  allowRegeneration = false,
  onEvent = null,
  logger = console,
} = {}) {
  const cleanTopic = String(topic || '').trim();
  if (!cleanTopic) throw new Error('Magic pipeline requires a topic');

  const cleanPipelineStage = normalizeMagicPipelineStage(pipelineStage);
  const songOnlyGate = cleanPipelineStage === MAGIC_PIPELINE_STAGES.SONG_ONLY;
  const cleanBrandId = String(brandId || DEFAULT_PROFILE_ID).trim();
  const brandProfilePath = resolveBrandProfilePath(cleanBrandId);
  const brandProfile = loadBrandProfileById(cleanBrandId);
  const defaultDistributor = brandProfile.distribution?.default_distributor || null;
  const appTitle = brandProfile.app_title || brandProfile.brand_name || 'Music Pipeline';
  const runToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const previousBrandProfilePath = process.env.BRAND_PROFILE_PATH;

  process.env.BRAND_PROFILE_PATH = brandProfilePath;
  clearBrandProfileCache();

  try {
    const modules = await loadBrandScopedModules(runToken);
    const emit = async (event) => {
      const normalized = {
        timestamp: new Date().toISOString(),
        ...event,
      };
      if (typeof onEvent === 'function') await onEvent(normalized);
      return normalized;
    };

    printBanner(logger, appTitle);
    logger.log(chalk.bold.magenta(`MAGIC PIPELINE — Topic: "${cleanTopic}"\n`));
    logger.log(chalk.dim(songOnlyGate
      ? 'Flow: create song/audio only → stop for human review before scoring, packaging, release assets, social, or publishing\n'
      : 'Flow: create → score advisory → improve once if useful → finalize usable generated songs for human review\n'
    ));

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
      distributor: defaultDistributor,
      total_cost_usd: 0,
      brand_profile_id: cleanBrandId,
      pipeline_stage: songOnlyGate ? 'magic_song_requested_song_only' : 'magic_full_requested',
    });

    await emit({ type: 'pipeline_progress', stage: 'loading_research', line: 'Loading or refreshing research' });
    const researchReport = await loadFreshResearchReport({ logger, emit, modules });

    const firstPass = await runSongBuildPass({
      songId,
      topic: cleanTopic,
      researchReport,
      totalCost,
      draftPayload: existingDraftPayload,
      passLabel: songOnlyGate ? 'Magic Song-Only Pass' : 'Magic Pass 1/2',
      stopAfterAudio: songOnlyGate,
      logger,
      emit,
      modules,
      brandId: cleanBrandId,
    });
    totalCost = firstPass.totalCost;

    if (songOnlyGate) {
      finalPass = firstPass;
      await modules.updateFinancialReport({ songId, title: firstPass.lyricsResult.title, totalCost });
      persistSongState({
        songId,
        topic: cleanTopic,
        title: firstPass.lyricsResult.title,
        lyricsPath: firstPass.lyricsResult.lyricsPath,
        audioPromptPath: firstPass.lyricsResult.audioPromptPath,
        metadataPath: firstPass.metadataPath,
        brandScore: firstPass.brandReview.scores?.overall,
        totalCost,
        extra: {
          brand_profile_id: cleanBrandId,
          pipeline_stage: 'magic_song_created_pending_review',
        },
      });

      const result = buildMagicPipelineResult({
        songId,
        title: firstPass.lyricsResult.title,
        topic: cleanTopic,
        brandId: cleanBrandId,
        brandName: brandProfile.brand_name || cleanBrandId,
        mode,
        pipelineStage: cleanPipelineStage,
        totalCost,
        finalPass,
        finalized: null,
        status: 'song_created_pending_review',
        awaitingHumanApproval: true,
        nextAction: 'Review the generated song/audio. To build scoring, distribution package, release kit, marketing assets, social, and publish prep, rerun with MAGIC_PIPELINE_STAGE=full or pass --stage full.',
      });

      logger.log(chalk.bgYellow.black('\n ✓ SONG CREATED — GATED BEFORE RELEASE PIPELINE \n'));
      logger.log(chalk.dim('  No scorer regeneration, distribution package, release kit, marketing assets, social assets, or publishing ran.'));
      logger.log(`\n${chalk.dim('Total song creation cost:')} ${chalk.bold(formatCost(totalCost))}`);
      logger.log(`${chalk.dim('Song ID:')} ${songId}\n`);
      await emit({ type: 'pipeline_progress', stage: 'song_created_pending_review', line: 'Song/audio created; waiting for human approval before downstream release pipeline', result });
      await emit({ type: 'pipeline_progress', stage: 'done', line: 'Magic song-only pipeline complete', result });
      return result;
    }

    if (isAssetCandidate(firstPass.releaseSelectionResult)) {
      logger.log(chalk.green(assetCandidateMessage(firstPass.releaseSelectionResult, 'First pass')));
      finalPass = firstPass;
      finalized = await finalizeMagicPipelineSuccess({
        songId,
        topic: cleanTopic,
        lyricsResult: firstPass.lyricsResult,
        metadata: firstPass.metadata,
        metadataPath: firstPass.metadataPath,
        brandReview: firstPass.brandReview,
        releaseSelectionResult: firstPass.releaseSelectionResult,
        totalCost,
        logger,
        emit,
        modules,
        brandId: cleanBrandId,
      });
    } else {
      const draftSong = getSong(songId) || {};
      const combinedRevisionBrief = buildReleaseSelectionRevisionBrief(
        draftSong,
        firstPass.brandReview.revision_notes || 'Improve the weakest release-selection dimensions while preserving the strongest hook.'
      );
      fs.writeFileSync(join(songDir, 'latest-regeneration-brief.md'), combinedRevisionBrief + '\n');

      if (!allowRegeneration) {
        logger.log(chalk.yellow('\n⚠ Scorer recommended improvement, but one_take policy is active (allowRegeneration=false). Finalizing first pass. Pass allowRegeneration=true to permit a second music generation.\n'));
        await emit({ type: 'pipeline_progress', stage: 'advisory_score_skipped_regeneration', line: 'Scorer advisory; regeneration disabled by one_take policy — finalizing first pass' });
        finalPass = firstPass;
        if (hasGeneratedAudio(firstPass)) {
          finalized = await finalizeMagicPipelineSuccess({
            songId,
            topic: cleanTopic,
            lyricsResult: firstPass.lyricsResult,
            metadata: firstPass.metadata,
            metadataPath: firstPass.metadataPath,
            brandReview: firstPass.brandReview,
            releaseSelectionResult: firstPass.releaseSelectionResult,
            totalCost,
            logger,
            emit,
            modules,
            brandId: cleanBrandId,
          });
        } else {
          logger.log(chalk.yellow('\n⚠ No generated audio from first pass. Keeping draft for manual audio generation/review.\n'));
          await emit({ type: 'pipeline_progress', stage: 'needs_audio_review', line: 'No generated audio from first pass; draft kept for manual audio generation/review' });
          persistSongState({
            songId,
            topic: cleanTopic,
            title: firstPass.lyricsResult.title,
            lyricsPath: firstPass.lyricsResult.lyricsPath,
            audioPromptPath: firstPass.lyricsResult.audioPromptPath,
            metadataPath: firstPass.metadataPath,
            brandScore: firstPass.brandReview.scores?.overall,
            totalCost,
            extra: {
              brand_profile_id: cleanBrandId,
              pipeline_stage: 'magic_needs_audio_review',
            },
          });
        }
      } else {
        logger.log(chalk.yellow('\n↺ First pass scorer recommendation suggested another iteration. Spending the single allowed regeneration.\n'));
        await emit({ type: 'pipeline_progress', stage: 'regenerating_song', line: 'First pass scorer recommendation suggested another iteration; running one regeneration' });

        const secondPass = await runSongBuildPass({
          songId,
          topic: cleanTopic,
          researchReport,
          totalCost,
          revisionNotes: combinedRevisionBrief,
          existingLyrics: firstPass.lyricsResult.lyricsText,
          passLabel: 'Magic Pass 2/2',
          forceRegenerate: true,
          logger,
          emit,
          modules,
          brandId: cleanBrandId,
        });
        totalCost = secondPass.totalCost;
        finalPass = secondPass;

        if (isAssetCandidate(secondPass.releaseSelectionResult)) {
          logger.log(chalk.green(assetCandidateMessage(secondPass.releaseSelectionResult, 'Second pass')));
          finalized = await finalizeMagicPipelineSuccess({
            songId,
            topic: cleanTopic,
            lyricsResult: secondPass.lyricsResult,
            metadata: secondPass.metadata,
            metadataPath: secondPass.metadataPath,
            brandReview: secondPass.brandReview,
            releaseSelectionResult: secondPass.releaseSelectionResult,
            totalCost,
            logger,
            emit,
            modules,
            brandId: cleanBrandId,
          });
        } else if (hasGeneratedAudio(secondPass)) {
          logger.log(chalk.yellow('\n⚠ Second pass still received a conservative scorer recommendation. Finalizing generated song anyway; scorer is advisory only.\n'));
          await emit({ type: 'pipeline_progress', stage: 'finalizing_advisory_song', line: 'Second pass kept a conservative scorer recommendation; finalizing generated song for human review anyway' });
          finalized = await finalizeMagicPipelineSuccess({
            songId,
            topic: cleanTopic,
            lyricsResult: secondPass.lyricsResult,
            metadata: secondPass.metadata,
            metadataPath: secondPass.metadataPath,
            brandReview: secondPass.brandReview,
            releaseSelectionResult: secondPass.releaseSelectionResult,
            totalCost,
            logger,
            emit,
            modules,
            brandId: cleanBrandId,
          });
        } else {
          logger.log(chalk.yellow('\n⚠ No generated audio was available to finalize. Keeping draft for manual audio generation/review.\n'));
          await emit({ type: 'pipeline_progress', stage: 'needs_audio_review', line: 'No generated audio was available; draft kept for manual audio generation/review' });
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
              brand_profile_id: cleanBrandId,
              pipeline_stage: 'magic_needs_audio_review',
            },
          });
        }
      }
    }

    if (finalPass?.lyricsResult?.title) {
      await modules.updateFinancialReport({ songId, title: finalPass.lyricsResult.title, totalCost });
    }

    const result = buildMagicPipelineResult({
      songId,
      title: finalPass?.lyricsResult?.title || cleanTopic,
      topic: cleanTopic,
      brandId: cleanBrandId,
      brandName: brandProfile.brand_name || cleanBrandId,
      mode,
      pipelineStage: cleanPipelineStage,
      totalCost,
      finalPass,
      finalized,
      status: null,
      awaitingHumanApproval: false,
      nextAction: null,
    });

    logger.log(`\n${chalk.dim('Total pipeline cost:')} ${chalk.bold(formatCost(totalCost))}`);
    logger.log(`${chalk.dim('Song ID:')} ${songId}\n`);
    await emit({ type: 'pipeline_progress', stage: 'done', line: 'Magic pipeline service complete', result });

    return result;
  } finally {
    if (previousBrandProfilePath === undefined) delete process.env.BRAND_PROFILE_PATH;
    else process.env.BRAND_PROFILE_PATH = previousBrandProfilePath;
    clearBrandProfileCache();
  }
}

async function loadBrandScopedModules(runToken) {
  const qs = encodeURIComponent(runToken);
  const [
    researcher,
    brandManager,
    lyricist,
    productManager,
    financialManager,
    opsManager,
    musicGenerator,
    releaseSelectionAgent,
    songReleaseAssetsService,
  ] = await Promise.all([
    import(`../agents/researcher.js?magicRun=${qs}`),
    import(`../agents/brand-manager.js?magicRun=${qs}`),
    import(`../agents/lyricist.js?magicRun=${qs}`),
    import(`../agents/product-manager.js?magicRun=${qs}`),
    import(`../agents/financial-manager.js?magicRun=${qs}`),
    import(`../agents/ops-manager.js?magicRun=${qs}`),
    import(`../agents/music-generator.js?magicRun=${qs}`),
    import(`../agents/release-selection-agent.js?magicRun=${qs}`),
    import(`../shared/song-release-assets-service.js?magicRun=${qs}`),
  ]);

  return {
    runResearcher: researcher.runResearcher,
    loadResearchReport: researcher.loadResearchReport,
    reviewSong: brandManager.reviewSong,
    writeLyrics: lyricist.writeLyrics,
    generateMetadata: productManager.generateMetadata,
    updateFinancialReport: financialManager.updateFinancialReport,
    runQAChecklist: opsManager.runQAChecklist,
    generateHumanTasks: opsManager.generateHumanTasks,
    generateMusic: musicGenerator.generateMusic,
    analyzeSongForReleaseSelection: releaseSelectionAgent.analyzeSongForReleaseSelection,
    buildSongReleaseAssets: songReleaseAssetsService.buildSongReleaseAssets,
  };
}

function printBanner(logger, appTitle) {
  logger.log(chalk.bgYellow.black('\n ══════════════════════════════════════════ '));
  logger.log(chalk.bgYellow.black(` ${String(appTitle || 'Music Pipeline').toUpperCase()} — Autonomous Music Pipeline `));
  logger.log(chalk.bgYellow.black(' ══════════════════════════════════════════ \n'));
}

async function loadFreshResearchReport({ logger, emit, modules }) {
  let researchReport = modules.loadResearchReport(30);
  if (!researchReport) {
    logger.log(chalk.bold('\n📌 Step 1: Running researcher (research is >30 days old)...\n'));
    researchReport = await modules.runResearcher();
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
  stopAfterAudio = false,
  forceRegenerate = false,
  logger,
  emit,
  modules,
  brandId,
}) {
  let lyricsResult;

  if (draftPayload) {
    logger.log(chalk.bold(`\n📌 ${passLabel}: Reusing current lyrics and audio prompt...\n`));
    lyricsResult = draftPayload;
    logger.log(chalk.green(`✓ Reusing current draft: ${lyricsResult.title}`));
  } else {
    await emit({ type: 'pipeline_progress', stage: 'writing_song_brief', line: `${passLabel}: Writing lyrics` });
    logger.log(chalk.bold(`\n📌 ${passLabel}: Writing lyrics...\n`));
    lyricsResult = await modules.writeLyrics({
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
  const brandReview = await modules.reviewSong({
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
    extra: { brand_profile_id: brandId },
  });

  await emit({ type: 'pipeline_progress', stage: 'generating_metadata', line: `${passLabel}: Generating metadata` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Generating metadata...\n`));
  const { metadata, metadataPath } = await modules.generateMetadata({
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
    extra: { brand_profile_id: brandId },
  });

  await emit({ type: 'pipeline_progress', stage: 'generating_audio', line: `${passLabel}: Generating audio` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Generating music...\n`));
  const musicResult = await modules.generateMusic({
    songId,
    title: lyricsResult.title,
    lyricsText: lyricsResult.lyricsText,
    audioPromptData: lyricsResult.songData?.audio_prompt,
    forceRegenerate,
  });

  if (musicResult.audioFiles?.length > 0) {
    const reuseNote = musicResult.skipped_existing_audio ? ' (reused existing)' : '';
    logger.log(chalk.green(`✓ Music generated: ${musicResult.audioFiles.length} audio file(s)${reuseNote}`));
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
    extra: { brand_profile_id: brandId },
  });

  if (stopAfterAudio) {
    await emit({ type: 'pipeline_progress', stage: 'song_created_pending_review', line: `${passLabel}: Song/audio created; release pipeline gate is closed` });
    logger.log(chalk.bgYellow.black('\n ⏸ SONG-ONLY GATE REACHED \n'));
    logger.log(chalk.dim('  Stopping before advisory scorer, regeneration, QA checklist, distribution package, release kit, marketing assets, social, or publishing.'));
    return {
      lyricsResult,
      brandReview,
      metadata,
      metadataPath,
      musicResult,
      releaseSelectionResult: null,
      qaReport: null,
      totalCost,
      stoppedAfterAudio: true,
    };
  }

  await emit({ type: 'pipeline_progress', stage: 'scoring_song', line: `${passLabel}: Running advisory scorer` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Running advisory scorer...\n`));
  const releaseSelectionResult = await modules.analyzeSongForReleaseSelection(songId);
  logger.log(chalk.green(`✓ Scorer recommendation: ${releaseSelectionResult.recommendation.value} (${releaseSelectionResult.recommendation.score}/100)`));

  await emit({ type: 'pipeline_progress', stage: 'qa_checklist', line: `${passLabel}: Running QA checklist` });
  logger.log(chalk.bold(`\n📌 ${passLabel}: Running QA checklist...\n`));
  const songDir = join(ROOT_DIR, `output/songs/${songId}`);
  const qaReport = modules.runQAChecklist({
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
  releaseSelectionResult,
  totalCost,
  logger,
  emit,
  modules,
  brandId,
}) {
  const releaseCandidate = isReleaseCandidate(releaseSelectionResult);
  const songDir = join(ROOT_DIR, `output/songs/${songId}`);
  let distDir = null;

  await emit({ type: 'pipeline_progress', stage: 'building_distribution_package', line: 'Building distribution package for human review' });
  logger.log(chalk.bold('\n📌 Magic Finalize: Building distribution package...\n'));
  if (!releaseCandidate) {
    logger.log(chalk.yellow('  Scorer recommendation is advisory only; building package so the human can listen, download, review, and override.'));
  }
  const distributionPackage = await modules.generateHumanTasks({
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
  distDir = distributionPackage.distDir;

  await emit({ type: 'pipeline_progress', stage: 'creating_release_assets', line: 'Building marketing assets' });
  logger.log(chalk.bold('\n📌 Magic Finalize: Building marketing assets...\n'));
  const marketingResult = await modules.buildSongReleaseAssets(songId, {
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
      brand_profile_id: brandId,
      pipeline_stage: releaseCandidate ? 'magic_ready' : 'magic_assets_ready_advisory_review',
    },
  });

  logger.log(chalk.bgGreen.black('\n ✓ MAGIC PIPELINE READY \n'));
  if (distDir) {
    logger.log(`  Distribution package: ${chalk.bold(distDir)}`);
  }
  if (!releaseCandidate) {
    logger.log(chalk.dim('  Release scorer: advisory recommendation only; human override remains available'));
  }
  if (marketingResult.dashboardUrl) {
    logger.log(`  Marketing dashboard: ${chalk.bold(marketingResult.dashboardUrl)}`);
  }
  if (marketingResult.qaWarnings?.length) {
    logger.log(chalk.yellow('\n  Marketing warnings:'));
    marketingResult.qaWarnings.forEach(warning => logger.log(chalk.yellow(`  • ${warning}`)));
  }

  return { distDir, marketingResult };
}

function buildMagicPipelineResult({
  songId,
  title,
  topic,
  brandId,
  brandName,
  mode,
  pipelineStage,
  totalCost,
  finalPass,
  finalized,
  status = null,
  awaitingHumanApproval = false,
  nextAction = null,
}) {
  const recommendation = finalPass?.releaseSelectionResult?.recommendation || {};
  return {
    songId,
    title,
    topic,
    brandId,
    brandName,
    mode,
    pipelineStage,
    totalCost,
    recommendation,
    status: status || mapRecommendationToStatus(recommendation.value),
    releaseCandidate: recommendation.value === 'recommend_to_publish',
    assetCandidate: pipelineStage === MAGIC_PIPELINE_STAGES.FULL ? shouldFinalizeGeneratedSong(finalPass) : false,
    finalized: Boolean(finalized),
    distDir: finalized?.distDir || null,
    marketingDashboardUrl: finalized?.marketingResult?.dashboardUrl || null,
    awaitingHumanApproval,
    nextAction,
  };
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

function isAssetCandidate(releaseSelectionResult) {
  const recommendation = releaseSelectionResult?.recommendation || {};
  return isReleaseCandidate(releaseSelectionResult)
    || recommendation.recommended_release_treatment === 'social_only'
    || recommendation.recommended_asset_strategy === 'social_clip_pack';
}

function shouldFinalizeGeneratedSong(pass) {
  return hasGeneratedAudio(pass);
}

function hasGeneratedAudio(pass) {
  return Array.isArray(pass?.musicResult?.audioFiles) && pass.musicResult.audioFiles.length > 0;
}

function assetCandidateMessage(releaseSelectionResult, passLabel) {
  return isReleaseCandidate(releaseSelectionResult)
    ? `\n✓ ${passLabel} received a publish recommendation`
    : `\n✓ ${passLabel} received a social-asset recommendation`;
}

function mapRecommendationToStatus(value) {
  if (value === 'recommend_to_publish') return 'recommended_to_publish';
  if (value === 'recommend_to_archive') return 'recommended_to_archive';
  return 'draft';
}
