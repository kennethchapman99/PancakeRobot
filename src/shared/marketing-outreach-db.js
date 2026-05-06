import { getDb } from './db.js';

export function initMarketingOutreachSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_outreach_items (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      release_marketing_id TEXT,
      brand_profile_id TEXT,
      song_id TEXT,
      bundle_song_ids_json TEXT,
      target_id TEXT NOT NULL,
      outlet_name TEXT,
      status TEXT DEFAULT 'queued',
      outreach_mode TEXT DEFAULT 'single_release',
      requires_ken INTEGER DEFAULT 1,
      safety_status TEXT DEFAULT 'pending',
      safety_notes TEXT,
      selected_assets_json TEXT,
      release_context_json TEXT,
      outlet_context_json TEXT,
      subject TEXT,
      body TEXT,
      generation_method TEXT,
      gmail_draft_id TEXT,
      gmail_draft_url TEXT,
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      sent_at TEXT,
      replied_at TEXT,
      raw_json TEXT,
      UNIQUE(campaign_id, target_id, song_id)
    );

    CREATE INDEX IF NOT EXISTS idx_marketing_outreach_items_campaign ON marketing_outreach_items(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_outreach_items_song ON marketing_outreach_items(song_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_outreach_items_target ON marketing_outreach_items(target_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_outreach_items_status ON marketing_outreach_items(status);

    CREATE TABLE IF NOT EXISTS marketing_outreach_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      outreach_item_id TEXT,
      campaign_id TEXT,
      target_id TEXT NOT NULL,
      song_id TEXT,
      release_id TEXT,
      release_title TEXT,
      channel TEXT,
      recipient_name TEXT,
      recipient_email TEXT,
      recipient_handle TEXT,
      subject TEXT,
      message_body TEXT,
      status TEXT NOT NULL,
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      contacted_at TEXT,
      replied_at TEXT,
      notes TEXT,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_marketing_outreach_events_target ON marketing_outreach_events(target_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_outreach_events_release ON marketing_outreach_events(release_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_outreach_events_song ON marketing_outreach_events(song_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_outreach_events_status ON marketing_outreach_events(status);
  `);
  try { db.exec('ALTER TABLE marketing_outreach_items ADD COLUMN release_marketing_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE marketing_outreach_items ADD COLUMN gmail_draft_url TEXT'); } catch {}
}

export function createOutreachItem(item) {
  initMarketingOutreachSchema();
  const now = new Date().toISOString();
  const id = item.id || `MKT_OUT_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  getDb().prepare(`
    INSERT INTO marketing_outreach_items
      (id, created_at, updated_at, campaign_id, brand_profile_id, song_id, bundle_song_ids_json,
       release_marketing_id,
       target_id, outlet_name, status, outreach_mode, requires_ken, safety_status, safety_notes,
       selected_assets_json, release_context_json, outlet_context_json, subject, body,
       generation_method, gmail_draft_id, gmail_draft_url, gmail_message_id, gmail_thread_id, sent_at, replied_at, raw_json)
    VALUES
      (@id, @created_at, @updated_at, @campaign_id, @brand_profile_id, @song_id, @bundle_song_ids_json, @release_marketing_id,
       @target_id, @outlet_name, @status, @outreach_mode, @requires_ken, @safety_status, @safety_notes,
       @selected_assets_json, @release_context_json, @outlet_context_json, @subject, @body,
       @generation_method, @gmail_draft_id, @gmail_draft_url, @gmail_message_id, @gmail_thread_id, @sent_at, @replied_at, @raw_json)
    ON CONFLICT(campaign_id, target_id, song_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      outlet_name = excluded.outlet_name,
      release_marketing_id = COALESCE(excluded.release_marketing_id, marketing_outreach_items.release_marketing_id),
      status = CASE
        WHEN marketing_outreach_items.status IN ('sent', 'replied', 'do_not_contact') THEN marketing_outreach_items.status
        ELSE excluded.status
      END,
      outreach_mode = excluded.outreach_mode,
      requires_ken = excluded.requires_ken,
      safety_status = excluded.safety_status,
      safety_notes = excluded.safety_notes,
      selected_assets_json = excluded.selected_assets_json,
      release_context_json = excluded.release_context_json,
      outlet_context_json = excluded.outlet_context_json,
      raw_json = excluded.raw_json
  `).run({
    id,
    created_at: item.created_at || now,
    updated_at: now,
    campaign_id: item.campaign_id,
    brand_profile_id: item.brand_profile_id || null,
    song_id: item.song_id || null,
    bundle_song_ids_json: JSON.stringify(item.bundle_song_ids || []),
    release_marketing_id: item.release_marketing_id || null,
    target_id: item.target_id,
    outlet_name: item.outlet_name || null,
    status: item.status || 'queued',
    outreach_mode: item.outreach_mode || 'single_release',
    requires_ken: item.requires_ken === undefined ? 1 : (item.requires_ken ? 1 : 0),
    safety_status: item.safety_status || 'pending',
    safety_notes: item.safety_notes || null,
    selected_assets_json: JSON.stringify(item.selected_assets || []),
    release_context_json: JSON.stringify(item.release_context || []),
    outlet_context_json: JSON.stringify(item.outlet_context || {}),
    subject: item.subject || null,
    body: item.body || null,
    generation_method: item.generation_method || null,
    gmail_draft_id: item.gmail_draft_id || null,
    gmail_draft_url: item.gmail_draft_url || null,
    gmail_message_id: item.gmail_message_id || null,
    gmail_thread_id: item.gmail_thread_id || null,
    sent_at: item.sent_at || null,
    replied_at: item.replied_at || null,
    raw_json: JSON.stringify(item.raw_json || item),
  });

  return id;
}

export function updateOutreachItem(id, fields = {}) {
  initMarketingOutreachSchema();
  const allowed = [
    'status', 'requires_ken', 'safety_status', 'safety_notes', 'subject', 'body',
    'generation_method', 'gmail_draft_id', 'gmail_draft_url', 'gmail_message_id', 'gmail_thread_id',
    'sent_at', 'replied_at', 'release_marketing_id',
  ];
  const updates = { updated_at: new Date().toISOString() };

  for (const field of allowed) {
    if (fields[field] !== undefined) {
      updates[field] = field === 'requires_ken' ? (fields[field] ? 1 : 0) : fields[field];
    }
  }

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE marketing_outreach_items SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
}

export function createOutreachEvent(event) {
  initMarketingOutreachSchema();
  const now = new Date().toISOString();
  const id = event.id || `MKT_EVT_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO marketing_outreach_events
      (id, created_at, updated_at, outreach_item_id, campaign_id, target_id, song_id, release_id, release_title,
       channel, recipient_name, recipient_email, recipient_handle, subject, message_body, status,
       gmail_message_id, gmail_thread_id, contacted_at, replied_at, notes, raw_json)
    VALUES
      (@id, @created_at, @updated_at, @outreach_item_id, @campaign_id, @target_id, @song_id, @release_id, @release_title,
       @channel, @recipient_name, @recipient_email, @recipient_handle, @subject, @message_body, @status,
       @gmail_message_id, @gmail_thread_id, @contacted_at, @replied_at, @notes, @raw_json)
  `).run({
    id,
    created_at: event.created_at || now,
    updated_at: now,
    outreach_item_id: event.outreach_item_id || null,
    campaign_id: event.campaign_id || null,
    target_id: event.target_id,
    song_id: event.song_id || null,
    release_id: event.release_id || event.song_id || null,
    release_title: event.release_title || null,
    channel: event.channel || null,
    recipient_name: event.recipient_name || null,
    recipient_email: event.recipient_email || null,
    recipient_handle: event.recipient_handle || null,
    subject: event.subject || null,
    message_body: event.message_body || null,
    status: event.status || 'sent',
    gmail_message_id: event.gmail_message_id || null,
    gmail_thread_id: event.gmail_thread_id || null,
    contacted_at: event.contacted_at || now,
    replied_at: event.replied_at || null,
    notes: event.notes || null,
    raw_json: JSON.stringify(event.raw_json || event),
  });
  return id;
}

export function getOutreachEvents(filters = {}) {
  initMarketingOutreachSchema();
  const clauses = [];
  const params = [];

  if (filters.campaign_id) { clauses.push('campaign_id = ?'); params.push(filters.campaign_id); }
  if (filters.song_id) { clauses.push('song_id = ?'); params.push(filters.song_id); }
  if (filters.release_id) { clauses.push('release_id = ?'); params.push(filters.release_id); }
  if (filters.target_id) { clauses.push('target_id = ?'); params.push(filters.target_id); }
  if (Array.isArray(filters.target_ids) && filters.target_ids.length) {
    clauses.push(`target_id IN (${filters.target_ids.map(() => '?').join(',')})`);
    params.push(...filters.target_ids);
  }
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (Array.isArray(filters.statuses) && filters.statuses.length) {
    clauses.push(`status IN (${filters.statuses.map(() => '?').join(',')})`);
    params.push(...filters.statuses);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM marketing_outreach_events ${where} ORDER BY contacted_at DESC, created_at DESC`)
    .all(...params)
    .map(parseOutreachEvent);
}

export function getOutreachItems(filters = {}) {
  initMarketingOutreachSchema();
  const clauses = [];
  const params = [];

  if (filters.campaign_id) { clauses.push('campaign_id = ?'); params.push(filters.campaign_id); }
  if (filters.song_id) { clauses.push('song_id = ?'); params.push(filters.song_id); }
  if (filters.release_marketing_id) { clauses.push('release_marketing_id = ?'); params.push(filters.release_marketing_id); }
  if (filters.target_id) { clauses.push('target_id = ?'); params.push(filters.target_id); }
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM marketing_outreach_items ${where} ORDER BY created_at DESC`).all(...params).map(parseOutreachItem);
}

export function getOutreachItem(id) {
  initMarketingOutreachSchema();
  return parseOutreachItem(getDb().prepare('SELECT * FROM marketing_outreach_items WHERE id = ?').get(id));
}

export function getOutreachSummary() {
  initMarketingOutreachSchema();
  return getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status='draft_generated' THEN 1 ELSE 0 END) as draft_generated,
      SUM(CASE WHEN status='ready_for_gmail_draft' THEN 1 ELSE 0 END) as ready_for_gmail_draft,
      SUM(CASE WHEN status='gmail_draft_created' THEN 1 ELSE 0 END) as gmail_draft_created,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN requires_ken=1 THEN 1 ELSE 0 END) as requires_ken
    FROM marketing_outreach_items
  `).get();
}

function parseOutreachItem(row) {
  if (!row) return null;
  return {
    ...row,
    requires_ken: Boolean(row.requires_ken),
    release_marketing_id: row.release_marketing_id || null,
    bundle_song_ids: parseJsonArray(row.bundle_song_ids_json),
    selected_assets: parseJsonArray(row.selected_assets_json),
    release_context: parseJsonArray(row.release_context_json),
    outlet_context: parseJsonObject(row.outlet_context_json),
    raw: parseJsonObject(row.raw_json),
  };
}

function parseOutreachEvent(row) {
  if (!row) return null;
  return {
    ...row,
    raw: parseJsonObject(row.raw_json),
  };
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
