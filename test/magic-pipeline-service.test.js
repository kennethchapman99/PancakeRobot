import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PIPELINE_APP_SLUG = `test-magic-service-${Date.now()}`;

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
