export function mapRecommendationToTreatment({ recommendation, score, issues = [], releaseBlockers = [], clipStrength = 0, productionQuality = 0, hookReplayability = 0 }) {
  if (recommendation === 'needs_manual_review' || releaseBlockers.length > 0) return 'manual_review_required';
  if (recommendation === 'recommend_to_archive') return 'archive_candidate';
  if (recommendation === 'recommend_to_edit') return 'edit_then_reassess';
  if (recommendation === 'recommend_to_hold') {
    if (score >= 60 && clipStrength >= 12 && hookReplayability >= 18) return 'social_only';
    if (issues.some(issue => issue.includes('duplicate') || issue.includes('timing'))) return 'hold_for_future';
    return 'catalog_depth';
  }
  if (recommendation === 'recommend_to_publish') {
    if (score >= 85 && hookReplayability >= 22 && productionQuality >= 11 && clipStrength >= 12) return 'full_push';
    return 'light_push';
  }
  return 'manual_review_required';
}

export function mapTreatmentToAssetStrategy(treatment) {
  switch (treatment) {
    case 'full_push':
      return 'full_release_pack';
    case 'light_push':
      return 'light_release_pack';
    case 'social_only':
      return 'social_clip_pack';
    case 'catalog_depth':
    case 'hold_for_future':
      return 'catalog_only_metadata';
    case 'edit_then_reassess':
      return 'edit_notes_only';
    case 'archive_candidate':
      return 'archive_no_assets';
    case 'manual_review_required':
    default:
      return 'manual_review_pack';
  }
}

