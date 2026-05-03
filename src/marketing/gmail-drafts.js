/**
 * Gmail draft helper for marketing outreach.
 * Creates Gmail drafts only. It does not transmit messages.
 */

import { google } from 'googleapis';
import { getAuthorizedClient } from './gmail-auth.js';

export async function createGmailDraft({ to, subject, body, cc = '', bcc = '' }) {
  if (!to || !String(to).trim()) throw new Error('Gmail draft requires a recipient email');
  if (!subject || !String(subject).trim()) throw new Error('Gmail draft requires a subject');
  if (!body || !String(body).trim()) throw new Error('Gmail draft requires a body');

  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage({ to, cc, bcc, subject, body });

  const result = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw },
    },
  });

  return {
    gmail_draft_id: result.data.id,
    gmail_message_id: result.data.message?.id || null,
    gmail_thread_id: result.data.message?.threadId || null,
  };
}

function buildRawMessage({ to, cc, bcc, subject, body }) {
  const headers = [
    `To: ${sanitizeHeader(to)}`,
    cc ? `Cc: ${sanitizeHeader(cc)}` : null,
    bcc ? `Bcc: ${sanitizeHeader(bcc)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ].filter(Boolean);

  const message = `${headers.join('\r\n')}\r\n\r\n${String(body).replace(/\r?\n/g, '\r\n')}`;
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value) {
  const clean = sanitizeHeader(value);
  if (/^[\x00-\x7F]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}
