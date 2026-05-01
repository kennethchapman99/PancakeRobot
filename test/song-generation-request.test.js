import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLockedSongGenerationRequest,
  extractLockedTitleFromTopic,
} from '../src/shared/song-generation-request.js';

test('generation request preserves UI title as locked title', () => {
  const request = buildLockedSongGenerationRequest({
    id: 'SONG_TEST_1234',
    title: 'Locked Test Title',
    topic: 'test topic',
    concept: 'test concept',
    target_age_range: 'all ages',
    mood_tags: ['bright'],
    keywords: ['test'],
  });

  assert.equal(request.lockedTitle, 'Locked Test Title');
  assert.equal(request.sourceSongId, 'SONG_TEST_1234');
  assert.equal(request.topic.includes('title: Locked Test Title'), true);
  assert.equal(request.topic.includes('locked_title: Locked Test Title'), true);
  assert.equal(request.topic.includes('opening hook, chorus hook, and final chorus hook'), true);
  assert.equal(request.topic.includes('test topic'), true);
});

test('extractLockedTitleFromTopic prefers locked_title and falls back to title', () => {
  assert.equal(
    extractLockedTitleFromTopic('title: Wrong\nlocked_title: Right Title\nsong_topic: test'),
    'Right Title'
  );
  assert.equal(
    extractLockedTitleFromTopic('title: Only Title\nsong_topic: test'),
    'Only Title'
  );
});
