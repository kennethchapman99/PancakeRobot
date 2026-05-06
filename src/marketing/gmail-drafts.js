/**
 * Gmail draft helper for marketing outreach.
 * Creates Gmail drafts only. It does not transmit messages.
 */

import { google } from 'googleapis';
import { getAuthorizedClient } from './gmail-auth.js';
import fs from 'fs';

export async function createGmailDraft({ to, subject, body, cc = '', bcc = '', attachments = [], dryRun = false }) {
  if (!to || !String(to).trim()) throw new Error('Gmail draft requires a recipient email');
  if (!subject || !String(subject).trim()) throw new Error('Gmail draft requires a subject');
  if (!body || !String(body).trim()) throw new Error('Gmail draft requires a body');

  if (dryRun) {
    return {
      gmail_draft_id: `dryrun-draft-${Date.now().toString(36)}`,
      gmail_message_id: `dryrun-message-${Date.now().toString(36)}`,
      gmail_thread_id: `dryrun-thread-${Date.now().toString(36)}`,
      gmail_draft_url: null,
      dryRun: true,
      attachment_count: attachments.filter(file => file?.path && fs.existsSync(file.path)).length,
    };
  }

  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage({ to, cc, bcc, subject, body, attachments });

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
    gmail_draft_url: result.data.id ? `https://mail.google.com/mail/u/0/#drafts/${result.data.id}` : null,
  };
}

function buildRawMessage({ to, cc, bcc, subject, body, attachments = [] }) {
  const usableAttachments = attachments
    .filter(file => file?.path && fs.existsSync(file.path))
    .map(file => ({
      filename: sanitizeHeader(file.filename || file.path.split('/').pop()),
      contentType: sanitizeHeader(file.contentType || 'application/octet-stream'),
      content: fs.readFileSync(file.path).toString('base64'),
    }));

  if (!usableAttachments.length) {
    return buildTextOnlyRawMessage({ to, cc, bcc, subject, body });
  }

  const boundary = `pancakerobot-${Date.now().toString(16)}`;
  const headers = [
    `To: ${sanitizeHeader(to)}`,
    cc ? `Cc: ${sanitizeHeader(cc)}` : null,
    bcc ? `Bcc: ${sanitizeHeader(bcc)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    String(body).replace(/\r?\n/g, '\r\n'),
    '',
  ];

  for (const attachment of usableAttachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(attachment.content),
      '',
    );
  }

  parts.push(`--${boundary}--`, '');

  const message = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildTextOnlyRawMessage({ to, cc, bcc, subject, body }) {
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

function wrapBase64(value) {
  return String(value || '').match(/.{1,76}/g)?.join('\r\n') || '';
}

function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value) {
  const clean = sanitizeHeader(value);
  if (/^[\x00-\x7F]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}
