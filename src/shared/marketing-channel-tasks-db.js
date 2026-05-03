import { getDb } from './db.js';
import { logMarketingEvent } from './marketing-events-db.js';

export function initMarketingChannelTaskSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_channel_tasks (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      campaign_id TEXT,
      outreach_item_id TEXT NOT NULL,
      target_id TEXT,
      song_id TEXT,
      channel_type TEXT NOT NULL,
      action_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      manual_url TEXT,
      instructions TEXT,
      external_id TEXT,
      external_thread_id TEXT,
      submitted_at TEXT,
      completed_at TEXT,
      payload_json TEXT,
      UNIQUE(outreach_item_id, channel_type, action_type)
    );

    CREATE INDEX IF NOT EXISTS idx_marketing_channel_tasks_item ON marketing_channel_tasks(outreach_item_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_channel_tasks_campaign ON marketing_channel_tasks(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_marketing_channel_tasks_status ON marketing_channel_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_marketing_channel_tasks_channel ON marketing_channel_tasks(channel_type);
  `);
}

export function upsertChannelTask(task = {}) {
  initMarketingChannelTaskSchema();
  const now = new Date().toISOString();
  const id = task.id || `MKT_CH_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  getDb().prepare(`
    INSERT INTO marketing_channel_tasks
      (id, created_at, updated_at, campaign_id, outreach_item_id, target_id, song_id,
       channel_type, action_type, status, manual_url, instructions, external_id,
       external_thread_id, submitted_at, completed_at, payload_json)
    VALUES
      (@id, @created_at, @updated_at, @campaign_id, @outreach_item_id, @target_id, @song_id,
       @channel_type, @action_type, @status, @manual_url, @instructions, @external_id,
       @external_thread_id, @submitted_at, @completed_at, @payload_json)
    ON CONFLICT(outreach_item_id, channel_type, action_type) DO UPDATE SET
      updated_at = excluded.updated_at,
      campaign_id = excluded.campaign_id,
      target_id = excluded.target_id,
      song_id = excluded.song_id,
      status = CASE
        WHEN marketing_channel_tasks.status IN ('completed', 'submitted') THEN marketing_channel_tasks.status
        ELSE excluded.status
      END,
      manual_url = excluded.manual_url,
      instructions = excluded.instructions,
      external_id = COALESCE(excluded.external_id, marketing_channel_tasks.external_id),
      external_thread_id = COALESCE(excluded.external_thread_id, marketing_channel_tasks.external_thread_id),
      payload_json = excluded.payload_json
  `).run({
    id,
    created_at: task.created_at || now,
    updated_at: now,
    campaign_id: task.campaign_id || null,
    outreach_item_id: task.outreach_item_id,
    target_id: task.target_id || null,
    song_id: task.song_id || null,
    channel_type: task.channel_type,
    action_type: task.action_type,
    status: task.status || 'pending',
    manual_url: task.manual_url || null,
    instructions: task.instructions || null,
    external_id: task.external_id || null,
    external_thread_id: task.external_thread_id || null,
    submitted_at: task.submitted_at || null,
    completed_at: task.completed_at || null,
    payload_json: JSON.stringify(task.payload || {}),
  });

  logMarketingEvent({
    event_type: 'channel_task_upserted',
    campaign_id: task.campaign_id,
    outreach_item_id: task.outreach_item_id,
    target_id: task.target_id,
    song_id: task.song_id,
    channel_task_id: id,
    message: `${task.channel_type}/${task.action_type} task ${task.status || 'pending'}`,
    payload: task,
  });

  return id;
}

export function updateChannelTask(id, fields = {}) {
  initMarketingChannelTaskSchema();
  const allowed = ['status', 'manual_url', 'instructions', 'external_id', 'external_thread_id', 'submitted_at', 'completed_at'];
  const updates = { updated_at: new Date().toISOString() };
  for (const field of allowed) {
    if (fields[field] !== undefined) updates[field] = fields[field] || null;
  }
  if (updates.status === 'submitted' && !updates.submitted_at) updates.submitted_at = new Date().toISOString();
  if (updates.status === 'completed' && !updates.completed_at) updates.completed_at = new Date().toISOString();

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE marketing_channel_tasks SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);

  const task = getChannelTask(id);
  logMarketingEvent({
    event_type: 'channel_task_updated',
    campaign_id: task?.campaign_id,
    outreach_item_id: task?.outreach_item_id,
    target_id: task?.target_id,
    song_id: task?.song_id,
    channel_task_id: id,
    message: `Channel task updated: ${updates.status || 'fields'}`,
    payload: updates,
  });
}

export function getChannelTasks(filters = {}) {
  initMarketingChannelTaskSchema();
  const clauses = [];
  const params = [];
  if (filters.campaign_id) { clauses.push('campaign_id = ?'); params.push(filters.campaign_id); }
  if (filters.outreach_item_id) { clauses.push('outreach_item_id = ?'); params.push(filters.outreach_item_id); }
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (filters.channel_type) { clauses.push('channel_type = ?'); params.push(filters.channel_type); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM marketing_channel_tasks ${where} ORDER BY created_at DESC`).all(...params).map(parseTask);
}

export function getChannelTask(id) {
  initMarketingChannelTaskSchema();
  return parseTask(getDb().prepare('SELECT * FROM marketing_channel_tasks WHERE id = ?').get(id));
}

function parseTask(row) {
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
