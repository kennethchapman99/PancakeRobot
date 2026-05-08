import test from 'node:test';
import assert from 'node:assert/strict';

import { determineRecommendationValue } from '../src/lib/release-selection/score-song.js';
import { mapRecommendationToTreatment, mapTreatmentToAssetStrategy } from '../src/lib/release-selection/release-treatment-mapper.js';

const strongBreakdown = {
  production_quality: 13,
  hook_replayability: 24,
  brand_fit: 12,
};

test('release selection honors brand publish threshold override', () => {
  const borderlineWithProfileThreshold = determineRecommendationValue({
    totalScore: 82,
    releaseBlockers: [],
    issues: [],
    scoreBreakdown: strongBreakdown,
    publishThreshold: 82,
  });
  const borderlineWithDefaultThreshold = determineRecommendationValue({
    totalScore: 82,
    releaseBlockers: [],
    issues: [],
    scoreBreakdown: strongBreakdown,
    publishThreshold: 85,
  });

  assert.equal(borderlineWithProfileThreshold, 'recommend_to_publish');
  assert.equal(borderlineWithDefaultThreshold, 'recommend_to_hold');
});

test('release blockers still override lowered profile threshold', () => {
  const blocked = determineRecommendationValue({
    totalScore: 99,
    releaseBlockers: ['missing_audio'],
    issues: [],
    scoreBreakdown: strongBreakdown,
    publishThreshold: 80,
  });

  assert.equal(blocked, 'needs_manual_review');
});

test('social-only hold recommendations still map to a social clip asset strategy', () => {
  const treatment = mapRecommendationToTreatment({
    recommendation: 'recommend_to_hold',
    score: 80,
    issues: ['soft_brand_fit'],
    releaseBlockers: [],
    clipStrength: 12,
    productionQuality: 10,
    hookReplayability: 24,
  });

  assert.equal(treatment, 'social_only');
  assert.equal(mapTreatmentToAssetStrategy(treatment), 'social_clip_pack');
});
