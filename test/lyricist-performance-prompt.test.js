import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLyricsTask } from '../src/agents/lyricist.js';

const VALID_BRIEF = {
  vocal_conceit: 'bored delivery snapping into double-time every 4 bars',
  flow_movement: 'behind-beat swagger jumping ahead before punchlines',
  hook_behavior: 'clipped breath fragments forming chant, not smooth melody',
  adlib_personality: 'self-interrupting dry reactions',
  sonic_oddity: 'beat drops entirely before each punchline',
  emotional_contradiction: 'hard exterior over a crack of vulnerability',
  avoid_vs_previous_tracks: 'no chant hooks, no behind-beat start',
};

test('buildLyricsTask includes performance brief section when provided', () => {
  const task = buildLyricsTask({
    topic: 'test topic',
    researchReport: null,
    revisionNotes: null,
    existingLyrics: null,
    performanceBrief: VALID_BRIEF,
  });
  assert.ok(task.includes('HIDDEN PERFORMANCE BRIEF'), 'Should include the brief section header');
  assert.ok(task.includes('Vocal conceit:'), 'Should include vocal conceit label');
  assert.ok(task.includes('double-time'), 'Should include the brief vocal conceit content');
  assert.ok(task.includes('Hook behavior:'), 'Should include hook behavior');
  assert.ok(task.includes('Adlib personality:'), 'Should include adlib personality');
  assert.ok(task.includes('Sonic oddity:'), 'Should include sonic oddity');
});

test('buildLyricsTask does not include brief section when no brief', () => {
  const task = buildLyricsTask({
    topic: 'test topic',
    researchReport: null,
    revisionNotes: null,
    existingLyrics: null,
    performanceBrief: null,
  });
  assert.ok(!task.includes('HIDDEN PERFORMANCE BRIEF'), 'Should not include brief section for legacy profiles');
});

test('buildLyricsTask never includes real artist names in generation-facing content', () => {
  const task = buildLyricsTask({
    topic: 'test topic',
    researchReport: null,
    revisionNotes: null,
    existingLyrics: null,
    performanceBrief: VALID_BRIEF,
  });
  const lower = task.toLowerCase();
  const prohibitedNames = ['doechii', 'kendrick lamar', 'drake', 'eminem', 'kanye west'];
  for (const name of prohibitedNames) {
    assert.ok(!lower.includes(name), `Task should not contain artist name: ${name}`);
  }
});

test('buildLyricsTask includes revision notes when provided', () => {
  const task = buildLyricsTask({
    topic: 'test topic',
    researchReport: null,
    revisionNotes: 'Fix the hook to be more aggressive',
    existingLyrics: null,
    performanceBrief: null,
  });
  assert.ok(task.includes('Fix the hook to be more aggressive'));
  assert.ok(task.includes('REVISION NOTES'));
});

test('buildLyricsTask includes existing lyrics context in revision mode', () => {
  const task = buildLyricsTask({
    topic: 'test topic',
    researchReport: null,
    revisionNotes: 'Make it darker',
    existingLyrics: '[VERSE 1]\nExisting lyrics here',
    performanceBrief: null,
  });
  assert.ok(task.startsWith('Revise'));
  assert.ok(task.includes('Existing lyrics here'));
  assert.ok(task.includes('EDITOR FEEDBACK'));
});

test('buildLyricsTask marks "Write" mode when no existing lyrics', () => {
  const task = buildLyricsTask({
    topic: 'test topic',
    researchReport: null,
    revisionNotes: null,
    existingLyrics: null,
    performanceBrief: null,
  });
  assert.ok(task.startsWith('Write'));
});
