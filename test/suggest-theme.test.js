import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSuggestTask,
  buildThemeGuidance,
  getThemeValidationFailures,
  normalizeThemePrompt,
} from '../src/shared/suggest.js';

test('normalizeThemePrompt trims and collapses whitespace', () => {
  assert.equal(normalizeThemePrompt('  summer   chores  '), 'summer chores');
  assert.equal(normalizeThemePrompt('   '), '');
  assert.equal(normalizeThemePrompt(null), '');
});

test('theme guidance makes theme a hard batch constraint for all 5 ideas', () => {
  const guidance = buildThemeGuidance('summer');

  assert.match(guidance, /HARD BATCH CONSTRAINT/);
  assert.match(guidance, /Every recommendation must be rooted/i);
  assert.match(guidance, /Ranks 1, 2, 3, 4, and 5 must each visibly fit/i);
  assert.match(guidance, /theme_alignment/);
});

test('suggest task requires per-idea theme alignment when theme is provided', () => {
  const task = buildSuggestTask({
    songs: [],
    researchSummary: '',
    themePrompt: 'chores',
    currentDate: new Date('2026-05-01T12:00:00Z'),
  });

  assert.match(task, /"chores"/);
  assert.match(task, /Every recommendation must be rooted/i);
  assert.match(task, /Ranks 1, 2, 3, 4, and 5 must each visibly fit/i);
  assert.match(task, /"theme_alignment"/);
  assert.match(task, /How this specific idea clearly fits the user-provided theme/);
});

test('suggest task keeps blank theme unconstrained', () => {
  const task = buildSuggestTask({
    songs: [],
    researchSummary: '',
    themePrompt: '   ',
    currentDate: new Date('2026-05-01T12:00:00Z'),
  });

  assert.match(task, /No theme was provided/);
  assert.match(task, /Set theme_alignment to null/);
});

test('theme validation catches missing theme alignment across any recommendation', () => {
  const suggestions = {
    recommendations: [
      { rank: 1, title: 'A', theme_alignment: 'Summer sprinklers' },
      { rank: 2, title: 'B', theme_alignment: 'Summer beach day' },
      { rank: 3, title: 'C', theme_alignment: '' },
      { rank: 4, title: 'D', theme_alignment: 'Summer fireflies' },
      { rank: 5, title: 'E' },
    ],
  };

  assert.deepEqual(getThemeValidationFailures(suggestions, 'summer'), [
    'Recommendation 3 is missing theme_alignment',
    'Recommendation 5 is missing theme_alignment',
  ]);
});

test('theme validation requires exactly 5 recommendations', () => {
  const suggestions = {
    recommendations: [
      { rank: 1, theme_alignment: 'Summer' },
    ],
  };

  assert.deepEqual(getThemeValidationFailures(suggestions, 'summer'), [
    'Expected exactly 5 recommendations, got 1',
  ]);
});
