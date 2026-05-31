import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPerformanceBriefTask,
  validatePerformanceBrief,
  normalizePerformanceBrief,
  generatePerformanceBrief,
  checkAlbumConceitVariety,
  PERFORMANCE_BRIEF_REQUIRED_FIELDS,
} from '../src/agents/performance-brief.js';

const ENRICHED_PROFILE = {
  brand_name: 'Razor Bloom',
  character: { name: 'Razor Bloom', core_concept: 'experimental hard rap villain character' },
  songwriting: {
    song_type: 'experimental_hard_rap',
    allowed_elements: ['hard language'],
    forbidden_elements: [],
    required_elements: [],
    structure_preferences: [],
    vocal_performance_engine: {
      priority: 'vocal is the main instrument',
      vocal_textures: ['clipped consonants', 'dry delivery', 'double-time bursts'],
      timing_behaviors: ['behind-the-beat swagger', 'snap-ahead double-time'],
      adlib_behaviors: ['self-interrupting adlibs', 'call-and-response with self'],
      avoid: ['smooth radio delivery', 'single steady flow'],
    },
    performance_conceit_bank: [
      'the vocal sounds bored until every fourth bar snaps into double-time',
      'adlibs argue with the lead vocal like a second personality',
      'hook built from clipped breath fragments',
      'beat drops out before punchlines',
    ],
    album_mode_lanes: [
      { name: 'pressure track', description: 'dense flows and beat-stop punchlines' },
      { name: 'club menace', description: 'bass-forward and chantable' },
    ],
    anti_generic_rules: [
      'every track must have a vocal gimmick recognizable in 10 seconds',
    ],
    do_not_repeat_across_album: ['same vocal conceit on two tracks'],
    song_differentiation_rules: ['adjacent tracks must differ in hook type'],
    hidden_brief_requirements: PERFORMANCE_BRIEF_REQUIRED_FIELDS,
  },
};

const LEGACY_PROFILE = {
  brand_name: 'Simple Band',
  character: { name: 'Simple', core_concept: 'basic pop' },
  songwriting: { song_type: 'pop', allowed_elements: [], forbidden_elements: [], required_elements: [], structure_preferences: [] },
};

function makeMockRunner(responseObj) {
  return async function mockRunner(agentId, agentDef, task, options) {
    return {
      text: JSON.stringify(responseObj),
      costUsd: 0.002,
      runId: 'test-run-id',
    };
  };
}

const VALID_BRIEF = {
  vocal_conceit: 'bored delivery snapping into double-time every 4 bars',
  flow_movement: 'behind-beat swagger jumping ahead before punchlines',
  hook_behavior: 'clipped breath fragments forming chant, not smooth melody',
  adlib_personality: 'self-interrupting, argues with lead, dry one-word reactions',
  sonic_oddity: 'beat drops entirely before each punchline leaving vocal exposed',
  emotional_contradiction: 'hard exterior over a private crack of vulnerability at bar 12',
  avoid_vs_previous_tracks: 'no chant hooks, no behind-beat start since track 1 already uses that',
};

// --- validatePerformanceBrief ---

test('validatePerformanceBrief returns empty array for valid brief', () => {
  const failures = validatePerformanceBrief(VALID_BRIEF);
  assert.deepEqual(failures, []);
});

test('validatePerformanceBrief catches missing required fields', () => {
  const failures = validatePerformanceBrief({ vocal_conceit: 'test' });
  assert.ok(failures.length >= 6, `Expected 6+ failures, got ${failures.length}: ${failures.join(', ')}`);
});

test('validatePerformanceBrief catches non-object input', () => {
  const failures = validatePerformanceBrief('not an object');
  assert.equal(failures[0], 'performance brief is not an object');
});

test('validatePerformanceBrief catches null', () => {
  const failures = validatePerformanceBrief(null);
  assert.equal(failures[0], 'performance brief is not an object');
});

// --- normalizePerformanceBrief ---

test('normalizePerformanceBrief returns all required fields trimmed', () => {
  const brief = normalizePerformanceBrief({ ...VALID_BRIEF, extra_field: 'ignored' });
  for (const field of PERFORMANCE_BRIEF_REQUIRED_FIELDS) {
    assert.ok(typeof brief[field] === 'string', `${field} should be a string`);
  }
  assert.equal(brief.extra_field, undefined);
});

// --- buildPerformanceBriefTask ---

test('buildPerformanceBriefTask includes brand name and character', () => {
  const task = buildPerformanceBriefTask({ brandProfile: ENRICHED_PROFILE, topic: 'test song' });
  assert.ok(task.includes('Razor Bloom'));
  assert.ok(task.includes('test song'));
});

