import { getDb } from './db.js';

export function initMarketingEventSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT DEFAULT 'system',
      campaign_id TEXT,
      outreach_item_id TEXT,
      target_id TEXT,
      song_id TEXT,
      channel_task_id TEXT,
      message TEXT,
      payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_marketing_events_campaign ON marketing_events(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_events_item ON marketing_events(outreach_item_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_events_target ON marketing_events(target_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_events_song ON marketing_events(song_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_events_type ON marketing_events(event_type);
  `);
}

export function logMarketingEvent(event = {}) {
  initMarketingEventSchema();
  const id = event.id || `MKT_EVT_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO marketing_events
      (id, created_at, event_type, actor, campaign_id, outreach_item_id, target_id, song_id, channel_task_id, message, payload_json)
    VALUES
      (@id, @created_at, @event_type, @actor, @campaign_id, @outreach_item_id, @target_id, @song_id, @channel_task_id, @message, @payload_json)
  `).run({
    id,
    created_at: event.created_at || new Date().toISOString(),
    event_type: event.event_type || event.type,
    actor: event.actor || 'system',
    campaign_id: event.campaign_id || null,
    outreach_item_id: event.outreach_item_id || event.item_id || null,
    target_id: event.target_id || null,
    song_id: event.song_id || null,
    channel_task_id: event.channel_task_id || null,
    message: event.message || null,
    payload_json: JSON.stringify(event.payload || {}),
  });
  return id;
}

export function getMarketingEvents(filters = {}) {
  initMarketingEventSchema();
  const clauses = [];
  const params = [];

  if (filters.campaign_id) { clauses.push('campaign_id = ?'); params.push(filters.campaign_id); }
  if (filters.outreach_item_id) { clauses.push('outreach_item_id = ?'); params.push(filters.outreach_item_id); }
  if (filters.target_id) { clauses.push('target_id = ?'); params.push(filters.target_id); }
  if (filters.song_id) { clauses.push('song_id = ?'); params.push(filters.song_id); }
  if (filters.event_type) { clauses.push('event_type = ?'); params.push(filters.event_type); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Number(filters.limit || 100);
  return getDb().prepare(`SELECT * FROM marketing_events ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit).map(parseEvent);
}

function parseEvent(row) {
  if (!row) return null;
  return { ...row, payload: parseJsonObject(row.payload_json) };
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
