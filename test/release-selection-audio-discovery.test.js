import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolvePrimaryAudioPath } from '../src/agents/release-selection-agent.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmpRoot = path.join(repoRoot, 'output', 'tmp-tests', `audio-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeEmptyAudio(relativePath) {
  const filePath = path.join(tmpRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from([0]));
  return filePath;
}

test('release selection discovers generated source audio outside legacy audio directory', () => {
  const sourceAudio = writeEmptyAudio('media/source/original.mp3');

  assert.equal(resolvePrimaryAudioPath(tmpRoot), sourceAudio);
});

test('release selection prefers mastered audio when only recursive candidates exist', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  writeEmptyAudio('media/source/original.mp3');
  const masteredAudio = writeEmptyAudio('masters/local_fast_master/mastered_320.mp3');

  assert.equal(resolvePrimaryAudioPath(tmpRoot), masteredAudio);
});
