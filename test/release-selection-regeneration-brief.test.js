import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReleaseSelectionRevisionBrief } from '../src/lib/release-selection/regeneration-brief.js';

test('release-selection regeneration brief merges A&R findings with operator feedback', () => {
  const brief = buildReleaseSelectionRevisionBrief({
    release_recommendation: {
      value: 'recommend_to_edit',
      recommended_release_treatment: 'edit_then_reassess',
      score: 78,
      reasoning_summary: 'Strong hook, but the production needs cleanup.',
      detected_issues: ['critical_clipping', 'soft_brand_fit'],
      release_blockers: ['long_accidental_silence'],
    },
    marketing_inputs_from_ar: {
      best_hook_phrase: 'flip flip flip',
      recommended_angle: 'Lead with the visual pancake payoff.',
      short_pitch: 'Needs a cleaner render before release.',
    },
  }, 'make the chorus hit harder and tighten the intro');

  assert.match(brief, /recommend_to_edit/);
  assert.match(brief, /edit_then_reassess/);
  assert.match(brief, /critical_clipping/);
  assert.match(brief, /long_accidental_silence/);
  assert.match(brief, /flip flip flip/);
  assert.match(brief, /make the chorus hit harder and tighten the intro/);
});

