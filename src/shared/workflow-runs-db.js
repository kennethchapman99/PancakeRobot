import { getDb } from './db.js';

function ensureWorkflowSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      source TEXT,
      requested_by TEXT,
      theme TEXT,
      brand_id TEXT,
      mode TEXT,
      song_id TEXT,
      current_step TEXT,
      idempotency_key TEXT UNIQUE,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      step_id TEXT,
      stage TEXT,
      message TEXT,
      payload_json TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at ON workflow_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_run_events_run_id ON workflow_run_events(run_id);
  `);
}

export function createWorkflowRunRecord(input) {
  ensureWorkflowSchema();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO workflow_runs
      (id, workflow_name, status, source, requested_by, theme, brand_id, mode, song_id, idempotency_key, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.workflowName || 'magic_song',
    input.status || 'created',
    input.source || null,
    input.requestedBy || null,
    input.theme || null,
    input.brandId || null,
    input.mode || null,
    input.songId || null,
    input.idempotencyKey || null,
    now,
    now
  );
  return getWorkflowRunRecord(input.runId);
}

export function getWorkflowRunRecord(runId) {
  ensureWorkflowSchema();
  const row = getDb().prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId);
  return parseWorkflowRun(row);
}

export function getWorkflowRunByIdempotencyKey(idempotencyKey) {
  ensureWorkflowSchema();
  if (!idempotencyKey) return null;
  const row = getDb().prepare('SELECT * FROM workflow_runs WHERE idempotency_key = ?').get(idempotencyKey);
  return parseWorkflowRun(row);
}

export function listWorkflowRuns({ limit = 50, status = null } = {}) {
  ensureWorkflowSchema();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const rows = status
    ? getDb().prepare('SELECT * FROM workflow_runs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, safeLimit)
    : getDb().prepare('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?').all(safeLimit);
  return rows.map(parseWorkflowRun);
}

export function updateWorkflowRunRecord(runId, patch = {}) {
  ensureWorkflowSchema();
  const allowed = [
    'status',
    'current_step',
    'song_id',
    'result_json',
    'error_json',
    'started_at',
    'completed_at',
    'failed_at',
  ];
  const updates = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (patch[key] !== undefined) updates[key] = patch[key];
  }
  if (patch.result !== undefined) updates.result_json = stringifyJson(patch.result);
  if (patch.error !== undefined) updates.error_json = stringifyJson(patch.error);

  const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  getDb().prepare(`UPDATE workflow_runs SET ${setClause} WHERE id = ?`).run(...Object.values(updates), runId);
  return getWorkflowRunRecord(runId);
}

export function recordWorkflowEvent(runId, event = {}) {
  ensureWorkflowSchema();
  const timestamp = event.timestamp || new Date().toISOString();
  const eventType = event.type || 'workflow_event';
  const id = `WFE_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  getDb().prepare(`
    INSERT INTO workflow_run_events
      (id, run_id, timestamp, event_type, step_id, stage, message, payload_json)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    runId,
    timestamp,
    eventType,
    event.stepId || null,
    event.stage || null,
    event.line || event.message || null,
    stringifyJson(event)
  );

  const runPatch = {};
  if (event.type === 'workflow_started') {
    runPatch.status = 'running';
    runPatch.started_at = timestamp;
  }
  if (event.type === 'step_started') {
    runPatch.status = 'running';
    runPatch.current_step = event.stepId || event.label || null;
  }
  if (event.type === 'pipeline_progress' && event.stage) {
    runPatch.current_step = event.stage;
  }
  if (event.type === 'workflow_completed') {
    runPatch.status = 'completed';
    runPatch.current_step = 'completed';
    runPatch.completed_at = timestamp;
    runPatch.result = event.result;
  }
  if (event.type === 'workflow_failed') {
    runPatch.status = 'failed';
    runPatch.current_step = 'failed';
    runPatch.failed_at = timestamp;
    runPatch.error = event.error;
  }
  if (Object.keys(runPatch).length > 0) updateWorkflowRunRecord(runId, runPatch);

  return id;
}

export function getWorkflowRunEvents(runId) {
  ensureWorkflowSchema();
  return getDb().prepare('SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY timestamp ASC, rowid ASC')
    .all(runId)
    .map(parseWorkflowEvent);
}

function parseWorkflowRun(row) {
  if (!row) return null;
  return {
    ...row,
    result: parseJsonObject(row.result_json),
    error: parseJsonObject(row.error_json),
  };
}

function parseWorkflowEvent(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJsonObject(row.payload_json),
  };
}

function stringifyJson(value) {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value); }
  catch { return JSON.stringify({ serialization_error: true, value: String(value) }); }
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
