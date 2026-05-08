import fs from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { getAllSongs, getSong, upsertSong } from '../shared/db.js';
import { SONG_STATUSES } from '../shared/song-status.js';
import { analyzeAudioFile } from '../lib/release-selection/audio-analysis.js';
import { buildReleaseSelectionBrandProfile } from '../lib/release-selection/brand-profile-loader.js';
import {
  buildBadges,
  buildReasoningSummary,
  determineRecommendationValue,
  scoreSongForRelease,
} from '../lib/release-selection/score-song.js';
import { buildMarketingInputsFromAr } from '../lib/release-selection/marketing-handoff-builder.js';
import { mapRecommendationToTreatment, mapTreatmentToAssetStrategy } from '../lib/release-selection/release-treatment-mapper.js';
import {
  PIPELINE_STAGES,
  RELEASE_SELECTION_AGENT,
  RELEASE_SELECTION_THRESHOLD_VERSION,
  RELEASE_SELECTION_VERSION,
} from '../lib/release-selection/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function analyzeSongForReleaseSelection(songId, options = {}) {
  const song = typeof songId === 'string' ? getSong(songId) : songId;
  if (!song?.id) throw new Error('Song not found');

  const songDir = join(__dirname, `../../output/songs/${song.id}`);
  const audioPath = resolvePrimaryAudioPath(songDir);
  const lyricsText = readFirstExisting([
    join(songDir, 'lyrics.md'),
    join(songDir, 'lyrics-clean.txt'),
  ]);
  const metadata = readJson(join(songDir, 'metadata.json'));
  const brandProfile = buildReleaseSelectionBrandProfile(song);
  const publishThreshold = resolvePublishThreshold(brandProfile);
  const audioAnalysis = analyzeAudioFile(audioPath);
  const catalog = getAllSongs().map(item => ({
    ...item,
    lyricsText: readLyricsForCatalog(item.id),
  }));

  const baseScoring = scoreSongForRelease({
    song,
    lyricsText,
    metadata,
    brandProfile,
    metrics: audioAnalysis.metrics,
    catalog,
  });

  const recommendationValue = determineRecommendationValue({
    totalScore: baseScoring.totalScore,
    releaseBlockers: [...baseScoring.releaseBlockers, ...(audioAnalysis.ok ? [] : ['audio_analysis_failed'])],
    scoreBreakdown: baseScoring.scoreBreakdown,
    issues: baseScoring.issues,
    publishThreshold,
  });

  const releaseBlockers = [...new Set([
    ...baseScoring.releaseBlockers,
    ...(audioAnalysis.ok ? [] : [audioAnalysis.error || 'audio_analysis_failed']),
  ])];
  const treatment = mapRecommendationToTreatment({
    recommendation: recommendationValue,
    score: baseScoring.totalScore,
    issues: baseScoring.issues,
    releaseBlockers,
    clipStrength: clipStrength(audioAnalysis.metrics),
    productionQuality: baseScoring.scoreBreakdown.production_quality,
    hookReplayability: baseScoring.scoreBreakdown.hook_replayability,
  });
  const now = new Date().toISOString();
  const badges = buildBadges({
    recommendationValue,
    treatment,
    scoreBreakdown: baseScoring.scoreBreakdown,
    releaseBlockers,
  });
  const reasoningSummary = buildReasoningSummary({
    recommendationValue,
    treatment,
    scoreBreakdown: baseScoring.scoreBreakdown,
    issues: baseScoring.issues,
    releaseBlockers,
    bestHookPhrase: baseScoring.bestHookPhrase,
  });
  const recommendation = {
    value: recommendationValue,
    recommended_release_treatment: treatment,
    score: baseScoring.totalScore,
    publish_threshold: publishThreshold,
    confidence: baseScoring.confidence,
    threshold_version: RELEASE_SELECTION_THRESHOLD_VERSION,
    agent: RELEASE_SELECTION_AGENT,
    agent_version: RELEASE_SELECTION_VERSION,
    created_at: song.release_recommendation?.created_at || now,
    updated_at: now,
    scores: baseScoring.scoreBreakdown,
    metrics: audioAnalysis.metrics,
    badges,
    detected_issues: baseScoring.issues,
    release_blockers: releaseBlockers,
    brand_profile_id: brandProfile.brand_id || song.brand_profile_id || null,
    brand_profile_version: brandProfile.raw_profile?.version || null,
    used_llm_summary: false,
    reasoning_summary: reasoningSummary,
    recommended_next_action: buildRecommendedNextAction(recommendationValue, treatment),
    recommended_asset_strategy: mapTreatmentToAssetStrategy(treatment),
  };
  const marketingInputs = buildMarketingInputsFromAr({
    recommendation,
    bestHookPhrase: baseScoring.bestHookPhrase,
    bestClipStartSeconds: audioAnalysis.metrics.best_clip_start_seconds,
    bestClipEndSeconds: audioAnalysis.metrics.best_clip_end_seconds,
    reasoningSummary,
    title: song.title || song.topic,
  });

  const historyEntry = {
    updated_at: now,
    value: recommendation.value,
    score: recommendation.score,
    recommended_release_treatment: recommendation.recommended_release_treatment,
    confidence: recommendation.confidence,
    threshold_version: recommendation.threshold_version,
    agent_version: recommendation.agent_version,
  };
  const priorHistory = Array.isArray(song.release_recommendation_history) ? song.release_recommendation_history : [];
  const releaseRecommendationHistory = options.appendHistory === false
    ? priorHistory
    : [...priorHistory, historyEntry].slice(-20);

  const updatedSong = {
    id: song.id,
    status: SONG_STATUSES.DRAFT,
    pipeline_stage: releaseBlockers.length ? PIPELINE_STAGES.MANUAL_REVIEW_REQUIRED : PIPELINE_STAGES.RELEASE_SELECTION_COMPLETE,
    release_recommendation: recommendation,
    release_recommendation_history: releaseRecommendationHistory,
    marketing_inputs_from_ar: marketingInputs,
  };
  upsertSong(updatedSong);

  persistAnalysisArtifacts(songDir, { recommendation, marketingInputs, audioAnalysis, baseScoring, metadata });
  return {
    song_id: song.id,
    recommendation,
    marketing_inputs_from_ar: marketingInputs,
  };
}

