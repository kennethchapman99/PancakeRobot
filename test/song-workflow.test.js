import test from 'node:test';
import assert from 'node:assert/strict';

test('submitted songs request HyperFollow first when missing', async () => {
  const { getSongNextAction } = await import(`../src/shared/song-workflow.js?workflow=${Date.now()}`);
  const action = getSongNextAction(
    { id: 'SONG_1', status: 'submitted to DistroKid' },
    {
      marketing_links: { smart_link: '' },
      marketing_assets: {},
      marketing_readiness: {},
    },
  );

  assert.equal(action.nextActionKey, 'ADD_HYPERFOLLOW');
  assert.equal(action.label, 'Add HyperFollow Link');
  assert.equal(action.blocking, true);
  assert.match(action.href, /tab=marketing/);
});

test('submitted songs switch to pack generation after HyperFollow is present', async () => {
  const { getSongNextAction } = await import(`../src/shared/song-workflow.js?workflow=${Date.now()}a`);
  const action = getSongNextAction(
    { id: 'SONG_2', status: 'submitted_to_tunecore' },
    {
      marketing_links: { smart_link: 'https://hyperfollow.example/song' },
      marketing_assets: { base_image_url: 'https://images.example/song.png' },
      marketing_readiness: {},
    },
  );

  assert.equal(action.status, 'submitted to DistroKid');
  assert.equal(action.nextActionKey, 'GENERATE_MARKETING_PACK');
  assert.equal(action.blocking, true);
});

test('submitted songs switch straight to outreach once HyperFollow and generated assets exist', async () => {
  const { getSongNextAction } = await import(`../src/shared/song-workflow.js?workflow=${Date.now()}b`);
  const action = getSongNextAction(
    { id: 'SONG_3', status: 'submitted to DistroKid' },
    {
    marketing_links: { smart_link: 'https://hyperfollow.example/song' },
    marketing_assets: {
      square_post_url: 'https://assets.example/square.png',
      generated_at: new Date().toISOString(),
      release_kit_published: false,
    },
    marketing_readiness: {
      missing_required_fields: [],
      missing_recommended_fields: ['audio_download_url'],
    },
    },
  );
  assert.equal(action.nextActionKey, 'START_OUTREACH');
  assert.equal(action.blocking, false);
  assert.ok(action.missing.includes('audio download link'));
});
