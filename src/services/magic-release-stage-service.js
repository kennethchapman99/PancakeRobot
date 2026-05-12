import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

import { getSong, upsertSong } from '../shared/db.js';
import { SONG_STATUSES } from '../shared/song-status.js';
import { formatCost } from '../shared/costs.js';
import {
  clearBrandProfileCache,
  DEFAULT_PROFILE_ID,
  loadBrandProfileById,
  resolveBrandProfilePath,
} from '../shared/brand-profile.js';
import { createOrRefreshDailySocialCampaign } from '../agents/daily-social-planner-agent.js';
import { ensureYouTubeVideoAsset } from '../shared/social/youtube-video-builder.js';
import { getSocialPostsByCampaignId, updateSocialPost } from '../shared/social-publishing-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');

export function normalizeReleaseStageOptions(options = {}) {
  const rawPlatforms = Array.isArray(options.platforms)
    ? options.platforms
    : String(options.platforms || process.env.RELEASE_STAGE_SOCIAL_PLATFORMS || process.env.DAILY_SOCIAL_PLATFORMS || 'instagram,facebook,youtube')
        .split(',');

  return {
    buildSocialCampaign: options.buildSocialCampaign !== false && String(process.env.RELEASE_STAGE_BUILD_SOCIAL_CAMPAIGN || 'true').toLowerCase() !== 'false',
    platforms: [...new Set(rawPlatforms.map(platform => String(platform || '').trim().toLowerCase()).filter(Boolean))],
    forceSocialCampaign: options.forceSocialCampaign !== false,
    renderYouTubeVideo: options.renderYouTubeVideo !== false,
    renderVideos: options.renderVideos === true,
  };
}

