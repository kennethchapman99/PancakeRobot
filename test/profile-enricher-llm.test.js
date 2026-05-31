import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEnrichmentTask,
  enrichProfileWithLLM,
  validateEnrichmentResult,
  ENRICHER_OUTPUT_FIELDS,
} from '../src/agents/profile-enricher.js';

function makeProfile(overrides = {}) {
  return {
    brand_name: 'Test Brand',
    display_name: 'Test Brand',
    character: { name: 'Tester', core_concept: 'test character with specific voice' },
    music: { default_style: 'old-school boom-bap hip-hop', default_bpm: 92, default_prompt: 'hard hitting drums, vinyl samples' },
    songwriting: {
      song_type: 'hip_hop',
      primary_emotional_goal: 'raw, technical, aggressive hip-hop with character',
      voice_perspective: 'first person bravado and street storytelling',
      character_voice: { tone: 'confrontational and witty', vocabulary: 'street slang, vivid imagery' },
      forbidden_elements: ['smooth pop delivery'],
      anti_repetition_rules: ['no two consecutive tracks with the same hook style'],
    },
    audience: { guardrail: 'adult content OK', explicitness: 'explicit_allowed' },
    ...overrides,
  };
}

function makeValidEnrichmentResponse() {
  return {
    vocal_performance_engine: {
      priority: 'Voice must feel like a street conversation that can turn dangerous at any moment',
      vocal_textures: ['clipped hard consonants', 'gravel on long vowels', 'sudden sotto voce drops'],
      timing_behaviors: ['behind the beat in verses, snaps ahead on punchlines'],
      adlib_behaviors: ['one-word self-correction adlibs', 'disbelieving mumbles after boasts'],
      avoid: ['smooth melodic delivery', 'generic hype call-and-response'],
    },
    performance_conceit_bank: [
      'the MC stumbles mid-boast then recovers with a harder line — the stumble is the joke',
      'entire verse delivered in a bored monotone until the last bar erupts',
      'hook is a single scratched phrase that changes meaning each time it returns',
    ],
    album_mode_lanes: [
      { name: 'cypher heat', description: 'back-to-back technical bars, minimal hooks, competition energy' },
      { name: 'block story', description: 'narrative verse, specific characters, neighborhood detail' },
    ],
    song_differentiation_rules: [
      'No two consecutive tracks may use the same hook delivery style',
      'Vary the entry point — not every track opens with a verse',
    ],
    anti_generic_rules: [
      'Never produce a song where any MC could substitute for the character without noticeably changing the feel',
      'Avoid empowerment language not filtered through this character\'s specific wit and cynicism',
    ],
    do_not_repeat_across_album: [
      'same scratch pattern as any prior track',
      'same boast category (money/women/skill) on consecutive tracks',
    ],
    hidden_brief_requirements: [
      'The brief must specify a scratch usage that has not appeared on any prior track on this album',
      'The brief must describe how the punchline timing differs from the preceding track',
    ],
  };
}

function makeMockRunner(responseObj) {
  return async (_name, _def, task, _opts) => ({
    text: JSON.stringify(responseObj),
    costUsd: 0.0421,
    runId: 'mock-run-123',
    taskSnapshot: task,
  });
}

// --- buildEnrichmentTask ---

test('buildEnrichmentTask includes brand_name and character name', () => {
  const profile = makeProfile();
  const task = buildEnrichmentTask(profile);
  assert.ok(task.includes('Test Brand'), 'task should include brand_name');
  assert.ok(task.includes('Tester'), 'task should include character name');
});

test('buildEnrichmentTask includes user notes when provided', () => {
  const profile = makeProfile();
  const task = buildEnrichmentTask(profile, 'i love scratching and tempo switches');
  assert.ok(task.includes('scratching'), 'task should include user notes');
  assert.ok(task.includes('NOTES FROM PROFILE OWNER'), 'task should have notes section header');
});

test('buildEnrichmentTask omits notes section when notes are empty', () => {
  const profile = makeProfile();
  const task = buildEnrichmentTask(profile, '');
  assert.ok(!task.includes('NOTES FROM PROFILE OWNER'), 'task should not have notes section when empty');
});

test('buildEnrichmentTask includes existing songwriting context', () => {
  const profile = makeProfile();
  const task = buildEnrichmentTask(profile);
  assert.ok(task.includes('raw, technical, aggressive'), 'task should include primary_emotional_goal');
  assert.ok(task.includes('smooth pop delivery'), 'task should include forbidden_elements');
});

