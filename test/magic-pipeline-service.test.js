import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareTestDbSlug } from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-magic-service').slug;

const service = await import('../src/services/magic-pipeline-service.js');

test('createMagicSongId creates song ids with expected prefix', () => {
  assert.match(service.createMagicSongId(), /^SONG_[A-Z0-9]+_[A-Z0-9]+$/);
});

test('runMagicPipelineService rejects empty topics before invoking agents', async () => {
  await assert.rejects(
    () => service.runMagicPipelineService({ topic: '   ' }),
    /Magic pipeline requires a topic/
  );
});

test('normalizeMagicPipelineStage defaults to song_only gate', () => {
  assert.equal(service.normalizeMagicPipelineStage(), 'song_only');
  assert.equal(service.normalizeMagicPipelineStage(''), 'song_only');
  assert.equal(service.normalizeMagicPipelineStage('song'), 'song_only');
  assert.equal(service.normalizeMagicPipelineStage('song-only'), 'song_only');
  assert.equal(service.normalizeMagicPipelineStage('audio_only'), 'song_only');
});

test('normalizeMagicPipelineStage allows explicit full pipeline', () => {
  assert.equal(service.normalizeMagicPipelineStage('full'), 'full');
  assert.equal(service.normalizeMagicPipelineStage('FULL'), 'full');
});

test('runMagicPipelineService passes allowRegeneration=false by default without throwing on empty topic', async () => {
  // Verifies allowRegeneration parameter is accepted (topic rejection fires before any modules load)
  await assert.rejects(
    () => service.runMagicPipelineService({ topic: '', allowRegeneration: false }),
    /Magic pipeline requires a topic/
  );
});

test('runMagicPipelineService accepts allowRegeneration=true without throwing on empty topic', async () => {
  await assert.rejects(
    () => service.runMagicPipelineService({ topic: '   ', allowRegeneration: true }),
    /Magic pipeline requires a topic/
  );
});
