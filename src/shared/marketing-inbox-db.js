/**
 * Marketing inbox DB — stores classified Gmail messages.
 * Read-only from Gmail. Never deletes, archives, or sends email.
 */

import { getDb } from './db.js';

export function initInboxSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_inbox_messages (
      id TEXT PRIMARY KEY,
      gmail_message_id TEXT UNIQUE NOT NULL,
      gmail_thread_id TEXT,
      campaign_id TEXT,
      release_marketing_id TEXT,
      outreach_item_id TEXT,
      target_id TEXT,
      received_at TEXT,
      from_email TEXT,
      from_name TEXT,
      subject TEXT,
      snippet TEXT,
      body_text TEXT,
      labels_json TEXT,
      classification TEXT DEFAULT 'unclassified',
      requires_ken INTEGER DEFAULT 0,
      suggested_reply TEXT,
      result_status TEXT,
      status TEXT DEFAULT 'new',
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  for (const [col, type] of [
    ['campaign_id', 'TEXT'],
    ['release_marketing_id', 'TEXT'],
    ['outreach_item_id', 'TEXT'],
    ['target_id', 'TEXT'],
    ['result_status', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE marketing_inbox_messages ADD COLUMN ${col} ${type}`); } catch {}
  }
}

export function upsertInboxMessage(msg) {
  initInboxSchema();
  const now = new Date().toISOString();
  const id = `INBOX_${msg.gmail_message_id}`;
  const existing = getDb().prepare(`
    SELECT id, status, classification, requires_ken, suggested_reply
    FROM marketing_inbox_messages
    WHERE gmail_message_id = ?
  `).get(msg.gmail_message_id);

  getDb().prepare(`
    INSERT INTO marketing_inbox_messages
      (id, gmail_message_id, gmail_thread_id, campaign_id, release_marketing_id, outreach_item_id, target_id,
       received_at, from_email, from_name, subject, snippet, body_text, labels_json,
       classification, requires_ken, suggested_reply, result_status, status, raw_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(gmail_message_id) DO UPDATE SET
      gmail_thread_id=excluded.gmail_thread_id,
      campaign_id=COALESCE(excluded.campaign_id, marketing_inbox_messages.campaign_id),
      release_marketing_id=COALESCE(excluded.release_marketing_id, marketing_inbox_messages.release_marketing_id),
      outreach_item_id=COALESCE(excluded.outreach_item_id, marketing_inbox_messages.outreach_item_id),
      target_id=COALESCE(excluded.target_id, marketing_inbox_messages.target_id),
      received_at=COALESCE(excluded.received_at, marketing_inbox_messages.received_at),
      from_email=COALESCE(excluded.from_email, marketing_inbox_messages.from_email),
      from_name=COALESCE(excluded.from_name, marketing_inbox_messages.from_name),
      subject=COALESCE(excluded.subject, marketing_inbox_messages.subject),
      snippet=COALESCE(excluded.snippet, marketing_inbox_messages.snippet),
      body_text=COALESCE(excluded.body_text, marketing_inbox_messages.body_text),
      labels_json=excluded.labels_json,
      raw_json=COALESCE(excluded.raw_json, marketing_inbox_messages.raw_json),
      updated_at=excluded.updated_at,
      classification=excluded.classification,
      requires_ken=excluded.requires_ken,
      suggested_reply=excluded.suggested_reply,
      result_status=COALESCE(excluded.result_status, marketing_inbox_messages.result_status),
      status=marketing_inbox_messages.status
  `).run(
    id, msg.gmail_message_id, msg.gmail_thread_id||null, msg.campaign_id||null, msg.release_marketing_id||null, msg.outreach_item_id||null, msg.target_id||null, msg.received_at||null,
    msg.from_email||null, msg.from_name||null, msg.subject||null, msg.snippet||null,
    msg.body_text||null, JSON.stringify(msg.labels||[]),
    msg.classification||'unclassified', msg.requires_ken ? 1 : 0,
    msg.suggested_reply||null, msg.result_status||null, msg.status||'new',
    msg.raw_json ? JSON.stringify(msg.raw_json) : null,
    msg.created_at||now, now,
  );
  return { id, isNew: !existing };
}

export function getInboxMessages(limit = 50, filters = {}) {
  initInboxSchema();
  const clauses = [];
  const params = [];
  if (filters.classification) { clauses.push('classification = ?'); params.push(filters.classification); }
  if (filters.requires_ken) { clauses.push('requires_ken = 1'); }
  if (filters.release_marketing_id) { clauses.push('release_marketing_id = ?'); params.push(filters.release_marketing_id); }
  if (filters.campaign_id) { clauses.push('campaign_id = ?'); params.push(filters.campaign_id); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM marketing_inbox_messages ${where} ORDER BY received_at DESC LIMIT ?`).all(...params, limit);
}

export function getInboxSummary() {
  initInboxSchema();
  return getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN requires_ken=1 THEN 1 ELSE 0 END) as needs_ken,
      SUM(CASE WHEN classification='safe_reply_candidate' THEN 1 ELSE 0 END) as safe_reply_candidate,
      SUM(CASE WHEN classification='do_not_contact' THEN 1 ELSE 0 END) as do_not_contact,
      SUM(CASE WHEN classification='opportunity' THEN 1 ELSE 0 END) as opportunity,
      SUM(CASE WHEN classification='creator_reply' THEN 1 ELSE 0 END) as creator_reply,
      SUM(CASE WHEN classification='vendor_spam' THEN 1 ELSE 0 END) as vendor_spam,
      SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) as new_count
    FROM marketing_inbox_messages
  `).get();
}
