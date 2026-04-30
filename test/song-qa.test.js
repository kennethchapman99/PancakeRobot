import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findNonSingableLyricMarkup,
  prepareLyricsForRender,
  sanitizeLyricsForQA,
} from '../src/shared/song-qa.js';

const dirtyLyrics = `# Something Went Wrong Again

**Key Hook:** Something Went Wrong Again
**Physical Action:** wobble your pancake pan
**Word Count:** ~160

---

[INTRO - VOCALS START IMMEDIATELY]
Something Went Wrong Again, beep beep begin

[CHORUS]
Something Went Wrong Again
Clap clap, try again
Wobble wobble, here we go
Something Went Wrong Again

[BRIDGE — ROBOT MALFUNCTION SEQUENCE 🤖]
*music slows down, glitchy warping sounds*
Beep boop reboot that pancake pan

[FINAL CHORUS]
Something Went Wrong Again
Clap clap, try again

[OUTRO]
What will we fix next?`;

test('flags lyric markup that can leak into sung audio', () => {
  const issues = findNonSingableLyricMarkup(dirtyLyrics).join('\n');

  assert.match(issues, /section labels must be plain \[INTRO\]/);
  assert.match(issues, /section labels must be plain \[BRIDGE\]/);
  assert.match(issues, /emoji found in lyrics/);
  assert.match(issues, /stage direction must be rewritten/);
});

test('sanitizes QA lyrics while preserving canonical section structure', () => {
  const qaLyrics = sanitizeLyricsForQA(dirtyLyrics);

  assert.match(qaLyrics, /\[INTRO\]/);
  assert.match(qaLyrics, /\[BRIDGE\]/);
  assert.match(qaLyrics, /Something Went Wrong Again/);
  assert.match(qaLyrics, /Beep boop reboot that pancake pan/);
  assert.doesNotMatch(qaLyrics, /ROBOT MALFUNCTION/);
  assert.doesNotMatch(qaLyrics, /🤖/);
  assert.doesNotMatch(qaLyrics, /music slows down/);
  assert.doesNotMatch(qaLyrics, /\*/);
});

test('prepares MiniMax render lyrics as singable words only', () => {
  const renderLyrics = prepareLyricsForRender(dirtyLyrics);

  assert.match(renderLyrics, /Something Went Wrong Again/);
  assert.match(renderLyrics, /Beep boop reboot that pancake pan/);
  assert.doesNotMatch(renderLyrics, /\[[^\]]+\]/);
  assert.doesNotMatch(renderLyrics, /🤖/);
  assert.doesNotMatch(renderLyrics, /ROBOT MALFUNCTION/);
  assert.doesNotMatch(renderLyrics, /music slows down/);
  assert.doesNotMatch(renderLyrics, /\*/);
});