// --- validateEnrichmentResult ---

test('validateEnrichmentResult passes for valid response', () => {
  const result = makeValidEnrichmentResponse();
  const failures = validateEnrichmentResult(result);
  assert.deepEqual(failures, []);
});

test('validateEnrichmentResult catches missing required fields', () => {
  const result = makeValidEnrichmentResponse();
  delete result.album_mode_lanes;
  delete result.anti_generic_rules;
  const failures = validateEnrichmentResult(result);
  assert.ok(failures.some(f => f.includes('album_mode_lanes')), 'should flag missing album_mode_lanes');
  assert.ok(failures.some(f => f.includes('anti_generic_rules')), 'should flag missing anti_generic_rules');
});

test('validateEnrichmentResult rejects bare field names in hidden_brief_requirements', () => {
  const result = makeValidEnrichmentResponse();
  result.hidden_brief_requirements = ['vocal_conceit', 'flow_movement', 'hook_behavior'];
  const failures = validateEnrichmentResult(result);
  assert.ok(failures.some(f => f.includes('bare field names')), 'should flag bare field names');
});

test('validateEnrichmentResult rejects non-object result', () => {
  const failures = validateEnrichmentResult(null);
  assert.ok(failures.length > 0);
  const failures2 = validateEnrichmentResult('string');
  assert.ok(failures2.length > 0);
});

// --- enrichProfileWithLLM ---

test('enrichProfileWithLLM returns structured result with mock runner', async () => {
  const profile = makeProfile();
  const mockRunner = makeMockRunner(makeValidEnrichmentResponse());
  const result = await enrichProfileWithLLM(profile, { runner: mockRunner });

  assert.ok(result.songwriting, 'result should have songwriting');
  assert.ok(typeof result.costUsd === 'number', 'result should have costUsd');
  assert.ok(result.runId === 'mock-run-123', 'result should have runId');

  for (const key of ENRICHER_OUTPUT_FIELDS) {
    assert.ok(key in result.songwriting, `result.songwriting should have ${key}`);
  }
});

test('enrichProfileWithLLM passes user notes to runner', async () => {
  const profile = makeProfile();
  let capturedTask = null;
  const capturingRunner = async (_name, _def, task, _opts) => {
    capturedTask = task;
    return { text: JSON.stringify(makeValidEnrichmentResponse()), costUsd: 0, runId: 'x' };
  };

  await enrichProfileWithLLM(profile, { userNotes: 'love scratching and tempo changes', runner: capturingRunner });
  assert.ok(capturedTask.includes('love scratching'), 'user notes should appear in the task sent to LLM');
});

test('enrichProfileWithLLM throws on invalid LLM response shape', async () => {
  const profile = makeProfile();
  const badRunner = makeMockRunner({ not_a_valid_field: true });

  await assert.rejects(
    () => enrichProfileWithLLM(profile, { runner: badRunner }),
    /invalid result/i,
    'should throw on invalid shape',
  );
});

test('enrichProfileWithLLM strips extra keys LLM adds beyond the 7 required', async () => {
  const profile = makeProfile();
  const extraResponse = { ...makeValidEnrichmentResponse(), extra_field: 'should be removed', another_extra: [] };
  const mockRunner = makeMockRunner(extraResponse);

  const result = await enrichProfileWithLLM(profile, { runner: mockRunner });
  assert.ok(!('extra_field' in result.songwriting), 'extra_field should be stripped');
  assert.ok(!('another_extra' in result.songwriting), 'another_extra should be stripped');
  assert.equal(Object.keys(result.songwriting).length, ENRICHER_OUTPUT_FIELDS.length);
});

test('enrichProfileWithLLM does not include real artist names in built task', () => {
  const profile = makeProfile({
    music: { default_style: 'old-school boom-bap hip-hop', default_bpm: 92, default_prompt: 'hard drums' },
  });
  const task = buildEnrichmentTask(profile);
  // The task itself (the prompt going TO the LLM) should not contain artist names in the profile data
  // since this test profile doesn't have them. Verify the system instruction language is in there.
  assert.ok(task.toLowerCase().includes('do not include any real artist names'), 'task should remind LLM not to use real artist names');
});
