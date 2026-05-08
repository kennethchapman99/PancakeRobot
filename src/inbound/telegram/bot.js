import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../../.env'), override: true });

import { handleTelegramCallback, handleTelegramMessage } from './magic-song-handler.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_SECONDS = 25;

class TelegramClient {
  constructor(token) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
    this.token = token;
    this.baseUrl = `${TELEGRAM_API_BASE}/bot${token}`;
  }

  async call(method, payload = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(`Telegram ${method} failed: ${data.description || response.statusText}`);
    }
    return data.result;
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
      ...extra,
    });
  }

  answerCallbackQuery(callbackQueryId, text = '') {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  getUpdates(offset) {
    return this.call('getUpdates', {
      offset,
      timeout: POLL_TIMEOUT_SECONDS,
      allowed_updates: ['message', 'callback_query'],
    });
  }
}

function parseAllowedUserIds() {
  return new Set(
    String(process.env.TELEGRAM_ALLOWED_USER_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUserIds = parseAllowedUserIds();

  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (allowedUserIds.size === 0) throw new Error('TELEGRAM_ALLOWED_USER_IDS is required');

  const telegram = new TelegramClient(token);
  let offset = 0;

  console.log('Telegram Magic Song bot started.');
  console.log(`Authorized Telegram users: ${allowedUserIds.size}`);

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;

        try {
          if (update.message) {
            await handleTelegramMessage({ telegram, message: update.message, allowedUserIds });
          } else if (update.callback_query) {
            await handleTelegramCallback({ telegram, callbackQuery: update.callback_query, allowedUserIds });
          }
        } catch (error) {
          console.error('[telegram:update-error]', error);
          const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          if (chatId) await telegram.sendMessage(chatId, 'Telegram command failed. Check server logs for details.');
        }
      }
    } catch (error) {
      console.error('[telegram:poll-error]', error.message);
      await delay(3000);
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
