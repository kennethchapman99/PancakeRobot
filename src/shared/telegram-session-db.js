import { getDb } from './db.js';

function ensureTelegramSessionSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_sessions (
      chat_id TEXT PRIMARY KEY,
      user_id TEXT,
      pending_magic_song_json TEXT,
      last_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS telegram_request_locks (
      idempotency_key TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      user_id TEXT,
      source_message_id TEXT,
      callback_query_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
  `);
}

export function getTelegramSessionRecord(chatId) {
  ensureTelegramSessionSchema();
  const key = String(chatId);
  const existing = getDb().prepare('SELECT * FROM telegram_sessions WHERE chat_id = ?').get(key);
  if (existing) return parseTelegramSession(existing);

  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO telegram_sessions (chat_id, created_at, updated_at)
    VALUES (?, ?, ?)
  `).run(key, now, now);
  return parseTelegramSession(getDb().prepare('SELECT * FROM telegram_sessions WHERE chat_id = ?').get(key));
}

export function updateTelegramSessionRecord(chatId, patch = {}) {
  ensureTelegramSessionSchema();
  getTelegramSessionRecord(chatId);
  const updates = { updated_at: new Date().toISOString() };
  if (patch.userId !== undefined) updates.user_id = patch.userId;
  if (patch.lastMessageId !== undefined) updates.last_message_id = String(patch.lastMessageId || '');
  if (patch.pendingMagicSong !== undefined) updates.pending_magic_song_json = stringifyJson(patch.pendingMagicSong);

  const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  getDb().prepare(`UPDATE telegram_sessions SET ${setClause} WHERE chat_id = ?`).run(...Object.values(updates), String(chatId));
  return getTelegramSessionRecord(chatId);
}

export function clearTelegramPendingMagicSong(chatId) {
  return updateTelegramSessionRecord(chatId, { pendingMagicSong: null });
}

export function buildTelegramMagicSongIdempotencyKey({ chatId, messageId, callbackQueryId, brandId }) {
  return [
    'telegram_magic_song',
    chatId,
    messageId || callbackQueryId,
    brandId,
  ].map(value => String(value || '').trim()).filter(Boolean).join(':').toLowerCase();
}

export function createTelegramRequestLock({ idempotencyKey, chatId, userId, sourceMessageId, callbackQueryId, runId }) {
  ensureTelegramSessionSchema();
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO telegram_request_locks
      (idempotency_key, chat_id, user_id, source_message_id, callback_query_id, run_id, status, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, 'created', ?, ?)
  `).run(
    idempotencyKey,
    String(chatId),
    userId ? String(userId) : null,
    sourceMessageId ? String(sourceMessageId) : null,
    callbackQueryId ? String(callbackQueryId) : null,
    runId || null,
    now,
    now
  );

  return {
    inserted: result.changes > 0,
    lock: getTelegramRequestLock(idempotencyKey),
  };
}

export function updateTelegramRequestLock(idempotencyKey, patch = {}) {
  ensureTelegramSessionSchema();
  const updates = { updated_at: new Date().toISOString() };
  if (patch.runId !== undefined) updates.run_id = patch.runId;
  if (patch.status !== undefined) updates.status = patch.status;
  const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  getDb().prepare(`UPDATE telegram_request_locks SET ${setClause} WHERE idempotency_key = ?`).run(...Object.values(updates), idempotencyKey);
  return getTelegramRequestLock(idempotencyKey);
}

export function getTelegramRequestLock(idempotencyKey) {
  ensureTelegramSessionSchema();
  return getDb().prepare('SELECT * FROM telegram_request_locks WHERE idempotency_key = ?').get(idempotencyKey) || null;
}

function parseTelegramSession(row) {
  if (!row) return null;
  return {
    chatId: row.chat_id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageId: row.last_message_id,
    pendingMagicSong: parseJsonObject(row.pending_magic_song_json),
  };
}

function stringifyJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
