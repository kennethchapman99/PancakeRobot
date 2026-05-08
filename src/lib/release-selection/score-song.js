import { SCORE_LIMITS } from './constants.js';

const DEFAULT_PUBLISH_THRESHOLD = 85;

export function scoreSongForRelease({ song, lyricsText, metadata = {}, brandProfile, metrics, catalog = [] }) {
  const issues = [];
  const releaseBlockers = [];
  const scoreBreakdown = {
    hook_replayability: scoreHookReplayability({ song, lyricsText, metrics, issues }),
    audience_appeal: scoreAudienceAppeal({ song, lyricsText, brandProfile }),
    secondary_audience_tolerability: scoreSecondaryAudienceTolerability({ lyricsText, metrics, brandProfile, issues }),
    production_quality: scoreProductionQuality({ metrics, issues, releaseBlockers }),
    brand_fit: scoreBrandFit({ song, lyricsText, brandProfile, issues }),
    release_differentiation: scoreReleaseDifferentiation({ song, lyricsText, catalog, issues }),
  };

  const totalScore = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  const bestHookPhrase = findBestHookPhrase(song, lyricsText);
  const confidence = classifyConfidence({ brandProfile, issues, releaseBlockers, metrics, lyricsText });

  if (!song?.title && !song?.topic) releaseBlockers.push('missing_title');
  if (!metrics?.duration_seconds) releaseBlockers.push('missing_audio');
  if (!lyricsText?.trim()) issues.push('missing_lyrics');
  if (brandProfile?.missing_brand_profile) issues.push('missing_brand_profile');

  return {
    scoreBreakdown,
    totalScore,
    issues: uniqueStrings(issues),
    releaseBlockers: uniqueStrings(releaseBlockers),
    bestHookPhrase,
    confidence,
  };
}

function scoreHookReplayability({ song, lyricsText, metrics, issues }) {
  const lines = lyricLines(lyricsText);
  const title = String(song?.title || song?.topic || '').trim();
  const chorusLikeRepeats = repeatedPhrases(lines);
  let score = 8;

  if (title && lyricsText.toLowerCase().includes(title.toLowerCase())) score += 7;
  if (chorusLikeRepeats.maxRepeatCount >= 3) score += 7;
  if ((metrics.best_clip_end_seconds ?? 0) - (metrics.best_clip_start_seconds ?? 0) >= 12) score += 3;
  if ((metrics.intro_energy_ramp ?? -99) >= 2) score += 3;
  if ((metrics.high_energy_segments || []).length >= 2) score += 2;

  if (chorusLikeRepeats.maxRepeatCount === 0) issues.push('weak_repeated_hook');
  return clampScore(score, SCORE_LIMITS.hook_replayability);
}

function scoreAudienceAppeal({ song, lyricsText, brandProfile }) {
  const text = `${song?.title || ''}\n${song?.topic || ''}\n${lyricsText || ''}`.toLowerCase();
  let score = 8;
  const simpleWordCount = text.split(/\s+/).filter(word => word.length && word.length <= 7).length;
  const totalWords = text.split(/\s+/).filter(Boolean).length || 1;
  if ((simpleWordCount / totalWords) >= 0.7) score += 4;
  if (/(hey|go|dance|sing|jump|flip|bounce|clap|yeah|oh)/.test(text)) score += 4;
  if ((brandProfile.themes || []).some(theme => text.includes(theme.toLowerCase()))) score += 4;
  return clampScore(score, SCORE_LIMITS.audience_appeal);
}

function scoreSecondaryAudienceTolerability({ lyricsText, metrics, brandProfile, issues }) {
  const text = String(lyricsText || '').toLowerCase();
  let score = 7;
  const longRepeatPenalty = /(.)\1{5,}/.test(text) ? 2 : 0;
  const harshPenalty = text.includes('scream') || text.includes('kill') || text.includes('blood') ? 3 : 0;
  if ((metrics.duration_seconds ?? 0) > 210) score -= 2;
  if ((metrics.clipping_detected ?? false)) score -= 2;
  if (longRepeatPenalty) issues.push('high_repetition_risk');
  if (harshPenalty) issues.push('secondary_audience_discomfort');
  if ((brandProfile.avoid_topics || []).some(topic => text.includes(topic.toLowerCase()))) score -= 2;
  return clampScore(score - longRepeatPenalty - harshPenalty, SCORE_LIMITS.secondary_audience_tolerability);
}

