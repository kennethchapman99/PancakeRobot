import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { renderMarketingTemplate } from './marketing-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SETUP_CONFIG_PATH = path.resolve(__dirname, '../../config/marketing-setup-checklist.json');

export function initMarketingSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_setup_items (
      key TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT,
      reference_url TEXT,
      status TEXT DEFAULT 'not_started',
      value TEXT,
      notes TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_targets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      platform TEXT,
      source_url TEXT NOT NULL,
      submission_url TEXT,
      contact_method TEXT,
      audience TEXT,
      fit_score INTEGER,
      ai_policy TEXT DEFAULT 'unclear',
      ai_risk_score INTEGER,
      recommendation TEXT DEFAULT 'manual_review',
      research_summary TEXT,
      status TEXT DEFAULT 'needs_review',
      approved_at TEXT,
      notes TEXT,
      raw_json TEXT,
      UNIQUE(name, source_url)
    );

    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      focus_song_id TEXT,
      objective TEXT,
      audience TEXT,
      channel_mix_json TEXT,
      approved_target_ids_json TEXT,
      brand_context_json TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS marketing_agent_runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      agent_name TEXT NOT NULL,
      run_type TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      input_json TEXT,
      output_json TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS marketing_agent_logs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      level TEXT DEFAULT 'info',
      message TEXT NOT NULL,
      data_json TEXT,
      FOREIGN KEY (run_id) REFERENCES marketing_agent_runs(id)
    );
  `);

  syncMarketingSetupItemsFromConfig();
}

export function loadMarketingSetupConfig(configPath = process.env.MARKETING_SETUP_CONFIG_PATH || DEFAULT_SETUP_CONFIG_PATH) {
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Marketing setup config not found: ${resolvedPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Marketing setup config must be a JSON array.');
  }

  return parsed.map((item, index) => {
    const missing = ['key', 'category', 'title'].filter(field => !item[field] || !String(item[field]).trim());
    if (missing.length) throw new Error(`Marketing setup item ${index} missing required field(s): ${missing.join(', ')}`);
    return {
      key: String(item.key).trim(),
      category: renderMarketingTemplate(String(item.category).trim()),
      title: renderMarketingTemplate(String(item.title).trim()),
      instructions: item.instructions ? renderMarketingTemplate(String(item.instructions).trim()) : null,
      reference_url: item.reference_url ? renderMarketingTemplate(String(item.reference_url).trim()) : null,
    };
  });
}

function syncMarketingSetupItemsFromConfig() {
  const db = getDb();
  const now = new Date().toISOString();
  const configItems = loadMarketingSetupConfig();
  const stmt = db.prepare(`
    INSERT INTO marketing_setup_items
      (key, category, title, instructions, reference_url, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'not_started', ?)
    ON CONFLICT(key) DO UPDATE SET
      category = excluded.category,
      title = excluded.title,
      instructions = excluded.instructions,
      reference_url = excluded.reference_url,
      updated_at = excluded.updated_at
  `);

  for (const item of configItems) {
    stmt.run(item.key, item.category, item.title, item.instructions, item.reference_url, now);
  }
}

export function getMarketingSetupItems() {
  initMarketingSchema();
  return getDb().prepare('SELECT * FROM marketing_setup_items ORDER BY category, rowid').all();
}

export function updateMarketingSetupItem(key, fields = {}) {
  initMarketingSchema();
  const allowed = ['status', 'value', 'notes'];
  const updates = { updated_at: new Date().toISOString() };

  for (const field of allowed) {
    if (fields[field] !== undefined) updates[field] = fields[field] || null;
  }

  if (updates.status === 'done') updates.completed_at = new Date().toISOString();
  if (updates.status && updates.status !== 'done') updates.completed_at = null;

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE marketing_setup_items SET ${setClause} WHERE key = ?`).run(...Object.values(updates), key);
}

