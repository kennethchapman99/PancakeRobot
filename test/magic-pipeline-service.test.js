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
