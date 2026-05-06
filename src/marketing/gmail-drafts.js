/**
 * Gmail draft helper for marketing outreach.
 * Creates Gmail drafts only. It does not transmit messages.
 */

import { google } from 'googleapis';
import { getAuthorizedClient } from './gmail-auth.js';
import fs from 'fs';

export async function createGmailDraft({ to, subject, body, bodyHtml = '', cc = '', bcc = '', attachments = [], inlineImages = [], dryRun = false }) {
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
      inline_image_count: inlineImages.filter(file => file?.path && fs.existsSync(file.path)).length,
    };
  }

  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage({ to, cc, bcc, subject, body, bodyHtml, attachments, inlineImages });

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

function buildRawMessage({ to, cc, bcc, subject, body, bodyHtml = '', attachments = [], inlineImages = [] }) {
  const usableAttachments = attachments
    .filter(file => file?.path && fs.existsSync(file.path))
    .map(file => ({
      filename: sanitizeHeader(file.filename || file.path.split('/').pop()),
      contentType: sanitizeHeader(file.contentType || 'application/octet-stream'),
      content: fs.readFileSync(file.path).toString('base64'),
      disposition: 'attachment',
      cid: null,
    }));
  const usableInlineImages = inlineImages
    .filter(file => file?.path && fs.existsSync(file.path))
    .map(file => ({
      filename: sanitizeHeader(file.filename || file.path.split('/').pop()),
      contentType: sanitizeHeader(file.contentType || 'application/octet-stream'),
      content: fs.readFileSync(file.path).toString('base64'),
      disposition: sanitizeHeader(file.disposition || 'inline'),
      cid: sanitizeHeader(file.cid || `inline-${Date.now().toString(16)}`),
    }));

  if (!usableAttachments.length && !usableInlineImages.length && !bodyHtml) {
    return buildTextOnlyRawMessage({ to, cc, bcc, subject, body });
  }

  const headers = [
    `To: ${sanitizeHeader(to)}`,
    cc ? `Cc: ${sanitizeHeader(cc)}` : null,
    bcc ? `Bcc: ${sanitizeHeader(bcc)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const rootBoundary = `pancakerobot-root-${Date.now().toString(16)}`;
  const bodySection = buildBodySection({ body, bodyHtml, usableInlineImages });

  if (!usableAttachments.length) {
    headers.push(bodySection.contentType);
    const message = `${headers.join('\r\n')}\r\n\r\n${bodySection.content}`;
    return toRawBase64(message);
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${rootBoundary}"`);
  const parts = [
    `--${rootBoundary}`,
    bodySection.contentType,
    '',
    bodySection.content,
    '',
  ];

  for (const attachment of usableAttachments) {
    parts.push(
      `--${rootBoundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(attachment.content),
      '',
    );
  }

  parts.push(`--${rootBoundary}--`, '');
  return toRawBase64(`${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`);
}

function buildBodySection({ body, bodyHtml = '', usableInlineImages = [] }) {
  if (bodyHtml && usableInlineImages.length) {
    const relatedBoundary = `pancakerobot-related-${Date.now().toString(16)}`;
    const alternative = buildAlternativeBody({ body, bodyHtml });
    const parts = [
      `--${relatedBoundary}`,
      alternative.contentType,
      '',
      alternative.content,
      '',
    ];

    for (const image of usableInlineImages) {
      parts.push(
        `--${relatedBoundary}`,
        `Content-Type: ${image.contentType}; name="${image.filename}"`,
        `Content-Disposition: ${image.disposition}; filename="${image.filename}"`,
        `Content-ID: <${image.cid}>`,
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(image.content),
        '',
      );
    }

    parts.push(`--${relatedBoundary}--`, '');
    return {
      contentType: `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
      content: parts.join('\r\n'),
    };
  }

  if (bodyHtml) {
    return buildAlternativeBody({ body, bodyHtml });
  }

  if (usableInlineImages.length) {
    const relatedBoundary = `pancakerobot-related-${Date.now().toString(16)}`;
    const parts = [
      `--${relatedBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(String(body), 'utf8').toString('base64')),
      '',
    ];
    for (const image of usableInlineImages) {
      parts.push(
        `--${relatedBoundary}`,
        `Content-Type: ${image.contentType}; name="${image.filename}"`,
        `Content-Disposition: ${image.disposition}; filename="${image.filename}"`,
        `Content-ID: <${image.cid}>`,
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(image.content),
        '',
      );
    }
    parts.push(`--${relatedBoundary}--`, '');
    return {
      contentType: `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
      content: parts.join('\r\n'),
    };
  }

  return {
    contentType: 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64',
    content: wrapBase64(Buffer.from(String(body), 'utf8').toString('base64')),
  };
}

function buildAlternativeBody({ body, bodyHtml }) {
  const alternativeBoundary = `pancakerobot-alt-${Date.now().toString(16)}`;
  const parts = [
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(String(body), 'utf8').toString('base64')),
    '',
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(String(bodyHtml), 'utf8').toString('base64')),
    '',
    `--${alternativeBoundary}--`,
    '',
  ];
  return {
    contentType: `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    content: parts.join('\r\n'),
  };
}

function buildTextOnlyRawMessage({ to, cc, bcc, subject, body }) {
  const headers = [
    `To: ${sanitizeHeader(to)}`,
    cc ? `Cc: ${sanitizeHeader(cc)}` : null,
    bcc ? `Bcc: ${sanitizeHeader(bcc)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);

  const message = `${headers.join('\r\n')}\r\n\r\n${wrapBase64(Buffer.from(String(body).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'))}`;
  return toRawBase64(message);
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

function toRawBase64(message) {
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
