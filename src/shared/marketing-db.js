import { createHash } from 'crypto';
import { getDb } from './db.js';

const SETUP_ITEMS = [
  {
    key: 'gmail_account',
    category: 'Identity',
    title: 'Create dedicated Pancake Robot Gmail account',
    instructions: 'Create a new Gmail account used only for Pancake Robot marketing and creator/curator replies. Store the email address here after it exists. Do not connect auto-send until the inbox labels and escalation rules are verified.',
    reference_url: 'https://accounts.google.com/signup',
  },
  {
    key: 'gmail_labels',
    category: 'Identity',
    title: 'Create Gmail labels for agent workflow',
    instructions: 'Create labels: PR/New, PR/Needs Ken, PR/Safe Reply, PR/Auto-Replied, PR/Approved Target, PR/Rejected Target, PR/Do Not Contact. The agent should never delete messages; it should label and archive only after rules are tested.',
    reference_url: 'https://support.google.com/mail/answer/118708',
  },
  {
    key: 'spotify_for_artists',
    category: 'Streaming profiles',
    title: 'Claim Spotify for Artists profile',
    instructions: 'Use Spotify for Artists to claim the Pancake Robot artist profile after at least one release is live. Record the profile URL and the login account used.',
    reference_url: 'https://artists.spotify.com/get-access',
  },
  {
    key: 'spotify_pitching',
    category: 'Streaming profiles',
    title: 'Prepare Spotify editorial pitching process',
    instructions: 'Spotify editorial pitching must be done inside Spotify for Artists before release. Record the intended pitch owner, default positioning, and release lead time target.',
    reference_url: 'https://support.spotify.com/us/artists/article/pitching-music-to-playlist-editors/',
  },
  {
    key: 'tiktok_artist_account',
    category: 'Short-form video',
    title: 'Set up TikTok Artist Account through DistroKid path',
    instructions: 'Connect Pancake Robot to TikTok as an artist so released songs can be used as sounds and appear on the Music Tab. Record the TikTok handle and artist profile URL.',
    reference_url: 'https://support.distrokid.com/hc/en-us/articles/35148606237587-How-Do-I-Get-an-Official-TikTok-Artist-Account',
  },
  {
    key: 'youtube_channel',
    category: 'Short-form video',
    title: 'Create or confirm YouTube channel for Shorts',
    instructions: 'Create a Pancake Robot channel for Shorts and music videos. Record the channel URL. Use this for hook clips, visualizers, and album content.',
    reference_url: 'https://support.google.com/youtube/answer/1646861',
  },
  {
    key: 'instagram_account',
    category: 'Short-form video',
    title: 'Create or confirm Instagram account',
    instructions: 'Create a Pancake Robot Instagram account for Reels and creator discovery. Record handle and profile URL.',
    reference_url: 'https://help.instagram.com/182492381886913',
  },
  {
    key: 'hyperfollow_links',
    category: 'Smart links',
    title: 'Create DistroKid HyperFollow links',
    instructions: 'Create or capture HyperFollow links for released and upcoming songs. These links should be used in curator pitches, creator outreach, bios, and posts.',
    reference_url: 'https://support.distrokid.com/hc/en-us/articles/360013647913-What-Is-HyperFollow',
  },
  {
    key: 'target_research_source',
    category: 'Agent infrastructure',
    title: 'Configure real target research source',
    instructions: 'Set MARKETING_RESEARCH_SOURCE_PATH to a JSON file produced by OpenClaw, Firecrawl, or manual research. The importer refuses unsourced targets. Required target fields: name, type, source_url.',
    reference_url: '',
  },
  {
    key: 'openclaw_gmail_dry_run',
    category: 'Agent infrastructure',
    title: 'Run Gmail/OpenClaw in dry-run first',
    instructions: 'Before full-auto replies, run inbox classification and draft generation without sending. Auto-send should stay disabled until safe reply categories, escalation categories, unsubscribe/suppression handling, and daily send limits are tested.',
    reference_url: '',
  },
  {
    key: 'compliance_guardrails',
    category: 'Compliance',
    title: 'Confirm anti-spam and AI disclosure rules',
    instructions: 'Do not contact AI-hostile targets. Do not use guaranteed-stream or paid-placement vendors. Outbound messages must be targeted, truthful, include the Pancake Robot identity, and respect do-not-contact responses.',
    reference_url: 'https://artists.spotify.com/artificial-streaming',
  },
];

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

  seedMarketingSetupItems();
}

function seedMarketingSetupItems() {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO marketing_setup_items
      (key, category, title, instructions, reference_url, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'not_started', ?)
  `);

  for (const item of SETUP_ITEMS) {
    stmt.run(item.key, item.category, item.title, item.instructions, item.reference_url || null, now);
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

  const runs = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN status LIKE 'blocked%' THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
    FROM marketing_agent_runs
  `).get();

  return { setup, targets, runs };
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
