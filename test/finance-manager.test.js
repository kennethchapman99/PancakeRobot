import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCostEvent,
  computeFlatGenerationCost,
  computeTokenCost,
  summarizeCostEvents,
} from '../src/shared/finance-manager.js';

const pricing = {
  version: 'test-pricing',
  currency: 'USD',
  providers: {
    anthropic: {
      models: {
        sonnet: {
          input_usd_per_1m: 3,
          cached_input_usd_per_1m: 0.3,
          output_usd_per_1m: 15,
        },
      },
    },
    minimax: {
      models: {
        'music-2.6-free': { flat_usd_per_generation: 0 },
        'music-2.6': { flat_usd_per_generation: 1.5 },
      },
    },
  },
};

test('computeTokenCost calculates input, cached input, output, and reasoning token cost', () => {
  const result = computeTokenCost({
    provider: 'anthropic',
    model: 'sonnet',
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 1_000_000,
    pricing,
  });

  assert.equal(result.costUsd, 33.3);
  assert.deepEqual(result.pricingMissing, []);
});

test('computeTokenCost reports missing pricing without throwing', () => {
  const result = computeTokenCost({
    provider: 'anthropic',
    model: 'unknown-model',
    inputTokens: 100,
    outputTokens: 100,
    pricing,
  });

  assert.equal(result.costUsd, 0);
  assert.deepEqual(result.pricingMissing, ['input_usd_per_1m', 'output_usd_per_1m']);
});

test('computeFlatGenerationCost supports free and paid generation pricing', () => {
  assert.equal(computeFlatGenerationCost({ provider: 'minimax', model: 'music-2.6-free', pricing }).costUsd, 0);
  assert.equal(computeFlatGenerationCost({ provider: 'minimax', model: 'music-2.6', generationCount: 2, pricing }).costUsd, 3);
});

test('buildCostEvent marks unknown-priced successful events as estimated', () => {
  const event = buildCostEvent({
    songId: 'SONG_TEST',
    runId: 'run_test',
    agentName: 'lyricist',
    provider: 'anthropic',
    model: 'missing',
    inputTokens: 100,
    outputTokens: 200,
    pricing,
  });

  assert.equal(event.status, 'estimated');
  assert.equal(event.pipeline_step, 'lyrics_generation');
  assert.equal(event.song_id, 'SONG_TEST');
});

test('summarizeCostEvents aggregates by pipeline step and status', () => {
  const events = [
    buildCostEvent({
      id: 'a',
      songId: 'SONG_TEST',
      pipelineStep: 'lyrics_generation',
      provider: 'anthropic',
      model: 'sonnet',
      inputTokens: 1_000_000,
      outputTokens: 0,
      pricing,
    }),
    buildCostEvent({
      id: 'b',
      songId: 'SONG_TEST',
      pipelineStep: 'music_generation',
      provider: 'minimax',
      model: 'music-2.6',
      unitType: 'audio_generation',
      generationCount: 1,
      pricing,
    }),
  ];

  const summary = summarizeCostEvents(events);
  assert.equal(summary.total_cost_usd, 4.5);
  assert.equal(summary.by_pipeline_step.lyrics_generation.cost_usd, 3);
  assert.equal(summary.by_pipeline_step.music_generation.cost_usd, 1.5);
  assert.equal(summary.event_count, 2);
});
