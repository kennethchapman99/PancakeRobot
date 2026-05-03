/**
 * Gmail draft creation.
 * Requires gmail.compose scope — re-run marketing:gmail:auth if you get a 403.
 * Never sends automatically. Creates a draft the user reviews and sends in Gmail.
 */

import { google } from 'googleapis';
import { getAuthorizedClient } from './gmail-auth.js';

/**
 * Create a Gmail draft.
 * @param {{ to: string, subject: string, body: string }} params
 * @returns {{ draftId: string, draftUrl: string }}
 */
export async function createGmailDraft({ to, subject, body }) {
  let auth;
  try {
    auth = await getAuthorizedClient();
  } catch (err) {
    throw new Error(`Gmail auth failed: ${err.message}`);
  }

  const gmail = google.gmail({ version: 'v1', auth });

  // RFC 2822 message
  const lines = [
    `To: ${to}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    `Subject: ${subject}`,
    '',
    body,
  ];
  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  let res;
  try {
    res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    });
  } catch (err) {
    if (err.code === 403 || err.status === 403 || String(err.message).includes('403')) {
      throw new Error(
        'Gmail compose permission required. Your current token only has read access. ' +
        'Re-authorize by running: npm run marketing:gmail:auth'
      );
    }
    throw new Error(`Gmail draft creation failed: ${err.message}`);
  }

  const draftId = res.data.id;
  return {
    draftId,
    draftUrl: `https://mail.google.com/mail/u/0/#drafts/${draftId}`,
  };
}
