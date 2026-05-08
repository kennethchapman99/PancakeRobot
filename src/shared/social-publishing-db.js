import { getDb } from './db.js';

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  return JSON.stringify(value);
}

function parseCampaign(row) {
  if (!row) return null;
  return {
    ...row,
    requires_approval: Boolean(row.requires_approval),
  };
}

function parseSocialPost(row) {
  if (!row) return null;
  return {
    ...row,
    hashtags: parseJson(row.hashtags_json, []),
    validation_warnings: parseJson(row.validation_warnings_json, []),
    ai_generated: Boolean(row.ai_generated),
    made_for_kids: row.made_for_kids === null || row.made_for_kids === undefined ? null : Boolean(row.made_for_kids),
    contains_synthetic_media: Boolean(row.contains_synthetic_media),
  };
}

export function createDailySocialCampaign(input = {}) {
  const db = getDb();
  const now = nowIso();
  const id = input.id || makeId('SOC_CAMPAIGN');
  db.prepare(`
    INSERT INTO daily_social_campaigns
      (id, date, timezone, brand, status, selected_song_id, selected_release_id, campaign_type,
       rationale, created_by, requires_approval, approved_at, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.date,
    input.timezone,
    input.brand || null,
    input.status || 'draft',
    input.selected_song_id,
    input.selected_release_id || null,
    input.campaign_type,
    input.rationale || null,
    input.created_by || 'agent',
    input.requires_approval === undefined ? 1 : (input.requires_approval ? 1 : 0),
    input.approved_at || null,
    input.created_at || now,
    input.updated_at || now,
  );
  return getDailySocialCampaignById(id);
}

export function getDailySocialCampaignById(id) {
  return parseCampaign(getDb().prepare('SELECT * FROM daily_social_campaigns WHERE id = ?').get(id));
}

export function getDailySocialCampaignForDate(date) {
  return parseCampaign(getDb().prepare(`
    SELECT *
    FROM daily_social_campaigns
    WHERE date = ?
    ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC
    LIMIT 1
  `).get(date));
}

export function getDailySocialCampaigns({ limit = 30 } = {}) {
  return getDb().prepare(`
    SELECT *
    FROM daily_social_campaigns
    ORDER BY date DESC, COALESCE(updated_at, created_at) DESC
    LIMIT ?
  `).all(limit).map(parseCampaign);
}

export function updateDailySocialCampaign(id, patch = {}) {
  const existing = getDailySocialCampaignById(id);
  if (!existing) return null;

  const updates = { updated_at: nowIso() };
  const allowed = [
    'date',
    'timezone',
    'brand',
    'status',
    'selected_song_id',
    'selected_release_id',
    'campaign_type',
    'rationale',
    'created_by',
    'approved_at',
  ];
  for (const key of allowed) {
    if (patch[key] !== undefined) updates[key] = patch[key];
  }
  if (patch.requires_approval !== undefined) updates.requires_approval = patch.requires_approval ? 1 : 0;

  const clauses = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  getDb().prepare(`UPDATE daily_social_campaigns SET ${clauses} WHERE id = ?`).run(...Object.values(updates), id);
  return getDailySocialCampaignById(id);
}

export function upsertSocialPost(input = {}) {
  const db = getDb();
  const now = nowIso();
  const existing = input.id
    ? db.prepare('SELECT * FROM social_posts WHERE id = ?').get(input.id)
    : db.prepare('SELECT * FROM social_posts WHERE idempotency_key = ?').get(input.idempotency_key);

  if (existing) {
    const updates = { updated_at: now };
    const allowed = [
      'campaign_id',
      'release_id',
      'song_id',
      'platform',
      'status',
      'asset_type',
      'asset_url',
      'public_asset_url',
      'title',
      'caption',
      'description',
      'scheduled_at',
      'published_at',
      'platform_post_id',
      'platform_post_url',
      'error_code',
      'error_message',
      'idempotency_key',
    ];
    for (const key of allowed) {
      if (input[key] !== undefined) updates[key] = input[key];
    }
    if (input.hashtags !== undefined) updates.hashtags_json = stringifyJson(input.hashtags, '[]');
    if (input.validation_warnings !== undefined) updates.validation_warnings_json = stringifyJson(input.validation_warnings, '[]');
    if (input.ai_generated !== undefined) updates.ai_generated = input.ai_generated ? 1 : 0;
    if (input.made_for_kids !== undefined) updates.made_for_kids = input.made_for_kids === null ? null : (input.made_for_kids ? 1 : 0);
    if (input.contains_synthetic_media !== undefined) updates.contains_synthetic_media = input.contains_synthetic_media ? 1 : 0;

    const clauses = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    db.prepare(`UPDATE social_posts SET ${clauses} WHERE id = ?`).run(...Object.values(updates), existing.id);
    return getSocialPostById(existing.id);
  }

  const id = input.id || makeId('SOC_POST');
  db.prepare(`
    INSERT INTO social_posts
      (id, campaign_id, release_id, song_id, platform, status, asset_type, asset_url, public_asset_url,
       title, caption, description, hashtags_json, scheduled_at, published_at, platform_post_id,
       platform_post_url, ai_generated, made_for_kids, contains_synthetic_media, validation_warnings_json,
       error_code, error_message, idempotency_key, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.campaign_id,
    input.release_id || null,
    input.song_id,
    input.platform,
    input.status || 'draft',
    input.asset_type,
    input.asset_url || null,
    input.public_asset_url || null,
    input.title || null,
    input.caption || null,
    input.description || null,
    stringifyJson(input.hashtags || [], '[]'),
    input.scheduled_at || null,
    input.published_at || null,
    input.platform_post_id || null,
    input.platform_post_url || null,
    input.ai_generated === undefined ? 1 : (input.ai_generated ? 1 : 0),
    input.made_for_kids === undefined || input.made_for_kids === null ? null : (input.made_for_kids ? 1 : 0),
    input.contains_synthetic_media === undefined ? 1 : (input.contains_synthetic_media ? 1 : 0),
    stringifyJson(input.validation_warnings || [], '[]'),
    input.error_code || null,
    input.error_message || null,
    input.idempotency_key,
    input.created_at || now,
    input.updated_at || now,
  );
  return getSocialPostById(id);
}

export function getSocialPostById(id) {
  return parseSocialPost(getDb().prepare('SELECT * FROM social_posts WHERE id = ?').get(id));
}

export function getSocialPostsByCampaignId(campaignId) {
  return getDb().prepare(`
    SELECT *
    FROM social_posts
    WHERE campaign_id = ?
    ORDER BY scheduled_at ASC, created_at ASC
  `).all(campaignId).map(parseSocialPost);
}

export function getSocialPostsBySongId(songId) {
  return getDb().prepare(`
    SELECT *
    FROM social_posts
    WHERE song_id = ?
    ORDER BY COALESCE(published_at, scheduled_at, created_at) DESC
  `).all(songId).map(parseSocialPost);
}

export function updateSocialPost(id, patch = {}) {
  const existing = getSocialPostById(id);
  if (!existing) return null;
  return upsertSocialPost({ ...existing, ...patch, id });
}

export function getDueSocialPosts(nowIso) {
  return getDb().prepare(`
    SELECT *
    FROM social_posts
    WHERE COALESCE(status, 'draft') IN ('draft', 'approved', 'ready', 'failed')
      AND scheduled_at IS NOT NULL
      AND scheduled_at <= ?
      AND published_at IS NULL
    ORDER BY scheduled_at ASC, created_at ASC
  `).all(nowIso).map(parseSocialPost);
}

export function getSocialPublishingSummary() {
  const db = getDb();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_posts,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published_posts,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_posts,
      SUM(CASE WHEN status = 'needs_auth' THEN 1 ELSE 0 END) AS needs_auth_posts,
      SUM(CASE WHEN status = 'blocked_by_policy' THEN 1 ELSE 0 END) AS blocked_posts,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_posts
    FROM social_posts
  `).get();
  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) AS total, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published
    FROM social_posts
    GROUP BY platform
    ORDER BY platform
  `).all();
  const byCampaignStatus = db.prepare(`
    SELECT status, COUNT(*) AS total
    FROM daily_social_campaigns
    GROUP BY status
    ORDER BY status
  `).all();

  return { totals, byPlatform, byCampaignStatus };
}

export function getLatestPublishedSocialUrlsBySongId(songId) {
  const posts = getDb().prepare(`
    SELECT platform, platform_post_url, published_at
    FROM social_posts
    WHERE song_id = ?
      AND platform_post_url IS NOT NULL
      AND platform_post_url != ''
    ORDER BY published_at DESC, created_at DESC
  `).all(songId);

  const latest = {
    latestInstagramUrl: '',
    latestFacebookUrl: '',
    latestYouTubeUrl: '',
  };
  for (const post of posts) {
    const platform = String(post.platform || '').toLowerCase();
    if (platform === 'instagram' && !latest.latestInstagramUrl) latest.latestInstagramUrl = post.platform_post_url;
    if (platform === 'facebook' && !latest.latestFacebookUrl) latest.latestFacebookUrl = post.platform_post_url;
    if (platform === 'youtube' && !latest.latestYouTubeUrl) latest.latestYouTubeUrl = post.platform_post_url;
  }
  return latest;
}
