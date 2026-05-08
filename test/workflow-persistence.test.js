import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PIPELINE_APP_SLUG = `test-workflow-${Date.now()}`;

const workflowDb = await import('../src/shared/workflow-runs-db.js');
const telegramDb = await import('../src/shared/telegram-session-db.js');

test('workflow run persistence stores records and events', () => {
  const runId = `MAGIC_TEST_${Date.now()}`;

  workflowDb.createWorkflowRunRecord({
    runId,
    workflowName: 'magic_song',
    status: 'created',
    source: 'telegram',
    requestedBy: 'user-1',
    theme: 'robot pancake test',
    brandId: 'default',
    mode: 'human_review',
    songId: 'SONG_TEST',
    idempotencyKey: `idem:${runId}`,
  });

  workflowDb.recordWorkflowEvent(runId, {
    type: 'workflow_started',
    runId,
    workflow: 'magic_song',
  });

  workflowDb.recordWorkflowEvent(runId, {
    type: 'pipeline_progress',
    stage: 'generating_audio',
    line: 'Generating music',
  });

  workflowDb.recordWorkflowEvent(runId, {
    type: 'workflow_completed',
    result: { songId: 'SONG_TEST', previewUrl: '/songs/SONG_TEST' },
  });

  const record = workflowDb.getWorkflowRunRecord(runId);
  assert.equal(record.id, runId);
  assert.equal(record.status, 'completed');
  assert.equal(record.current_step, 'completed');
  assert.equal(record.result.songId, 'SONG_TEST');

  const events = workflowDb.getWorkflowRunEvents(runId);
  assert.equal(events.length, 3);
  assert.equal(events[1].stage, 'generating_audio');
});

test('telegram sessions persist pending magic song state', () => {
  const chatId = `chat-${Date.now()}`;

  telegramDb.updateTelegramSessionRecord(chatId, {
    userId: 'user-1',
    lastMessageId: '100',
    pendingMagicSong: {
      theme: 'tiny breakfast robot',
      requestedBy: 'user-1',
      sourceMessageId: '100',
    },
  });

  const session = telegramDb.getTelegramSessionRecord(chatId);
  assert.equal(session.chatId, chatId);
  assert.equal(session.userId, 'user-1');
  assert.equal(session.pendingMagicSong.theme, 'tiny breakfast robot');

  telegramDb.clearTelegramPendingMagicSong(chatId);
  const cleared = telegramDb.getTelegramSessionRecord(chatId);
  assert.equal(cleared.pendingMagicSong, null);
});

test('telegram request locks prevent duplicate starts', () => {
  const idempotencyKey = `telegram:test:${Date.now()}`;

  const first = telegramDb.createTelegramRequestLock({
    idempotencyKey,
    chatId: 'chat-1',
    userId: 'user-1',
    sourceMessageId: '200',
    callbackQueryId: 'cb-1',
    runId: 'MAGIC_LOCK_TEST',
  });

  const second = telegramDb.createTelegramRequestLock({
    idempotencyKey,
    chatId: 'chat-1',
    userId: 'user-1',
    sourceMessageId: '200',
    callbackQueryId: 'cb-2',
    runId: 'MAGIC_LOCK_TEST_DUPLICATE',
  });

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.lock.run_id, 'MAGIC_LOCK_TEST');
});