export async function runMagicReleaseStageService({
  songId,
  brandId = null,
  platforms = null,
  buildSocialCampaign = true,
  forceSocialCampaign = true,
  renderYouTubeVideo = true,
  logger = console,
  onEvent = null,
} = {}) {
  const cleanSongId = String(songId || '').trim();
  if (!cleanSongId) throw new Error('Release stage requires --id SONG_ID');

  const song = getSong(cleanSongId);
  if (!song) throw new Error(`Song not found: ${cleanSongId}`);

  const cleanBrandId = String(brandId || song.brand_profile_id || process.env.DEFAULT_BRAND_ID || DEFAULT_PROFILE_ID).trim();
  const brandProfilePath = resolveBrandProfilePath(cleanBrandId);
  const brandProfile = loadBrandProfileById(cleanBrandId);
  const previousBrandProfilePath = process.env.BRAND_PROFILE_PATH;
  const runToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const options = normalizeReleaseStageOptions({ platforms, buildSocialCampaign, forceSocialCampaign, renderYouTubeVideo });

  process.env.BRAND_PROFILE_PATH = brandProfilePath;
  clearBrandProfileCache();

  try {
    const modules = await loadBrandScopedReleaseModules(runToken);
    const emit = async (event) => {
      const normalized = { timestamp: new Date().toISOString(), ...event };
      if (typeof onEvent === 'function') await onEvent(normalized);
      return normalized;
    };

    const songDir = join(ROOT_DIR, 'output', 'songs', cleanSongId);
    const lyricsPath = resolveSongFilePath(song.lyrics_path, songDir, ['lyrics.md', 'lyrics-clean.txt']);
    const audioPromptPath = resolveSongFilePath(song.audio_prompt_path, songDir, ['audio-prompt.md']);
    const metadataPath = resolveSongFilePath(song.metadata_path, songDir, ['metadata.json']);
    const lyricsText = readText(lyricsPath);
    const audioPromptText = readText(audioPromptPath);
    const metadata = readJson(metadataPath) || {};

    if (!lyricsPath || !lyricsText) throw new Error(`Release stage cannot continue: lyrics not found for ${cleanSongId}`);
    if (!audioPromptPath || !audioPromptText) throw new Error(`Release stage cannot continue: audio prompt not found for ${cleanSongId}`);
    if (!metadataPath) throw new Error(`Release stage cannot continue: metadata.json not found for ${cleanSongId}`);

    logger.log(chalk.bold.magenta(`RELEASE STAGE — Song: ${cleanSongId}\n`));
    logger.log(chalk.dim('Flow: use existing song/audio → score → QA → distribution package → release assets → social drafts; no music regeneration and no live publishing\n'));

    await emit({ type: 'release_stage_progress', stage: 'brand_review', line: 'Reviewing existing song against brand profile' });
    const brandReview = await modules.reviewSong({
      songId: cleanSongId,
      title: song.title || metadata.title || song.topic || cleanSongId,
      topic: song.topic || metadata.title || cleanSongId,
      lyricsText,
      audioPromptText,
    });
    const totalCost = Number(song.total_cost_usd || 0) + Number(brandReview.costUsd || 0);

    upsertSong({
      id: cleanSongId,
      status: SONG_STATUSES.DRAFT,
      brand_score: brandReview.scores?.overall,
      total_cost_usd: totalCost,
      brand_profile_id: cleanBrandId,
      pipeline_stage: 'release_stage_brand_review_complete',
    });

    await emit({ type: 'release_stage_progress', stage: 'scoring_song', line: 'Running advisory release-selection scorer' });
    const releaseSelectionResult = await modules.analyzeSongForReleaseSelection(cleanSongId);
    const recommendation = releaseSelectionResult.recommendation || {};
    logger.log(chalk.green(`✓ Scorer recommendation: ${recommendation.value || 'unknown'} (${recommendation.score ?? 'n/a'}/100)`));

    await emit({ type: 'release_stage_progress', stage: 'qa_checklist', line: 'Running QA checklist' });
    const qaReport = modules.runQAChecklist({
      songId: cleanSongId,
      songDir,
      lyricsPath,
      audioPromptPath,
      brandReview,
      metadata,
    });

    await emit({ type: 'release_stage_progress', stage: 'building_distribution_package', line: 'Building distribution package for human review' });
    const distributionPackage = await modules.generateHumanTasks({
      songId: cleanSongId,
      title: song.title || metadata.title || cleanSongId,
      topic: song.topic || metadata.title || cleanSongId,
      songDir,
      metadata,
      lyricsPath,
      audioPromptPath,
      brandScore: brandReview.scores?.overall,
      totalCost,
    });

    await emit({ type: 'release_stage_progress', stage: 'creating_release_assets', line: 'Building release-kit and marketing assets' });
    const marketingResult = await modules.buildSongReleaseAssets(cleanSongId, {
      mode: 'render_from_existing_visuals',
      renderVideos: options.renderVideos,
    });

    let socialCampaignResult = null;
    let youtubeVideoAsset = null;
    if (options.buildSocialCampaign) {
      await emit({ type: 'release_stage_progress', stage: 'creating_social_drafts', line: 'Creating social campaign drafts' });
      socialCampaignResult = createOrRefreshDailySocialCampaign({
        songId: cleanSongId,
        platforms: options.platforms,
        force: options.forceSocialCampaign,
      });

      if (options.renderYouTubeVideo) {
        const youtubePost = getSocialPostsByCampaignId(socialCampaignResult.campaign.id)
          .find(post => post.platform === 'youtube');
        if (youtubePost) {
          await emit({ type: 'release_stage_progress', stage: 'creating_youtube_video_asset', line: 'Rendering YouTube MP4 asset from existing audio and image' });
          youtubeVideoAsset = await ensureYouTubeVideoAsset({
            post: youtubePost,
            force: false,
          });
          if (youtubeVideoAsset.ok) {
            updateSocialPost(youtubePost.id, {
              asset_type: 'video',
              asset_url: youtubeVideoAsset.videoAssetUrl || youtubeVideoAsset.videoPath,
              public_asset_url: youtubeVideoAsset.videoAssetUrl || youtubeVideoAsset.videoPath,
              validation_warnings: [
                `YouTube MP4 ${youtubeVideoAsset.reused ? 'reused' : 'generated'}: ${youtubeVideoAsset.videoPath}`,
                ...(youtubeVideoAsset.sourceAudioPath ? [`YouTube source audio: ${youtubeVideoAsset.sourceAudioPath}`] : []),
                ...(youtubeVideoAsset.sourceImagePath ? [`YouTube source image: ${youtubeVideoAsset.sourceImagePath}`] : []),
              ],
              status: 'draft',
            });
          } else {
            updateSocialPost(youtubePost.id, {
              status: 'failed',
              error_code: 'youtube_video_asset_failed',
              error_message: youtubeVideoAsset.error,
            });
          }
        }
      }
    }

    upsertSong({
      id: cleanSongId,
      status: SONG_STATUSES.DRAFT,
      brand_score: brandReview.scores?.overall,
      total_cost_usd: totalCost,
      brand_profile_id: cleanBrandId,
      pipeline_stage: 'release_assets_ready_pending_approval',
    });

    const posts = socialCampaignResult?.campaign?.id ? getSocialPostsByCampaignId(socialCampaignResult.campaign.id) : [];
    const result = {
      ok: true,
      songId: cleanSongId,
      title: song.title || metadata.title || cleanSongId,
      brandId: cleanBrandId,
      brandName: brandProfile.brand_name || cleanBrandId,
      totalCost,
      recommendation,
      qaPassed: Boolean(qaReport.passed),
      qaWarnings: qaReport.warnings || [],
      qaFailures: qaReport.failures || [],
      distDir: distributionPackage.distDir || null,
      marketingDashboardUrl: marketingResult.dashboardUrl || null,
      marketingAssets: marketingResult.generatedAssets || {},
      socialCampaignId: socialCampaignResult?.campaign?.id || null,
      socialPostIds: posts.map(post => post.id),
      youtubeVideoAsset,
      awaitingApproval: true,
      publishBlockedByDefault: true,
      nextAction: 'Review the release kit and social drafts. Publish only from /marketing/social after explicit approval.',
    };

    logger.log(chalk.bgGreen.black('\n ✓ RELEASE ASSETS READY — WAITING FOR APPROVAL \n'));
    logger.log(chalk.dim('  Built release/marketing/social assets from the existing song. No song regeneration and no live publishing ran.'));
    logger.log(`  Distribution package: ${chalk.bold(result.distDir || 'not created')}`);
    logger.log(`  Marketing dashboard: ${chalk.bold(result.marketingDashboardUrl || 'not created')}`);
    if (result.socialCampaignId) logger.log(`  Social campaign: ${chalk.bold(result.socialCampaignId)}`);
    logger.log(`\n${chalk.dim('Total cost after release stage:')} ${chalk.bold(formatCost(totalCost))}\n`);

    await emit({ type: 'release_stage_progress', stage: 'done', line: 'Release stage complete; awaiting human approval', result });
    return result;
  } finally {
    if (previousBrandProfilePath === undefined) delete process.env.BRAND_PROFILE_PATH;
    else process.env.BRAND_PROFILE_PATH = previousBrandProfilePath;
    clearBrandProfileCache();
  }
}

