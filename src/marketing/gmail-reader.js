/**
 * Gmail reader — fetches and classifies inbox messages.
 * Read-only. Never sends, archives, or deletes.
 */

import { google } from 'googleapis';
import { getAuthorizedClient } from './gmail-auth.js';

// ─── Classification ────────────────────────────────────────────────────────────

const OPT_OUT_PATTERNS = [
  /\bopt.?out\b/i, /\bunsubscribe\b/i, /\bremove me\b/i,
  /\bdo not contact\b/i, /\bstop emailing\b/i, /\bstop contacting\b/i,
];
const PAID_PATTERNS = [
  /\bpaid placement\b/i, /\bsponsored\b/i, /\bpayment\b/i, /\bpricing\b/i,
  /\bfee\b/i, /\bpay\b/i, /\bguaranteed streams\b/i,
];
const CONFIRMATION_PATTERNS = [
  /\bsubmission received\b/i, /\bthank you for submitting\b/i,
  /\bwe received your\b/i, /\bsuccessfully submitted\b/i,
];
const POSITIVE_REPLY_PATTERNS = [
  /\bsend me the link\b/i, /\bwould love to hear\b/i,
  /\bsend it over\b/i, /\bsend me the track\b/i, /\bplease share\b/i,
];
const NO_REPLY_PATTERNS = [
  /\bno.?reply\b/i, /\bnoreply\b/i, /\bdo.not.reply\b/i,
];

export function classifyMessage(msg) {
  const subject = (msg.subject || '').toLowerCase();
  const body = (msg.body_text || '').toLowerCase();
  const from = (msg.from_email || '').toLowerCase();
  const combined = subject + ' ' + body;

  if (OPT_OUT_PATTERNS.some(p => p.test(combined))) {
    return { classification: 'do_not_contact', requires_ken: true, suggested_reply: null };
  }
  if (PAID_PATTERNS.some(p => p.test(combined))) {
    return { classification: 'opportunity', requires_ken: true, suggested_reply: null };
  }
  if (CONFIRMATION_PATTERNS.some(p => p.test(combined))) {
    return { classification: 'submission_confirmation', requires_ken: false, suggested_reply: null };
  }
  if (NO_REPLY_PATTERNS.some(p => p.test(from))) {
    return { classification: 'vendor_spam', requires_ken: false, suggested_reply: null };
  }
  if (POSITIVE_REPLY_PATTERNS.some(p => p.test(combined))) {
    return { classification: 'safe_reply_candidate', requires_ken: true, suggested_reply: 'Share asset links and streaming link' };
  }
  if (/\bplaylist\b/i.test(combined)) {
    return { classification: 'playlist_reply', requires_ken: true, suggested_reply: null };
  }
  if (/\bblog\b|\bmedia\b|\breview\b|\bpress\b/i.test(combined)) {
    return { classification: 'blog_media_reply', requires_ken: true, suggested_reply: null };
  }
  if (/\bcurator\b|\bcollection\b|\bfeature\b/i.test(combined)) {
    return { classification: 'creator_reply', requires_ken: true, suggested_reply: null };
  }
  return { classification: 'needs_ken', requires_ken: true, suggested_reply: null };
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

function parseHeader(headers, name) {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || null;
}

function parseFrom(fromHeader) {
  if (!fromHeader) return { from_name: null, from_email: null };
  const m = fromHeader.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { from_name: m[1].trim().replace(/^"|"$/g, ''), from_email: m[2].trim() };
  return { from_name: null, from_email: fromHeader.trim() };
}

function extractBodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64').toString('utf8');
    for (const part of payload.parts) {
      const nested = extractBodyText(part);
      if (nested) return nested;
    }
  }
  return '';
}

export async function fetchInboxMessages(options = {}) {
  const auth = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const query = options.query || `newer_than:${options.days || 14}d`;
  const maxResults = options.maxResults || 25;
  const labelIds = options.labelIds || ['INBOX'];

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
    labelIds,
  });

  const messageIds = listRes.data.messages || [];
  if (!messageIds.length) return [];

  const messages = [];
  for (const { id } of messageIds) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const m = full.data;
      const headers = m.payload?.headers || [];
      const from = parseFrom(parseHeader(headers, 'From'));
      const internalDate = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;

      const parsed = {
        gmail_message_id: m.id,
        gmail_thread_id: m.threadId,
        received_at: internalDate,
        from_email: from.from_email,
        from_name: from.from_name,
        subject: parseHeader(headers, 'Subject'),
        snippet: m.snippet || null,
        body_text: extractBodyText(m.payload),
        labels: m.labelIds || [],
        raw_json: { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet },
      };

      const cls = classifyMessage(parsed);
      messages.push({ ...parsed, ...cls });
    } catch (err) {
      console.warn(`[GMAIL-READER] Failed to fetch message ${id}: ${err.message}`);
    }
  }

  return messages;
}
