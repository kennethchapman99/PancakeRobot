import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { getActiveProfileId } from './brand-profile.js';
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
      brand_profile_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      platform TEXT,
      source_url TEXT NOT NULL,
      submission_url TEXT,
      contact_method TEXT,
      contact_email TEXT,
      handle TEXT,
      official_website_url TEXT,
      contact_page_url TEXT,
      public_email TEXT,
      submission_form_url TEXT,
      instagram_url TEXT,
      tiktok_url TEXT,
      youtube_url TEXT,
      facebook_url TEXT,
      twitter_url TEXT,
      threads_url TEXT,
      playlist_link_url TEXT,
      best_free_contact_method TEXT,
      backup_contact_method TEXT,
      contactability_json TEXT,
      cost_policy_json TEXT,
      ai_policy_details_json TEXT,
      outreach_eligibility_json TEXT,
      audience TEXT,
      geo TEXT,
      genres_json TEXT,
      content_types_json TEXT,
      fit_score INTEGER,
      ai_policy TEXT DEFAULT 'unclear',
      ai_risk_score INTEGER,
      recommendation TEXT DEFAULT 'manual_review',
      research_summary TEXT,
      outreach_angle TEXT,
      pitch_preferences TEXT,
      last_verified_at TEXT,
      freshness_status TEXT DEFAULT 'unknown',
      status TEXT DEFAULT 'needs_review',
      approved_at TEXT,
      rejected_reason TEXT,
      suppression_status TEXT DEFAULT 'none',
      notes TEXT,
      raw_json TEXT,
      UNIQUE(name, source_url)
    );

    CREATE TABLE IF NOT EXISTS marketing_target_sources (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      brand_profile_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_name TEXT,
      source_url TEXT,
      source_path TEXT,
      status TEXT DEFAULT 'active',
      last_checked_at TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS marketing_target_release_matches (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      brand_profile_id TEXT NOT NULL,
      song_id TEXT,
      album_id TEXT,
      target_id TEXT NOT NULL,
      match_score INTEGER,
      match_reasons_json TEXT,
      recommended_action TEXT,
      status TEXT DEFAULT 'planned',
      requires_human INTEGER DEFAULT 1,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS marketing_suppression_rules (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      brand_profile_id TEXT,
      target_id TEXT,
      email TEXT,
      domain TEXT,
      handle TEXT,
      reason TEXT NOT NULL,
      source TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      release_marketing_id TEXT,
      focus_song_id TEXT,
      objective TEXT,
      audience TEXT,
      channel_mix_json TEXT,
      approved_target_ids_json TEXT,
      excluded_target_ids_json TEXT,
      exclusion_summary TEXT,
      dry_run INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS marketing_campaign_items (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      draft_subject TEXT,
      draft_body TEXT,
      gmail_draft_id TEXT,
      gmail_draft_url TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS release_marketing (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist_name TEXT,
      brand_profile_id TEXT,
      release_type TEXT DEFAULT 'single',
      release_status TEXT DEFAULT 'draft',
      release_date TEXT,
      readiness_json TEXT,
      distribution_json TEXT,
      asset_pack_json TEXT,
      results_json TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  migrateMarketingTargetsColumns(db);
  migrateMarketingCampaignColumns(db);
  syncMarketingSetupItemsFromConfig();
}

function migrateMarketingTargetsColumns(db) {
  const newCols = [
    ['brand_profile_id', 'TEXT'],
    ['contact_email', 'TEXT'],
    ['handle', 'TEXT'],
    ['official_website_url', 'TEXT'],
    ['contact_page_url', 'TEXT'],
    ['public_email', 'TEXT'],
    ['submission_form_url', 'TEXT'],
    ['instagram_url', 'TEXT'],
    ['tiktok_url', 'TEXT'],
    ['youtube_url', 'TEXT'],
    ['facebook_url', 'TEXT'],
    ['twitter_url', 'TEXT'],
    ['threads_url', 'TEXT'],
    ['playlist_link_url', 'TEXT'],
    ['best_free_contact_method', 'TEXT'],
    ['backup_contact_method', 'TEXT'],
    ['contactability_json', 'TEXT'],
    ['cost_policy_json', 'TEXT'],
    ['ai_policy_details_json', 'TEXT'],
    ['outreach_eligibility_json', 'TEXT'],
    ['geo', 'TEXT'],
    ['genres_json', 'TEXT'],
    ['content_types_json', 'TEXT'],
    ['outreach_angle', 'TEXT'],
    ['pitch_preferences', 'TEXT'],
    ['last_verified_at', 'TEXT'],
    ['freshness_status', "TEXT DEFAULT 'unknown'"],
    ['rejected_reason', 'TEXT'],
    ['suppression_status', "TEXT DEFAULT 'none'"],
    ['last_contact_at', 'TEXT'],
    ['last_contact_release_marketing_id', 'TEXT'],
    ['last_contact_release_title', 'TEXT'],
    ['last_contact_subject', 'TEXT'],
    ['last_contact_body_preview', 'TEXT'],
    ['last_outcome', 'TEXT'],
    ['suppression_reason', 'TEXT'],
    ['suppression_source', 'TEXT'],
  ];
  for (const [col, type] of newCols) {
    try { db.exec(`ALTER TABLE marketing_targets ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
  }
}

function migrateMarketingCampaignColumns(db) {
  const newCols = [
    ['release_marketing_id', 'TEXT'],
    ['excluded_target_ids_json', 'TEXT'],
    ['exclusion_summary', 'TEXT'],
    ['dry_run', 'INTEGER DEFAULT 0'],
  ];
  for (const [col, type] of newCols) {
    try { db.exec(`ALTER TABLE marketing_campaigns ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
  }
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
  const brandProfileId = filters.brand_profile_id === undefined ? getActiveProfileId() : filters.brand_profile_id;

  if (brandProfileId !== null && brandProfileId !== '') {
    clauses.push('brand_profile_id = ?');
    params.push(brandProfileId);
  }

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
  return getDb().prepare(`SELECT * FROM marketing_targets WHERE status = 'approved' AND brand_profile_id = ? ORDER BY updated_at DESC`).all(getActiveProfileId());
}

export function getMarketingTargetById(id, { brand_profile_id = getActiveProfileId() } = {}) {
  initMarketingSchema();
  if (brand_profile_id === null) {
    return getDb().prepare('SELECT * FROM marketing_targets WHERE id = ?').get(id);
  }
  return getDb().prepare('SELECT * FROM marketing_targets WHERE id = ? AND brand_profile_id = ?').get(id, brand_profile_id);
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
    brand_profile_id: optionalText(target.brand_profile_id) || existing?.brand_profile_id || null,
    name: target.name.trim(),
    type: target.type.trim(),
    platform: optionalText(target.platform),
    source_url: target.source_url.trim(),
    submission_url: optionalText(target.submission_url),
    contact_method: optionalText(target.contact_method),
    contact_email: optionalText(target.contact_email),
    handle: optionalText(target.handle),
    official_website_url: optionalText(target.official_website_url),
    contact_page_url: optionalText(target.contact_page_url),
    public_email: optionalText(target.public_email),
    submission_form_url: optionalText(target.submission_form_url),
    instagram_url: optionalText(target.instagram_url),
    tiktok_url: optionalText(target.tiktok_url),
    youtube_url: optionalText(target.youtube_url),
    facebook_url: optionalText(target.facebook_url),
    twitter_url: optionalText(target.twitter_url),
    threads_url: optionalText(target.threads_url),
    playlist_link_url: optionalText(target.playlist_link_url),
    best_free_contact_method: optionalText(target.best_free_contact_method),
    backup_contact_method: optionalText(target.backup_contact_method),
    contactability_json: target.contactability ? JSON.stringify(target.contactability) : optionalText(target.contactability_json),
    cost_policy_json: target.cost_policy ? JSON.stringify(target.cost_policy) : optionalText(target.cost_policy_json),
    ai_policy_details_json: target.ai_policy_details ? JSON.stringify(target.ai_policy_details) : optionalText(target.ai_policy_details_json),
    outreach_eligibility_json: target.outreach_eligibility ? JSON.stringify(target.outreach_eligibility) : optionalText(target.outreach_eligibility_json),
    audience: optionalText(target.audience),
    geo: optionalText(target.geo),
    genres_json: target.genres ? JSON.stringify(target.genres) : optionalText(target.genres_json),
    content_types_json: target.content_types ? JSON.stringify(target.content_types) : optionalText(target.content_types_json),
    fit_score: toNullableInt(target.fit_score),
    ai_policy: optionalText(target.ai_policy) || 'unclear',
    ai_risk_score: toNullableInt(target.ai_risk_score),
    recommendation: optionalText(target.recommendation) || 'manual_review',
    research_summary: optionalText(target.research_summary),
    outreach_angle: optionalText(target.outreach_angle),
    pitch_preferences: optionalText(target.pitch_preferences),
    last_verified_at: optionalText(target.last_verified_at),
    freshness_status: optionalText(target.freshness_status) || 'unknown',
    status: optionalText(target.status) || existing?.status || 'needs_review',
    approved_at: target.status === 'approved' ? now : existing?.approved_at || null,
    rejected_reason: optionalText(target.rejected_reason),
    suppression_status: optionalText(target.suppression_status) || 'none',
    last_contact_at: optionalText(target.last_contact_at),
    last_contact_release_marketing_id: optionalText(target.last_contact_release_marketing_id),
    last_contact_release_title: optionalText(target.last_contact_release_title),
    last_contact_subject: optionalText(target.last_contact_subject),
    last_contact_body_preview: optionalText(target.last_contact_body_preview),
    last_outcome: optionalText(target.last_outcome),
    suppression_reason: optionalText(target.suppression_reason),
    suppression_source: optionalText(target.suppression_source),
    notes: optionalText(target.notes),
    raw_json: JSON.stringify(target.raw_json || target),
  };

  getDb().prepare(`
    INSERT INTO marketing_targets
      (id, created_at, updated_at, brand_profile_id, name, type, platform, source_url, submission_url,
       contact_method, contact_email, handle, official_website_url, contact_page_url, public_email, submission_form_url,
       instagram_url, tiktok_url, youtube_url, facebook_url, twitter_url, threads_url, playlist_link_url,
       best_free_contact_method, backup_contact_method, contactability_json, cost_policy_json,
       ai_policy_details_json, outreach_eligibility_json, audience, geo, genres_json, content_types_json,
       fit_score, ai_policy, ai_risk_score, recommendation, research_summary, outreach_angle,
       pitch_preferences, last_verified_at, freshness_status, status, approved_at, rejected_reason,
       suppression_status, last_contact_at, last_contact_release_marketing_id, last_contact_release_title,
       last_contact_subject, last_contact_body_preview, last_outcome, suppression_reason, suppression_source,
       notes, raw_json)
    VALUES
      (@id, @created_at, @updated_at, @brand_profile_id, @name, @type, @platform, @source_url, @submission_url,
       @contact_method, @contact_email, @handle, @official_website_url, @contact_page_url, @public_email, @submission_form_url,
       @instagram_url, @tiktok_url, @youtube_url, @facebook_url, @twitter_url, @threads_url, @playlist_link_url,
       @best_free_contact_method, @backup_contact_method, @contactability_json, @cost_policy_json,
       @ai_policy_details_json, @outreach_eligibility_json, @audience, @geo, @genres_json, @content_types_json,
       @fit_score, @ai_policy, @ai_risk_score, @recommendation, @research_summary, @outreach_angle,
       @pitch_preferences, @last_verified_at, @freshness_status, @status, @approved_at, @rejected_reason,
       @suppression_status, @last_contact_at, @last_contact_release_marketing_id, @last_contact_release_title,
       @last_contact_subject, @last_contact_body_preview, @last_outcome, @suppression_reason, @suppression_source,
       @notes, @raw_json)
    ON CONFLICT(name, source_url) DO UPDATE SET
      updated_at = excluded.updated_at,
      brand_profile_id = COALESCE(excluded.brand_profile_id, brand_profile_id),
      type = excluded.type,
      platform = excluded.platform,
      submission_url = excluded.submission_url,
      contact_method = excluded.contact_method,
      contact_email = excluded.contact_email,
      handle = excluded.handle,
      official_website_url = excluded.official_website_url,
      contact_page_url = excluded.contact_page_url,
      public_email = excluded.public_email,
      submission_form_url = excluded.submission_form_url,
      instagram_url = excluded.instagram_url,
      tiktok_url = excluded.tiktok_url,
      youtube_url = excluded.youtube_url,
      facebook_url = excluded.facebook_url,
      twitter_url = excluded.twitter_url,
      threads_url = excluded.threads_url,
      playlist_link_url = excluded.playlist_link_url,
      best_free_contact_method = excluded.best_free_contact_method,
      backup_contact_method = excluded.backup_contact_method,
      contactability_json = excluded.contactability_json,
      cost_policy_json = excluded.cost_policy_json,
      ai_policy_details_json = excluded.ai_policy_details_json,
      outreach_eligibility_json = excluded.outreach_eligibility_json,
      audience = excluded.audience,
      geo = excluded.geo,
      genres_json = excluded.genres_json,
      content_types_json = excluded.content_types_json,
      fit_score = excluded.fit_score,
      ai_policy = excluded.ai_policy,
      ai_risk_score = excluded.ai_risk_score,
      recommendation = excluded.recommendation,
      research_summary = excluded.research_summary,
      outreach_angle = excluded.outreach_angle,
      pitch_preferences = excluded.pitch_preferences,
      last_verified_at = excluded.last_verified_at,
      freshness_status = excluded.freshness_status,
      rejected_reason = excluded.rejected_reason,
      suppression_status = excluded.suppression_status,
      last_contact_at = COALESCE(excluded.last_contact_at, marketing_targets.last_contact_at),
      last_contact_release_marketing_id = COALESCE(excluded.last_contact_release_marketing_id, marketing_targets.last_contact_release_marketing_id),
      last_contact_release_title = COALESCE(excluded.last_contact_release_title, marketing_targets.last_contact_release_title),
      last_contact_subject = COALESCE(excluded.last_contact_subject, marketing_targets.last_contact_subject),
      last_contact_body_preview = COALESCE(excluded.last_contact_body_preview, marketing_targets.last_contact_body_preview),
      last_outcome = COALESCE(excluded.last_outcome, marketing_targets.last_outcome),
      suppression_reason = COALESCE(excluded.suppression_reason, marketing_targets.suppression_reason),
      suppression_source = COALESCE(excluded.suppression_source, marketing_targets.suppression_source),
      notes = excluded.notes,
      raw_json = excluded.raw_json
  `).run(payload);

  return id;
}

export function updateMarketingTarget(id, fields = {}) {
  initMarketingSchema();
  const allowed = [
    'status', 'notes', 'recommendation', 'ai_policy', 'ai_risk_score', 'fit_score',
    'suppression_status', 'suppression_reason', 'suppression_source',
    'last_contact_at', 'last_contact_release_marketing_id', 'last_contact_release_title',
    'last_contact_subject', 'last_contact_body_preview', 'last_outcome',
  ];
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
      (id, created_at, updated_at, name, status, release_marketing_id, focus_song_id, objective, audience, channel_mix_json, approved_target_ids_json, excluded_target_ids_json, exclusion_summary, dry_run, brand_context_json, notes)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    now,
    now,
    campaign.name,
    campaign.status || 'draft',
    campaign.release_marketing_id || null,
    campaign.focus_song_id || null,
    campaign.objective || null,
    campaign.audience || null,
    JSON.stringify(campaign.channel_mix || []),
    JSON.stringify(campaign.approved_target_ids || []),
    JSON.stringify(campaign.excluded_target_ids || []),
    campaign.exclusion_summary || null,
    campaign.dry_run ? 1 : 0,
    JSON.stringify(campaign.brand_context || {}),
    campaign.notes || null,
  );
  return id;
}

export function getMarketingCampaigns(limit = 25) {
  initMarketingSchema();
  return getDb().prepare('SELECT * FROM marketing_campaigns ORDER BY created_at DESC LIMIT ?').all(limit).map(parseCampaign);
}

export function getMarketingCampaignById(id) {
  initMarketingSchema();
  return parseCampaign(getDb().prepare('SELECT * FROM marketing_campaigns WHERE id = ?').get(id));
}

export function updateMarketingCampaign(id, fields = {}) {
  initMarketingSchema();
  const updates = { updated_at: new Date().toISOString() };
  const mapping = {
    name: value => value,
    status: value => value,
    release_marketing_id: value => value,
    focus_song_id: value => value,
    objective: value => value,
    audience: value => value,
    channel_mix: value => JSON.stringify(value || []),
    approved_target_ids: value => JSON.stringify(value || []),
    excluded_target_ids: value => JSON.stringify(value || []),
    exclusion_summary: value => value,
    dry_run: value => value ? 1 : 0,
    brand_context: value => JSON.stringify(value || {}),
    notes: value => value,
  };
  for (const [key, serializer] of Object.entries(mapping)) {
    if (fields[key] !== undefined) {
      const column = key === 'channel_mix' ? 'channel_mix_json'
        : key === 'approved_target_ids' ? 'approved_target_ids_json'
        : key === 'excluded_target_ids' ? 'excluded_target_ids_json'
        : key === 'brand_context' ? 'brand_context_json'
        : key;
      updates[column] = serializer(fields[key]);
    }
  }
  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE marketing_campaigns SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
  return getMarketingCampaignById(id);
}

function parseCampaign(row) {
  if (!row) return null;
  return {
    ...row,
    dry_run: Boolean(row.dry_run),
    channel_mix: parseJsonArray(row.channel_mix_json),
    approved_target_ids: parseJsonArray(row.approved_target_ids_json),
    excluded_target_ids: parseJsonArray(row.excluded_target_ids_json),
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

export function getApprovedTargetsForBrand(brandProfileId) {
  initMarketingSchema();
  return getDb().prepare(
    `SELECT * FROM marketing_targets WHERE status = 'approved' AND brand_profile_id = ? ORDER BY fit_score DESC, updated_at DESC`
  ).all(brandProfileId);
}

export function getTargetsByBrand(brandProfileId, filters = {}) {
  initMarketingSchema();
  const clauses = ['brand_profile_id = ?'];
  const params = [brandProfileId];
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (filters.type) { clauses.push('type = ?'); params.push(filters.type); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM marketing_targets ${where} ORDER BY fit_score DESC, updated_at DESC`).all(...params);
}

export function upsertTargetSource(source) {
  initMarketingSchema();
  const now = new Date().toISOString();
  const id = source.id || `MKT_SRC_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO marketing_target_sources (id, created_at, updated_at, brand_profile_id, source_type, source_name, source_url, source_path, status, last_checked_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status, last_checked_at=excluded.last_checked_at, notes=excluded.notes
  `).run(id, now, now, source.brand_profile_id, source.source_type, source.source_name||null, source.source_url||null, source.source_path||null, source.status||'active', source.last_checked_at||null, source.notes||null);
  return id;
}

export function upsertReleaseMatch(match) {
  initMarketingSchema();
  const now = new Date().toISOString();
  const id = match.id || `MKT_MATCH_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO marketing_target_release_matches
      (id, created_at, updated_at, brand_profile_id, song_id, album_id, target_id, match_score, match_reasons_json, recommended_action, status, requires_human, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, match_score=excluded.match_score, match_reasons_json=excluded.match_reasons_json, recommended_action=excluded.recommended_action, status=excluded.status
  `).run(
    id, now, now,
    match.brand_profile_id, match.song_id||null, match.album_id||null,
    match.target_id, match.match_score||null,
    JSON.stringify(match.match_reasons||[]),
    match.recommended_action||null,
    match.status||'planned',
    match.requires_human !== undefined ? (match.requires_human ? 1 : 0) : 1,
    JSON.stringify(match),
  );
  return id;
}

export function getReleaseMatches(songId, brandProfileId) {
  initMarketingSchema();
  const clauses = [];
  const params = [];
  if (songId) { clauses.push('song_id = ?'); params.push(songId); }
  if (brandProfileId) { clauses.push('brand_profile_id = ?'); params.push(brandProfileId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM marketing_target_release_matches ${where} ORDER BY match_score DESC, created_at DESC`).all(...params);
}

export function addSuppressionRule(rule) {
  initMarketingSchema();
  const now = new Date().toISOString();
  const id = `MKT_SUP_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  getDb().prepare(`
    INSERT INTO marketing_suppression_rules (id, created_at, updated_at, brand_profile_id, target_id, email, domain, handle, reason, source, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, now, now, rule.brand_profile_id||null, rule.target_id||null, rule.email||null, rule.domain||null, rule.handle||null, rule.reason, rule.source||null);
  return id;
}

export function getSuppressionRules(brandProfileId) {
  initMarketingSchema();
  return getDb().prepare(
    `SELECT * FROM marketing_suppression_rules WHERE active = 1 AND (brand_profile_id IS NULL OR brand_profile_id = ?) ORDER BY created_at DESC`
  ).all(brandProfileId||null);
}

export function getMarketingTargetStats(brandProfileId) {
  initMarketingSchema();
  const db = getDb();
  const clause = brandProfileId ? 'WHERE brand_profile_id = ?' : '';
  const params = brandProfileId ? [brandProfileId] : [];
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN status='needs_review' THEN 1 ELSE 0 END) as needs_review,
      SUM(CASE WHEN status='stale' THEN 1 ELSE 0 END) as stale,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN status='do_not_contact' THEN 1 ELSE 0 END) as do_not_contact,
      SUM(CASE WHEN ai_policy='allowed' THEN 1 ELSE 0 END) as ai_allowed,
      SUM(CASE WHEN ai_policy='disclosure_required' THEN 1 ELSE 0 END) as ai_disclosure,
      SUM(CASE WHEN ai_policy='likely_hostile' OR ai_policy='banned' THEN 1 ELSE 0 END) as ai_hostile
    FROM marketing_targets ${clause}
  `).get(...params);
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

// ── Campaign detail ────────────────────────────────────────────

export function getCampaignById(id) {
  initMarketingSchema();
  const row = getDb().prepare('SELECT * FROM marketing_campaigns WHERE id = ?').get(id);
  return parseCampaign(row);
}

// ── Campaign items ─────────────────────────────────────────────

export function getCampaignItems(campaignId) {
  initMarketingSchema();
  return getDb().prepare(`
    SELECT i.*, t.name as target_name, t.type as target_type, t.platform as target_platform,
           t.fit_score, t.ai_policy, t.contact_email, t.handle, t.submission_url,
           t.outreach_angle, t.research_summary, t.status as target_status
    FROM marketing_campaign_items i
    LEFT JOIN marketing_targets t ON t.id = i.target_id
    WHERE i.campaign_id = ?
    ORDER BY i.created_at ASC
  `).all(campaignId);
}

export function getCampaignItemById(itemId) {
  initMarketingSchema();
  return getDb().prepare(`
    SELECT i.*, t.name as target_name, t.type as target_type, t.platform as target_platform,
           t.fit_score, t.ai_policy, t.contact_email, t.handle, t.submission_url,
           t.outreach_angle, t.research_summary, t.status as target_status, t.raw_json as target_raw_json
    FROM marketing_campaign_items i
    LEFT JOIN marketing_targets t ON t.id = i.target_id
    WHERE i.id = ?
  `).get(itemId);
}

export function ensureCampaignItems(campaignId, targetIds) {
  initMarketingSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO marketing_campaign_items (id, campaign_id, target_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', ?, ?)
  `);
  for (const targetId of targetIds) {
    const id = `MKT_ITEM_${createHash('sha1').update(`${campaignId}|${targetId}`).digest('hex').slice(0, 12).toUpperCase()}`;
    insert.run(id, campaignId, targetId, now, now);
  }
}

export function updateCampaignItem(itemId, fields = {}) {
  initMarketingSchema();
  const allowed = ['status', 'draft_subject', 'draft_body', 'gmail_draft_id', 'gmail_draft_url', 'notes'];
  const updates = { updated_at: new Date().toISOString() };
  for (const field of allowed) {
    if (fields[field] !== undefined) updates[field] = fields[field] ?? null;
  }
  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE marketing_campaign_items SET ${setClause} WHERE id = ?`).run(...Object.values(updates), itemId);
}