export async function analyzeRecentDraftSongsForReleaseSelection({ songIds = null, limit = 10 } = {}) {
  const targetSongs = Array.isArray(songIds) && songIds.length
    ? songIds.map(id => getSong(id)).filter(Boolean)
    : getAllSongs().filter(song => song.status === SONG_STATUSES.DRAFT).slice(0, limit);
  const batchId = `batch_${Date.now().toString(36)}`;
  const results = [];

  for (const song of targetSongs) {
    try {
      results.push(await analyzeSongForReleaseSelection(song));
    } catch (error) {
      results.push({
        song_id: song?.id || null,
        recommendation: {
          value: 'needs_manual_review',
          recommended_release_treatment: 'manual_review_required',
          score: 0,
          confidence: 'low',
          release_blockers: [error.message],
        },
      });
    }
  }

  const bucket = value => results.filter(item => item.recommendation?.value === value).map(item => item.song_id);
  const topRelease = [...results]
    .filter(item => item.recommendation?.value === 'recommend_to_publish')
    .sort((a, b) => (b.recommendation?.score || 0) - (a.recommendation?.score || 0))[0];
  const topSocial = [...results]
    .filter(item => item.recommendation?.recommended_release_treatment === 'social_only')
    .sort((a, b) => (b.recommendation?.score || 0) - (a.recommendation?.score || 0))[0];

  return {
    batch_id: batchId,
    agent: RELEASE_SELECTION_AGENT,
    agent_version: RELEASE_SELECTION_VERSION,
    songs_reviewed: results.length,
    recommended_for_publish: bucket('recommend_to_publish'),
    recommended_for_edit: bucket('recommend_to_edit'),
    recommended_for_hold: bucket('recommend_to_hold'),
    recommended_for_archive: bucket('recommend_to_archive'),
    needs_manual_review: bucket('needs_manual_review'),
    top_release_candidate: topRelease?.song_id || null,
    top_social_only_candidate: topSocial?.song_id || null,
    batch_summary: `${bucket('recommend_to_publish').length} release candidates, ${bucket('recommend_to_edit').length} edit candidates, ${bucket('recommend_to_hold').length} holds, ${bucket('recommend_to_archive').length} archive candidates, and ${bucket('needs_manual_review').length} manual reviews.`,
    results,
  };
}