test('buildPerformanceBriefTask includes vocal performance engine', () => {
  const task = buildPerformanceBriefTask({ brandProfile: ENRICHED_PROFILE, topic: 'test song' });
  assert.ok(task.includes('double-time'));
  assert.ok(task.includes('clipped consonants'));
});

test('buildPerformanceBriefTask includes performance conceit bank', () => {
  const task = buildPerformanceBriefTask({ brandProfile: ENRICHED_PROFILE, topic: 'test song' });
  assert.ok(task.includes('PERFORMANCE CONCEIT BANK'));
  assert.ok(task.includes('adlibs argue with the lead vocal'));
});

test('buildPerformanceBriefTask includes album context when provided', () => {
  const albumContext = { primary_lane: 'pressure track', contaminating_lane: 'club menace', track_lane: 'pressure track', assigned_conceit: 'bored-to-double-time flip', track_number: 2, track_count: 6 };
  const task = buildPerformanceBriefTask({ brandProfile: ENRICHED_PROFILE, albumContext, topic: 'test song' });
  assert.ok(task.includes('ALBUM LANE SELECTION'));
  assert.ok(task.includes('pressure track'));
});

test('buildPerformanceBriefTask includes prior tracks when provided', () => {
  const priorTracks = [{ track_number: 1, title: 'Track One', assigned_conceit: 'bored delivery', emotional_role: 'opener' }];
  const task = buildPerformanceBriefTask({ brandProfile: ENRICHED_PROFILE, priorTracks, topic: 'test song' });
  assert.ok(task.includes('PRIOR TRACKS'));
  assert.ok(task.includes('Track One'));
});

test('buildPerformanceBriefTask omits prior tracks section when empty', () => {
  const task = buildPerformanceBriefTask({ brandProfile: ENRICHED_PROFILE, priorTracks: [], topic: 'test song' });
  assert.ok(task.includes('first or only track'));
});

// --- generatePerformanceBrief with mock runner ---

test('generatePerformanceBrief returns brief with mock runner', async () => {
  const result = await generatePerformanceBrief({
    brandProfile: ENRICHED_PROFILE,
    topic: 'test song',
    runner: makeMockRunner(VALID_BRIEF),
  });
  assert.ok(result.brief);
  assert.equal(result.costUsd, 0.002);
  for (const field of PERFORMANCE_BRIEF_REQUIRED_FIELDS) {
    assert.ok(result.brief[field], `${field} should be present`);
  }
});

test('generatePerformanceBrief throws when runner returns invalid brief', async () => {
  await assert.rejects(
    generatePerformanceBrief({
      brandProfile: ENRICHED_PROFILE,
      topic: 'test song',
      runner: makeMockRunner({ vocal_conceit: 'only one field' }),
    }),
    /invalid shape/
  );
});

// --- Artist name leak ---

test('buildPerformanceBriefTask does not include real artist names', () => {
  const task = buildPerformanceBriefTask({ brandProfile: ENRICHED_PROFILE, topic: 'test song' });
  const artistNames = ['doechii', 'kendrick', 'drake', 'eminem', 'kanye'];
  for (const name of artistNames) {
    assert.ok(!task.toLowerCase().includes(name), `Task should not contain artist name: ${name}`);
  }
});

// --- checkAlbumConceitVariety ---

test('checkAlbumConceitVariety passes when all conceits differ', () => {
  const briefs = [
    { vocal_conceit: 'bored delivery snapping into double-time' },
    { vocal_conceit: 'hook built from clipped breath fragments only' },
    { vocal_conceit: 'beat drops out before each punchline' },
  ];
  const result = checkAlbumConceitVariety(briefs);
  assert.equal(result.passed, true);
  assert.equal(result.warnings.length, 0);
});

test('checkAlbumConceitVariety warns on duplicate vocal conceit prefix', () => {
  const briefs = [
    { vocal_conceit: 'bored delivery that snaps into double-time every 4 bars' },
    { vocal_conceit: 'bored delivery that snaps into double-time on the hook' },
    { vocal_conceit: 'completely different approach here' },
  ];
  const result = checkAlbumConceitVariety(briefs);
  assert.equal(result.passed, false);
  assert.ok(result.warnings.length > 0);
});

test('checkAlbumConceitVariety handles empty array gracefully', () => {
  const result = checkAlbumConceitVariety([]);
  assert.equal(result.passed, true);
});

// --- Legacy profile skip ---

test('hasEnrichedPerformanceFields false for legacy profile', async () => {
  const { hasEnrichedPerformanceFields } = await import('../src/shared/brand-profile.js');
  assert.equal(hasEnrichedPerformanceFields(LEGACY_PROFILE), false);
});

test('hasEnrichedPerformanceFields true for enriched profile', async () => {
  const { hasEnrichedPerformanceFields } = await import('../src/shared/brand-profile.js');
  assert.equal(hasEnrichedPerformanceFields(ENRICHED_PROFILE), true);
});
