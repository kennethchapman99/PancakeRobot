export const RELEASE_SELECTION_AGENT = 'ReleaseSelectionAgent';
export const RELEASE_SELECTION_VERSION = 'ReleaseSelectionAgent_v1';
export const RELEASE_SELECTION_THRESHOLD_VERSION = 'release_selection_v1';

export const RECOMMENDATION_VALUES = Object.freeze([
  'recommend_to_publish',
  'recommend_to_edit',
  'recommend_to_hold',
  'recommend_to_archive',
  'needs_manual_review',
]);

export const RELEASE_TREATMENTS = Object.freeze([
  'full_push',
  'light_push',
  'social_only',
  'catalog_depth',
  'edit_then_reassess',
  'hold_for_future',
  'archive_candidate',
  'manual_review_required',
]);

export const ASSET_STRATEGIES = Object.freeze([
  'full_release_pack',
  'light_release_pack',
  'social_clip_pack',
  'catalog_only_metadata',
  'edit_notes_only',
  'archive_no_assets',
  'manual_review_pack',
]);

export const PIPELINE_STAGES = Object.freeze({
  RELEASE_SELECTION_PENDING: 'release_selection_pending',
  RELEASE_SELECTION_COMPLETE: 'release_selection_complete',
  APPROVED_FOR_RELEASE_PACKAGING: 'approved_for_release_packaging',
  HELD_AFTER_RELEASE_SELECTION: 'held_after_release_selection',
  MANUAL_REVIEW_REQUIRED: 'manual_review_required',
});

export const SCORE_LIMITS = Object.freeze({
  hook_replayability: 30,
  audience_appeal: 20,
  secondary_audience_tolerability: 10,
  production_quality: 15,
  brand_fit: 15,
  release_differentiation: 10,
});