function buildRecommendedNextAction(recommendationValue, treatment) {
  if (recommendationValue === 'recommend_to_publish') return 'Approve for DistroKid packaging.';
  if (recommendationValue === 'recommend_to_edit') return 'Send to editing, then re-run analysis.';
  if (recommendationValue === 'recommend_to_hold') return treatment === 'social_only' ? 'Use for social-first content or hold as draft.' : 'Hold as draft and reassess later.';
  if (recommendationValue === 'recommend_to_archive') return 'Archive only after operator confirmation.';
  return 'Review issues and re-run analysis after fixing blockers.';
}

function clipStrength(metrics = {}) {
  let value = 0;
  if ((metrics.best_clip_end_seconds ?? 0) - (metrics.best_clip_start_seconds ?? 0) >= 12) value += 8;
  if ((metrics.high_energy_segments || []).length >= 2) value += 4;
  if ((metrics.intro_energy_ramp ?? 0) >= 2) value += 2;
  return value;
}

function resolvePublishThreshold(brandProfile = {}) {
  const candidates = [
    brandProfile.scoring_preferences?.recommend_to_publish_threshold,
    brandProfile.scoring_preferences?.publish_threshold,
    brandProfile.raw_profile?.scoring_preferences?.recommend_to_publish_threshold,
    brandProfile.raw_profile?.scoring_preferences?.publish_threshold,
    brandProfile.raw_profile?.release_selection?.recommend_to_publish_threshold,
    brandProfile.raw_profile?.recommend_to_publish_threshold,
  ];

  for (const value of candidates) {
    const threshold = Number(value);
    if (Number.isFinite(threshold)) return Math.max(0, Math.min(100, threshold));
  }

  return 85;
}

function resolvePrimaryAudioPath(songDir) {
  const candidates = [
    join(songDir, 'audio.mp3'),
    join(songDir, 'audio.wav'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const audioDir = join(songDir, 'audio');
  if (!fs.existsSync(audioDir)) return null;
  const names = fs.readdirSync(audioDir)
    .filter(name => name.endsWith('.mp3') || name.endsWith('.wav'))
    .sort((a, b) => a.localeCompare(b));
  return names.length ? join(audioDir, names[0]) : null;
}

function readFirstExisting(paths) {
  for (const filePath of paths) {
    try {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    } catch {}
  }
  return '';
}

function readJson(filePath) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

function readLyricsForCatalog(songId) {
  const songDir = join(__dirname, `../../output/songs/${songId}`);
  return readFirstExisting([join(songDir, 'lyrics.md'), join(songDir, 'lyrics-clean.txt')]);
}

function persistAnalysisArtifacts(songDir, payload) {
  fs.mkdirSync(songDir, { recursive: true });
  fs.writeFileSync(join(songDir, 'release-selection.json'), JSON.stringify(payload.recommendation, null, 2));
  fs.writeFileSync(join(songDir, 'marketing-inputs-from-ar.json'), JSON.stringify(payload.marketingInputs, null, 2));
  fs.writeFileSync(join(songDir, 'release-selection-debug.json'), JSON.stringify({
    audio_analysis: payload.audioAnalysis,
    scoring: payload.baseScoring,
    metadata: payload.metadata,
  }, null, 2));
}