function scoreProductionQuality({ metrics, issues, releaseBlockers }) {
  let score = 10;
  if (!metrics.duration_seconds) {
    releaseBlockers.push('missing_audio');
    return 0;
  }
  if ((metrics.duration_seconds ?? 0) < 45) score -= 4;
  if ((metrics.duration_seconds ?? 0) > 240) score -= 2;
  if ((metrics.clipping_detected ?? false)) {
    score -= 4;
    issues.push('critical_clipping');
  }
  if ((metrics.total_silence_seconds ?? 0) > 8) {
    score -= 4;
    issues.push('long_accidental_silence');
  }
  if ((metrics.silence_end_seconds ?? 0) > 4) issues.push('trailing_silence');
  if ((metrics.peak_db ?? -99) < -6) score -= 2;
  if ((metrics.rms_energy_variance ?? 0) < 2) score -= 2;
  if (!(metrics.best_clip_start_seconds >= 0)) score -= 1;
  return clampScore(score, SCORE_LIMITS.production_quality);
}

function scoreBrandFit({ song, lyricsText, brandProfile, issues }) {
  let score = brandProfile.missing_brand_profile ? 7 : 10;
  const text = `${song?.title || ''}\n${song?.topic || ''}\n${lyricsText || ''}`.toLowerCase();
  const preferred = (brandProfile.brand_fit_keywords || []).filter(keyword => text.includes(keyword.toLowerCase())).length;
  const themes = (brandProfile.themes || []).filter(theme => text.includes(theme.toLowerCase())).length;
  const avoided = (brandProfile.avoid_topics || []).filter(topic => text.includes(topic.toLowerCase())).length;
  score += Math.min(4, preferred);
  score += Math.min(3, themes);
  score -= Math.min(6, avoided * 3);
  if (!preferred && !themes && !brandProfile.missing_brand_profile) issues.push('soft_brand_fit');
  if (avoided > 0) issues.push('off_brand_topic');
  return clampScore(score, SCORE_LIMITS.brand_fit);
}

function scoreReleaseDifferentiation({ song, lyricsText, catalog, issues }) {
  let score = 8;
  const comparable = catalog.filter(item => item.id !== song.id);
  if (!comparable.length) return clampScore(score, SCORE_LIMITS.release_differentiation);

  const currentText = normalizeComparableText(song, lyricsText);
  const duplicateLike = comparable
    .map(item => normalizeComparableText(item, item.lyricsText || ''))
    .some(text => overlapScore(currentText, text) >= 0.72);

  if (duplicateLike) {
    score -= 5;
    issues.push('duplicate_catalog_concept');
  } else {
    score += 2;
  }
  return clampScore(score, SCORE_LIMITS.release_differentiation);
}

export function determineRecommendationValue({ totalScore, releaseBlockers, scoreBreakdown, issues, publishThreshold = DEFAULT_PUBLISH_THRESHOLD }) {
  const effectivePublishThreshold = normalizePublishThreshold(publishThreshold);
  if (releaseBlockers.length > 0) return 'needs_manual_review';
  if (scoreBreakdown.production_quality <= 5 && scoreBreakdown.hook_replayability >= 16) return 'recommend_to_edit';
  if (scoreBreakdown.hook_replayability <= 10 && scoreBreakdown.production_quality >= 9) return 'recommend_to_hold';
  if (scoreBreakdown.hook_replayability <= 10 && scoreBreakdown.brand_fit <= 7) return 'recommend_to_archive';
  if (issues.includes('critical_clipping') || issues.includes('long_accidental_silence')) return 'recommend_to_edit';
  if (totalScore >= effectivePublishThreshold) return 'recommend_to_publish';
  if (totalScore >= 70) return scoreBreakdown.production_quality < 9 ? 'recommend_to_edit' : 'recommend_to_hold';
  if (totalScore >= 55) return 'recommend_to_hold';
  return 'recommend_to_archive';
}

