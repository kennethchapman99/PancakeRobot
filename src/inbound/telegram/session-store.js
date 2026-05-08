const sessions = new Map();

export function getTelegramSession(chatId) {
  const key = String(chatId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      chatId: key,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingMagicSong: null,
    });
  }
  return sessions.get(key);
}

export function updateTelegramSession(chatId, patch) {
  const session = getTelegramSession(chatId);
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  sessions.set(String(chatId), session);
  return session;
}

export function clearPendingMagicSong(chatId) {
  return updateTelegramSession(chatId, { pendingMagicSong: null });
}
