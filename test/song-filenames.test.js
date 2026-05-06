import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('slugifySongFilename creates lowercase filesystem-safe names', async () => {
  const { slugifySongFilename } = await import(`../src/shared/song-filenames.js?slug=${Date.now()}`);
  assert.equal(slugifySongFilename('My Animal Sounds Are Broken'), 'my-animal-sounds-are-broken.mp3');
  assert.equal(slugifySongFilename('Cranky! Pancakes? #1', 'wav'), 'cranky-pancakes-1.wav');
});

test('buildUniqueSongFilename appends numeric suffixes for collisions', async () => {
  const { buildUniqueSongFilename } = await import(`../src/shared/song-filenames.js?slug=${Date.now()}b`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'song-filenames-'));

  try {
    fs.writeFileSync(path.join(dir, 'my-animal-sounds-are-broken.mp3'), 'one');
    fs.writeFileSync(path.join(dir, 'my-animal-sounds-are-broken-2.mp3'), 'two');
    assert.equal(
      buildUniqueSongFilename({ dir, title: 'My Animal Sounds Are Broken', ext: 'mp3' }),
      'my-animal-sounds-are-broken-3.mp3',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
