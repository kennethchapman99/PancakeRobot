import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findNonSingableLyricMarkup,
  prepareLyricsForRender,
  sanitizeLyricsForQA,
} from '../src/shared/song-qa.js';
import {
  findProviderLyricPayloadIssues,
  sanitizeLyricsForProvider,
} from '../src/shared/lyrics-sanitizer.js';
import { buildMiniMaxRequestBody } from '../src/agents/music-generator.js';

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

const adultDirtyLyrics = `[INTRO - VOCALS START IMMEDIATELY]
For Sue, this one's for Sue

[VERSE 1]
Ken is by your side

[CHORUS]
For Sue, the heart of this home
(clap clap)
Pancake Robot says beep boop

[BRIDGE — ROBOT MALFUNCTION SEQUENCE 🤖]
*music slows down, glitchy warping sounds*
For Sue, we love you more each year`;

const cleanAdultBalladLyrics = `[INTRO]
For Sue, this house learned love from you

[VERSE 1]
Eighteen years of mornings wrapped in grace
Ken sees the whole world soften in your face
Jayda came on Mother's Day like sunlight through the door
Myles came home into your arms, and gave us even more

[CHORUS]
For Sue, the heart of this home
Every room remembers how your love has grown
For Sue, through every ordinary day
You make a family out of everything you say

[VERSE 2]
Makena laughs and Cheddar stays close by your feet
Your garden turns the tired ground to something sweet

[FINAL CHORUS]
For Sue, the heart of this home
You deserve the best this world has ever known`;

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

test('prepares MiniMax render lyrics as singable words only for legacy kids flow', () => {
  const renderLyrics = prepareLyricsForRender(dirtyLyrics);

  assert.match(renderLyrics, /Something Went Wrong Again/);
  assert.match(renderLyrics, /Beep boop reboot that pancake pan/);
  assert.doesNotMatch(renderLyrics, /\[[^\]]+\]/);
  assert.doesNotMatch(renderLyrics, /🤖/);
  assert.doesNotMatch(renderLyrics, /ROBOT MALFUNCTION/);
  assert.doesNotMatch(renderLyrics, /music slows down/);
  assert.doesNotMatch(renderLyrics, /\*/);
});

test('provider sanitizer removes bracketed labels, production directions, markdown, parentheticals, and emoji', () => {
  const result = sanitizeLyricsForProvider(adultDirtyLyrics, {
    forbiddenElements: [],
    blockBrandContamination: false,
  });

  assert.match(result.lyrics, /For Sue, this one's for Sue/);
  assert.match(result.lyrics, /For Sue, the heart of this home/);
  assert.doesNotMatch(result.lyrics, /\[[^\]]+\]/);
  assert.doesNotMatch(result.lyrics, /\*/);
  assert.doesNotMatch(result.lyrics, /🤖/);
  assert.doesNotMatch(result.lyrics, /music slows/);
  assert.doesNotMatch(result.lyrics, /clap clap/i);
  assert.equal(result.removed.some(item => /section label/i.test(item.reason)), true);
  assert.equal(result.removed.some(item => /production/i.test(item.reason)), true);
  assert.deepEqual(findProviderLyricPayloadIssues(result.lyrics), []);
});

test('provider sanitizer fails closed on adult brand contamination', () => {
  const result = sanitizeLyricsForProvider(adultDirtyLyrics, {
    forbiddenElements: ['Pancake Robot', 'pancakes', 'beep boop', 'claps'],
    blockBrandContamination: true,
  });

  assert.equal(result.blocked, true);
  assert.equal(result.blockReason, 'Brand contamination blocked lyrics');
  assert.match(result.residualIssues.join('\n'), /forbidden active-profile element/);
});

test('clean adult ballad lyrics pass provider sanitizer', () => {
  const result = sanitizeLyricsForProvider(cleanAdultBalladLyrics, {
    forbiddenElements: ['Pancake Robot', 'pancakes', 'beep boop', 'claps', 'call-and-response'],
    blockBrandContamination: true,
  });

  assert.equal(result.blocked, false);
  assert.match(result.lyrics, /For Sue, this house learned love from you/);
  assert.match(result.lyrics, /For Sue, the heart of this home/);
  assert.deepEqual(result.residualIssues, []);
  assert.doesNotMatch(result.lyrics, /\[[^\]]+\]/);
});

test('final provider payload contains no section labels, markdown, emoji, or directions', () => {
  const sanitized = sanitizeLyricsForProvider(adultDirtyLyrics, {
    forbiddenElements: [],
    blockBrandContamination: false,
  });
  const body = buildMiniMaxRequestBody({
    model: 'music-2.6',
    prompt: 'slow heartfelt adult dedication ballad, 72-82 BPM, piano-led, gentle strings',
    lyrics: sanitized.lyrics,
  });

  assert.equal(body.lyrics_optimizer, false);
  assert.equal(body.is_instrumental, false);
  assert.doesNotMatch(body.lyrics, /\[[^\]]+\]/);
  assert.doesNotMatch(body.lyrics, /\*/);
  assert.doesNotMatch(body.lyrics, /🤖/);
  assert.doesNotMatch(body.lyrics, /music slows|vocals start|sfx|spoken|sound effect/i);
});