async function loadBrandScopedReleaseModules(runToken) {
  const qs = encodeURIComponent(runToken);
  const [brandManager, opsManager, releaseSelectionAgent, songReleaseAssetsService] = await Promise.all([
    import(`../agents/brand-manager.js?releaseStage=${qs}`),
    import(`../agents/ops-manager.js?releaseStage=${qs}`),
    import(`../agents/release-selection-agent.js?releaseStage=${qs}`),
    import(`../shared/song-release-assets-service.js?releaseStage=${qs}`),
  ]);

  return {
    reviewSong: brandManager.reviewSong,
    runQAChecklist: opsManager.runQAChecklist,
    generateHumanTasks: opsManager.generateHumanTasks,
    analyzeSongForReleaseSelection: releaseSelectionAgent.analyzeSongForReleaseSelection,
    buildSongReleaseAssets: songReleaseAssetsService.buildSongReleaseAssets,
  };
}

function resolveSongFilePath(value, songDir, fallbacks = []) {
  const candidates = [];
  if (value) candidates.push(value);
  candidates.push(...fallbacks.map(name => join(songDir, name)));
  for (const candidate of candidates) {
    const filePath = String(candidate || '').trim();
    if (filePath && fs.existsSync(filePath)) return filePath;
  }
  return '';
}

function readText(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}
