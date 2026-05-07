import { mapTreatmentToAssetStrategy } from './release-treatment-mapper.js';

export function buildMarketingInputsFromAr({ recommendation, bestHookPhrase, bestClipStartSeconds, bestClipEndSeconds, reasoningSummary, title }) {
  const treatment = recommendation.recommended_release_treatment;
  const value = recommendation.value;
  return {
    best_hook_phrase: bestHookPhrase || title || null,
    best_clip_start_seconds: bestClipStartSeconds ?? null,
    best_clip_end_seconds: bestClipEndSeconds ?? null,
    recommended_angle: buildAngle({ treatment, bestHookPhrase, value }),
    short_pitch: buildShortPitch({ treatment, reasoningSummary, title }),
    recommended_release_treatment: treatment,
    suggested_asset_strategy: mapTreatmentToAssetStrategy(treatment),
    content_warning: recommendation.release_blockers?.length ? recommendation.release_blockers.join('; ') : null,
  };
}

function buildAngle({ treatment, bestHookPhrase, value }) {
  if (treatment === 'social_only') return `Lead with the visual or lyrical payoff around "${bestHookPhrase || 'the strongest hook'}".`;
  if (treatment === 'edit_then_reassess') return 'Lead with the hook concept after the render issues are corrected.';
  if (value === 'recommend_to_archive') return 'No marketing angle recommended.';
  return `Position the song around "${bestHookPhrase || 'its strongest hook'}" and the clearest audience fit.`;
}

function buildShortPitch({ treatment, reasoningSummary, title }) {
  if (treatment === 'archive_candidate') return `${title || 'This song'} is not recommended for release or asset generation.`;
  if (treatment === 'manual_review_required') return `${title || 'This song'} needs issue review before any release positioning.`;
  return reasoningSummary || `${title || 'This song'} has a usable hook and a defined release treatment.`;
}

