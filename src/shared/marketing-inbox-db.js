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
      status TEXT DEFAULT 'new',
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function upsertInboxMessage(msg) {
  initInboxSchema();
  const now = new Date().toISOString();
  const id = `INBOX_${msg.gmail_message_id}`;
  getDb().prepare(`
    INSERT INTO marketing_inbox_messages
      (id, gmail_message_id, gmail_thread_id, received_at, from_email, from_name, subject, snippet,
       body_text, labels_json, classification, requires_ken, suggested_reply, status, raw_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(gmail_message_id) DO UPDATE SET
      updated_at=excluded.updated_at,
      classification=excluded.classification,
      requires_ken=excluded.requires_ken,
      suggested_reply=excluded.suggested_reply,
      status=excluded.status
  `).run(
    id, msg.gmail_message_id, msg.gmail_thread_id||null, msg.received_at||null,
    msg.from_email||null, msg.from_name||null, msg.subject||null, msg.snippet||null,
    msg.body_text||null, JSON.stringify(msg.labels||[]),
    msg.classification||'unclassified', msg.requires_ken ? 1 : 0,
    msg.suggested_reply||null, msg.status||'new',
    msg.raw_json ? JSON.stringify(msg.raw_json) : null,
    msg.created_at||now, now,
  );
  return id;
}

export function getInboxMessages(limit = 50, filters = {}) {
  initInboxSchema();
  const clauses = [];
  const params = [];
  if (filters.classification) { clauses.push('classification = ?'); params.push(filters.classification); }
  if (filters.requires_ken) { clauses.push('requires_ken = 1'); }
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
