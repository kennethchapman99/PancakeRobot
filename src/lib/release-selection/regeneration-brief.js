export function buildReleaseSelectionRevisionBrief(song, userFeedback = '') {
  const recommendation = song?.release_recommendation || {};
  const marketingInputs = song?.marketing_inputs_from_ar || {};
  const parts = [];

  if (recommendation.value) {
    parts.push(`A&R recommendation: ${recommendation.value}.`);
  }
  if (recommendation.recommended_release_treatment) {
    parts.push(`Suggested treatment after improvement: ${recommendation.recommended_release_treatment}.`);
  }
  if (Number.isFinite(Number(recommendation.score))) {
    parts.push(`Current A&R score: ${recommendation.score}/100.`);
  }
  if (recommendation.reasoning_summary) {
    parts.push(`A&R rationale: ${recommendation.reasoning_summary}`);
  }
  if (Array.isArray(recommendation.detected_issues) && recommendation.detected_issues.length) {
    parts.push(`Detected issues to address: ${recommendation.detected_issues.join(', ')}.`);
  }
  if (Array.isArray(recommendation.release_blockers) && recommendation.release_blockers.length) {
    parts.push(`Release blockers to resolve: ${recommendation.release_blockers.join(', ')}.`);
  }
  if (marketingInputs.best_hook_phrase) {
    parts.push(`Best hook to preserve or strengthen: "${marketingInputs.best_hook_phrase}".`);
  }
  if (marketingInputs.recommended_angle) {
    parts.push(`Recommended angle: ${marketingInputs.recommended_angle}`);
  }
  if (marketingInputs.short_pitch) {
    parts.push(`Short positioning note: ${marketingInputs.short_pitch}`);
  }
  if (userFeedback && userFeedback.trim()) {
    parts.push(`Operator feedback: ${userFeedback.trim()}`);
  }

  if (!parts.length) return userFeedback.trim();

  return [
    'Improve this song for the next regeneration pass.',
    'Keep what is already working, but explicitly address the notes below.',
    ...parts,
  ].join('\n');
}