export function buildBadges({ recommendationValue, treatment, scoreBreakdown, releaseBlockers }) {
  const badges = [];
  if (scoreBreakdown.hook_replayability >= 22) badges.push('Strong Hook');
  if (scoreBreakdown.production_quality >= 11) badges.push('Clean Production');
  if (scoreBreakdown.brand_fit >= 12) badges.push('Strong Brand Fit');
  if (treatment === 'social_only') badges.push('Good Social Clip');
  if (recommendationValue === 'recommend_to_publish') badges.push('Release Candidate');
  if (releaseBlockers.length > 0) badges.push('Manual Review');
  return badges;
}

export function buildReasoningSummary({ recommendationValue, treatment, scoreBreakdown, issues, releaseBlockers, bestHookPhrase }) {
  if (releaseBlockers.length > 0) return `Manual review required due to ${releaseBlockers.join(', ')}.`;
  const strengths = [];
  if (scoreBreakdown.hook_replayability >= 20) strengths.push('strong hook');
  if (scoreBreakdown.production_quality >= 11) strengths.push('clean production');
  if (scoreBreakdown.brand_fit >= 12) strengths.push('strong brand fit');
  if (bestHookPhrase) strengths.push(`clear hook phrase "${bestHookPhrase}"`);
  if (issues.length === 0 && recommendationValue === 'recommend_to_publish') {
    return `${capitalizeList(strengths)} support a ${treatment.replaceAll('_', ' ')} recommendation.`;
  }
  if (issues.length) return `${capitalizeList(strengths)} offset by ${issues.slice(0, 2).join(' and ')}.`;
  return `${capitalizeList(strengths)} led to ${recommendationValue.replaceAll('_', ' ')}.`;
}

function classifyConfidence({ brandProfile, issues, releaseBlockers, metrics, lyricsText }) {
  if (releaseBlockers.length > 0) return 'low';
  let score = 3;
  if (brandProfile.missing_brand_profile) score -= 1;
  if (!lyricsText?.trim()) score -= 1;
  if (!metrics?.duration_seconds) score -= 1;
  if (issues.length >= 3) score -= 1;
  if ((metrics.energy_curve || []).length >= 4) score += 1;
  return score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
}

export function findBestHookPhrase(song, lyricsText = '') {
  const lines = lyricLines(lyricsText);
  const repeated = repeatedPhrases(lines).phrases[0];
  if (repeated?.phrase) return repeated.phrase;
  return String(song?.title || song?.topic || '').trim() || null;
}

function repeatedPhrases(lines) {
  const counts = new Map();
  for (const line of lines) {
    const key = line.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const phrases = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([phrase, count]) => ({ phrase, count }));
  return {
    phrases,
    maxRepeatCount: phrases[0]?.count || 0,
  };
}

function lyricLines(text = '') {
  return String(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('[') && line.length > 4);
}

function normalizeComparableText(song, lyricsText) {
  return `${song?.title || ''} ${song?.topic || ''} ${lyricsText || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function overlapScore(a, b) {
  const aset = new Set(a.split(' ').filter(Boolean));
  const bset = new Set(b.split(' ').filter(Boolean));
  if (!aset.size || !bset.size) return 0;
  let shared = 0;
  for (const word of aset) {
    if (bset.has(word)) shared += 1;
  }
  return shared / Math.max(aset.size, bset.size);
}

function normalizePublishThreshold(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) return DEFAULT_PUBLISH_THRESHOLD;
  return Math.max(0, Math.min(100, threshold));
}

function clampScore(value, max) {
  return Math.max(0, Math.min(max, Math.round(value)));
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function capitalizeList(items) {
  if (!items.length) return 'The available signals';
  const text = items.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
