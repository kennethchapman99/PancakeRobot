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

test('submitted songs switch to release kit publishing and then outreach', async () => {
  const { getSongNextAction } = await import(`../src/shared/song-workflow.js?workflow=${Date.now()}b`);
  const shared = {
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
  };

  const publishAction = getSongNextAction({ id: 'SONG_3', status: 'submitted to DistroKid' }, shared);
  assert.equal(publishAction.nextActionKey, 'PUBLISH_RELEASE_KIT');

  const outreachAction = getSongNextAction(
    { id: 'SONG_3', status: 'submitted to DistroKid' },
    {
      ...shared,
      marketing_assets: { ...shared.marketing_assets, release_kit_published: true },
    },
  );
  assert.equal(outreachAction.nextActionKey, 'START_OUTREACH');
  assert.equal(outreachAction.blocking, false);
  assert.ok(outreachAction.missing.includes('audio download link'));
});