export function getMarketingTargets(filters = {}) {
  initMarketingSchema();
  const clauses = [];
  const params = [];

  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.type) {
    clauses.push('type = ?');
    params.push(filters.type);
  }
  if (filters.q) {
    clauses.push('(LOWER(name) LIKE ? OR LOWER(platform) LIKE ? OR LOWER(audience) LIKE ? OR LOWER(research_summary) LIKE ?)');
    const q = `%${filters.q.toLowerCase()}%`;
    params.push(q, q, q, q);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM marketing_targets ${where} ORDER BY updated_at DESC, created_at DESC`).all(...params);
}

export function getApprovedMarketingTargets() {
  initMarketingSchema();
  return getDb().prepare(`SELECT * FROM marketing_targets WHERE status = 'approved' ORDER BY updated_at DESC`).all();
}

export function upsertMarketingTarget(target) {
  initMarketingSchema();
  validateTarget(target);

  const now = new Date().toISOString();
  const id = target.id || stableTargetId(target.name, target.source_url);
  const existing = getDb().prepare('SELECT * FROM marketing_targets WHERE id = ? OR (name = ? AND source_url = ?)').get(id, target.name, target.source_url);

  const payload = {
    id,
    created_at: existing?.created_at || now,
    updated_at: now,
    name: target.name.trim(),
    type: target.type.trim(),
    platform: optionalText(target.platform),
    source_url: target.source_url.trim(),
    submission_url: optionalText(target.submission_url),
    contact_method: optionalText(target.contact_method),
    audience: optionalText(target.audience),
    fit_score: toNullableInt(target.fit_score),
    ai_policy: optionalText(target.ai_policy) || 'unclear',
    ai_risk_score: toNullableInt(target.ai_risk_score),
    recommendation: optionalText(target.recommendation) || 'manual_review',
    research_summary: optionalText(target.research_summary),
    status: optionalText(target.status) || existing?.status || 'needs_review',
    approved_at: target.status === 'approved' ? now : existing?.approved_at || null,
    notes: optionalText(target.notes),
    raw_json: JSON.stringify(target.raw_json || target),
  };

  getDb().prepare(`
    INSERT INTO marketing_targets
      (id, created_at, updated_at, name, type, platform, source_url, submission_url, contact_method, audience,
       fit_score, ai_policy, ai_risk_score, recommendation, research_summary, status, approved_at, notes, raw_json)
    VALUES
      (@id, @created_at, @updated_at, @name, @type, @platform, @source_url, @submission_url, @contact_method, @audience,
       @fit_score, @ai_policy, @ai_risk_score, @recommendation, @research_summary, @status, @approved_at, @notes, @raw_json)
    ON CONFLICT(name, source_url) DO UPDATE SET
      updated_at = excluded.updated_at,
      type = excluded.type,
      platform = excluded.platform,
      submission_url = excluded.submission_url,
      contact_method = excluded.contact_method,
      audience = excluded.audience,
      fit_score = excluded.fit_score,
      ai_policy = excluded.ai_policy,
      ai_risk_score = excluded.ai_risk_score,
      recommendation = excluded.recommendation,
      research_summary = excluded.research_summary,
      notes = excluded.notes,
      raw_json = excluded.raw_json
  `).run(payload);

  return id;
}

export function updateMarketingTarget(id, fields = {}) {
  initMarketingSchema();
  const allowed = ['status', 'notes', 'recommendation', 'ai_policy', 'ai_risk_score', 'fit_score'];
  const updates = { updated_at: new Date().toISOString() };

  for (const field of allowed) {
    if (fields[field] !== undefined) updates[field] = fields[field] || null;
  }
  if (updates.status === 'approved') updates.approved_at = new Date().toISOString();
  if (updates.status && updates.status !== 'approved') updates.approved_at = null;

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE marketing_targets SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
}

export function createMarketingCampaign(campaign) {
  initMarketingSchema();
  const now = new Date().toISOString();
  const id = campaign.id || `MKT_CAMPAIGN_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO marketing_campaigns
      (id, created_at, updated_at, name, status, focus_song_id, objective, audience, channel_mix_json, approved_target_ids_json, brand_context_json, notes)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    now,
    now,
    campaign.name,
    campaign.status || 'draft',
    campaign.focus_song_id || null,
    campaign.objective || null,
    campaign.audience || null,
    JSON.stringify(campaign.channel_mix || []),
    JSON.stringify(campaign.approved_target_ids || []),
    JSON.stringify(campaign.brand_context || {}),
    campaign.notes || null,
  );
  return id;
}

export function getMarketingCampaigns(limit = 25) {
  initMarketingSchema();
  return getDb().prepare('SELECT * FROM marketing_campaigns ORDER BY created_at DESC LIMIT ?').all(limit).map(parseCampaign);
}

function parseCampaign(row) {
  if (!row) return null;
  return {
    ...row,
    channel_mix: parseJsonArray(row.channel_mix_json),
    approved_target_ids: parseJsonArray(row.approved_target_ids_json),
    brand_context: parseJsonObject(row.brand_context_json),
  };
}

export function createMarketingAgentRun({ agentName, runType, input }) {
  initMarketingSchema();
  const id = `MKT_RUN_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO marketing_agent_runs (id, created_at, agent_name, run_type, status, input_json)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(id, new Date().toISOString(), agentName, runType, JSON.stringify(input || {}));
  return id;
}

export function logMarketingAgentRun(runId, level, message, data = null) {
  initMarketingSchema();
  const id = `MKT_LOG_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO marketing_agent_logs (id, run_id, created_at, level, message, data_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, runId, new Date().toISOString(), level || 'info', message, data ? JSON.stringify(data) : null);
}

export function finishMarketingAgentRun(runId, status, output = null, error = null) {
  initMarketingSchema();
  getDb().prepare(`
    UPDATE marketing_agent_runs SET finished_at = ?, status = ?, output_json = ?, error = ? WHERE id = ?
  `).run(new Date().toISOString(), status, output ? JSON.stringify(output) : null, error || null, runId);
}

export function getMarketingAgentRuns(limit = 20) {
  initMarketingSchema();
  return getDb().prepare('SELECT * FROM marketing_agent_runs ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function getMarketingAgentLogs(runId) {
  initMarketingSchema();
  return getDb().prepare('SELECT * FROM marketing_agent_logs WHERE run_id = ? ORDER BY created_at ASC').all(runId);
}

export function getMarketingSummary() {
  initMarketingSchema();
  const db = getDb();
  const setup = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
    FROM marketing_setup_items
  `).get();

  const targets = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) as needs_review,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
    FROM marketing_targets
  `).get();

  const campaigns = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM marketing_campaigns
  `).get();

  const runs = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN status LIKE 'blocked%' THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
    FROM marketing_agent_runs
  `).get();

  return { setup, targets, campaigns, runs };
}

function validateTarget(target) {
  const missing = [];
  if (!target?.name || !String(target.name).trim()) missing.push('name');
  if (!target?.type || !String(target.type).trim()) missing.push('type');
  if (!target?.source_url || !String(target.source_url).trim()) missing.push('source_url');
  if (missing.length) throw new Error(`Marketing target missing required field(s): ${missing.join(', ')}`);
}

function stableTargetId(name, sourceUrl) {
  return `MKT_TGT_${createHash('sha1').update(`${name}|${sourceUrl}`).digest('hex').slice(0, 12).toUpperCase()}`;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function toNullableInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
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
