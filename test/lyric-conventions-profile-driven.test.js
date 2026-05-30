import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRenderSafetyPrompt, getLyricConventions } from '../src/shared/song-qa.js';
import { buildLyricsTask } from '../src/agents/lyricist.js';

test('default lyric conventions are profile friendly', () => {
  const conventions = getLyricConventions({
    audience: { explicitness: 'clean' },
    music: {},
    lyrics: {},
    songwriting: {},
  });

  assert.equal(conventions.title_usage, 'free');
  assert.equal(conventions.title_usage_required, false);
  assert.equal(conventions.require_chorus_or_hook, false);
  assert.equal(conventions.require_verse, false);
  assert.equal(conventions.allow_unconventional_structure, true);
});

test('render safety prompt treats title placement as optional by default', () => {
  const prompt = buildRenderSafetyPrompt('Hidden Title', {
    title_usage: 'free',
    title_usage_required: false,
    title_usage_location: 'anywhere',
  }).join('\n');

  assert.match(prompt, /artistically optional/i);
  assert.doesNotMatch(prompt, /opening vocal line/i);
});

test('strict title conventions still produce strict prompt guidance', () => {
  const prompt = buildRenderSafetyPrompt('Hidden Title', {
    title_usage: 'chorus_hook',
    title_usage_required: true,
    title_usage_location: 'chorus',
  }).join('\n');

  assert.match(prompt, /repeat the exact title/i);
});

test('lyricist prompt no longer globally forces one song shape', () => {
  const task = buildLyricsTask({ topic: 'title: Vanishing Signal' });

  assert.match(task, /Title usage in the singable lyrics is artistically optional/i);
  assert.match(task, /Do not force the exact title into the opening line or chorus unless it naturally fits/i);
  assert.doesNotMatch(task, /First singable line must contain the exact title/);
  assert.doesNotMatch(task, /Chorus: 4-8 lines, memorable, and built around the exact title/);
});
