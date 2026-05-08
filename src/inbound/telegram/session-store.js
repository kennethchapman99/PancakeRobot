import {
  clearTelegramPendingMagicSong,
  getTelegramSessionRecord,
  updateTelegramSessionRecord,
} from '../../shared/telegram-session-db.js';

export function getTelegramSession(chatId) {
  return getTelegramSessionRecord(chatId);
}

export function updateTelegramSession(chatId, patch) {
  return updateTelegramSessionRecord(chatId, {
    userId: patch.userId,
    lastMessageId: patch.lastMessageId,
    pendingMagicSong: patch.pendingMagicSong,
  });
}

export function clearPendingMagicSong(chatId) {
  return clearTelegramPendingMagicSong(chatId);
}
