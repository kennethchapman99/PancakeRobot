import { getDb, getAllSongs, getReleaseLinks, getSong } from './db.js';
import { getSongCatalogMarketingSummary } from './song-catalog-marketing.js';
import { loadBrandProfile, getActiveProfileId } from './brand-profile.js';
import { initMarketingSchema, getMarketingCampaigns } from './marketing-db.js';
import { getOutreachEvents, getOutreachItems } from './marketing-outreach-db.js';
import { getInboxMessages } from './marketing-inbox-db.js';
import { SONG_STATUSES, isOutreachCompleteSongStatus, isSubmittedSongStatus, normalizeSongStatus } from './song-status.js';

const BRAND_PROFILE = loadBrandProfile();
const RELEASE_STATUSES = new Set([SONG_STATUSES.SUBMITTED_TO_DISTROKID, SONG_STATUSES.OUTREACH_COMPLETE]);
const DEFAULT_READINESS = {
  audioFinal: false,
  artworkFinal: false,
  lyricsFinal: false,
  metadataFinal: false,
  cleanExplicitFlag: null,
  aiDisclosureApproved: false,
  parentSafeQaStatus: null,
  notes: '',
};
const DEFAULT_DISTRIBUTION = {
  distrokidUploaded: false,
  distrokidUploadDate: null,
  upc: '',
  isrc: '',
  hyperfollowUrl: '',
  spotifyUri: '',
  spotifyUrl: '',
  appleMusicUrl: '',
  youtubeMusicUrl: '',
  otherLinks: [],
  manualNotes: '',
};
const DEFAULT_ASSET_PACK = {
  sourceArtworkPath: null,
  sourceArtworkLocked: true,
  generatedAt: null,
  assets: [],
};
const DEFAULT_RESULTS = {
  placements: [],
  replies: 0,
  opportunities: 0,
  bounced: 0,
  suppressed: 0,
  noResponse: 0,
  lessons: '',
};

export function isMarketingReleaseSong(song) {
  if (!song) return false;
  return RELEASE_STATUSES.has(normalizeSongStatus(song.status)) || Boolean(song.distributor_submission_date) || Boolean(song.published_at);
}

export function songHasMarketingImage(songId) {
  if (!songId) return false;
  const summary = getSongCatalogMarketingSummary(songId);
  return Boolean(summary.baseImage || summary.socialImages.length);
}

export function getMarketingReleaseEntries(limit = 50) {
  return getAllSongs()
    .filter(isMarketingReleaseSong)
    .slice(0, limit)
    .map(song => {
      const links = getReleaseLinks(song.id);
      const marketingSummary = getSongCatalogMarketingSummary(song.id, { releaseLinks: links });
      const releaseMarketing = getReleaseMarketingBySongId(song.id);
      return {
        song,
        links,
        hasMarketingImage: Boolean(marketingSummary.baseImage || marketingSummary.socialImages.length),
        marketingSummary,
        releaseMarketing,
      };
    });
}

export function getOrCreateReleaseMarketing(songId, overrides = {}) {
  initMarketingSchema();
  const existing = getReleaseMarketingBySongId(songId);
  if (existing) return existing;

  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  const now = new Date().toISOString();
  const record = {
    id: overrides.id || `REL_MKT_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    song_id: song.id,
    title: overrides.title || song.title || song.topic || song.id,
    artist_name: overrides.artist_name || BRAND_PROFILE.distribution?.default_artist || BRAND_PROFILE.brand_name || 'Pancake Robot',
    brand_profile_id: overrides.brand_profile_id || song.brand_profile_id || getActiveProfileId() || null,
    release_type: normalizeReleaseType(overrides.release_type || 'single'),
    release_status: normalizeReleaseStatus(overrides.release_status || inferReleaseStatus(song)),
    release_date: overrides.release_date || song.release_date || null,
    readiness: {
      ...DEFAULT_READINESS,
      audioFinal: Boolean(song.audio_prompt_path),
      artworkFinal: songHasMarketingImage(song.id),
      metadataFinal: Boolean(song.metadata_path || song.release_date),
      ...normalizeObject(overrides.readiness),
    },
    distribution: {
      ...DEFAULT_DISTRIBUTION,
      ...seedDistributionFromSong(song),
      ...normalizeObject(overrides.distribution),
    },
    asset_pack: {
      ...DEFAULT_ASSET_PACK,
      sourceArtworkPath: overrides.asset_pack?.sourceArtworkPath || resolveSourceArtworkPath(song.id),
      ...normalizeObject(overrides.asset_pack),
    },
    results: {
      ...DEFAULT_RESULTS,
      ...normalizeObject(overrides.results),
    },
    notes: overrides.notes || '',
    created_at: now,
    updated_at: now,
  };

  writeReleaseMarketing(record);
  return getReleaseMarketingById(record.id);
}

export function getReleaseMarketingById(id) {
  initMarketingSchema();
  const row = getDb().prepare('SELECT * FROM release_marketing WHERE id = ?').get(id);
  return parseReleaseMarketing(row);
}

export function getReleaseMarketingBySongId(songId) {
  initMarketingSchema();
  const row = getDb().prepare('SELECT * FROM release_marketing WHERE song_id = ?').get(songId);
  return parseReleaseMarketing(row);
}

export function updateReleaseMarketing(id, patch = {}) {
  initMarketingSchema();
  const existing = getReleaseMarketingById(id);
  if (!existing) throw new Error(`Release marketing record not found: ${id}`);

  const merged = {
    ...existing,
    title: patch.title ?? existing.title,
    artist_name: patch.artist_name ?? existing.artist_name,
    brand_profile_id: patch.brand_profile_id ?? existing.brand_profile_id,
    release_type: patch.release_type ? normalizeReleaseType(patch.release_type) : existing.release_type,
    release_status: patch.release_status ? normalizeReleaseStatus(patch.release_status) : existing.release_status,
    release_date: patch.release_date ?? existing.release_date,
    readiness: mergeNested(existing.readiness, patch.readiness, DEFAULT_READINESS),
    distribution: mergeNested(existing.distribution, patch.distribution, DEFAULT_DISTRIBUTION),
    asset_pack: mergeNested(existing.asset_pack, patch.asset_pack, DEFAULT_ASSET_PACK),
    results: mergeNested(existing.results, patch.results, DEFAULT_RESULTS),
    notes: patch.notes ?? existing.notes,
    updated_at: new Date().toISOString(),
  };

  writeReleaseMarketing(merged);
  return getReleaseMarketingById(id);
}

export function syncReleaseMarketingAssetPack(songId, assetPackPatch = {}) {
  const release = getOrCreateReleaseMarketing(songId);
  const existingPack = release.asset_pack || DEFAULT_ASSET_PACK;
  return updateReleaseMarketing(release.id, {
    asset_pack: {
      ...existingPack,
      sourceArtworkPath: assetPackPatch.sourceArtworkPath ?? existingPack.sourceArtworkPath ?? resolveSourceArtworkPath(songId),
      sourceArtworkLocked: assetPackPatch.sourceArtworkLocked ?? existingPack.sourceArtworkLocked,
      generatedAt: assetPackPatch.generatedAt ?? existingPack.generatedAt,
      assets: Array.isArray(assetPackPatch.assets) ? assetPackPatch.assets : existingPack.assets,
    },
  });
}

export function listReleaseMarketing(limit = 100) {
  initMarketingSchema();
  return getDb()
    .prepare('SELECT * FROM release_marketing ORDER BY updated_at DESC, created_at DESC LIMIT ?')
    .all(limit)
    .map(parseReleaseMarketing);
}

export function getReleaseMarketingDashboard(id) {
  const release = getReleaseMarketingById(id);
  if (!release) return null;

  const song = getSong(release.song_id);
  const marketingSummary = getSongCatalogMarketingSummary(release.song_id, { releaseLinks: getReleaseLinks(release.song_id) });
  const campaigns = getMarketingCampaigns(500).filter(c => c.release_marketing_id === release.id);
  const outreachItems = campaigns.flatMap(c => getOutreachItems({ campaign_id: c.id }));
  const outreachEvents = getOutreachEvents({ release_id: release.id });
  const inboxMessages = getInboxMessages(200).filter(msg => msg.release_marketing_id === release.id);
  const latestCampaign = campaigns[0] || null;
  const selectedTargets = latestCampaign?.approved_target_ids || [];
  const readinessPct = computeReadinessPercent(release.readiness);
  const assetWarnings = (release.asset_pack?.assets || []).filter(asset => asset.sourceArtworkUsed === false);
  const results = {
    replies: outreachItems.filter(item => item.status === 'replied').length,
    opportunities: inboxMessages.filter(msg => msg.classification === 'opportunity').length,
    bounced: outreachItems.filter(item => item.status === 'bounced').length,
    placements: outreachEvents.filter(event => event.status === 'placed').length,
    suppressed: outreachItems.filter(item => ['suppressed', 'do_not_contact'].includes(item.status)).length,
    noResponse: Math.max(outreachItems.filter(item => ['sent', 'gmail_draft_created', 'manual_submitted'].includes(item.status)).length - outreachItems.filter(item => item.status === 'replied').length, 0),
  };

  return {
    release,
    song,
    marketingSummary,
    campaigns,
    latestCampaign,
    outreachItems,
    outreachEvents,
    inboxMessages,
    readinessPct,
    selectedTargetsCount: selectedTargets.length,
    draftsReadyCount: outreachItems.filter(item => ['draft_generated', 'ready_for_gmail_draft', 'gmail_draft_created'].includes(item.status)).length,
    assetCount: (release.asset_pack?.assets || []).length,
    assetWarnings,
    results,
  };
}

export function resolveSourceArtworkPath(songId) {
  const summary = getSongCatalogMarketingSummary(songId);
  return summary.baseImage?.path || summary.socialImages[0]?.path || null;
}

function writeReleaseMarketing(record) {
  getDb().prepare(`
    INSERT INTO release_marketing
      (id, song_id, title, artist_name, brand_profile_id, release_type, release_status, release_date,
       readiness_json, distribution_json, asset_pack_json, results_json, notes, created_at, updated_at)
    VALUES
      (@id, @song_id, @title, @artist_name, @brand_profile_id, @release_type, @release_status, @release_date,
       @readiness_json, @distribution_json, @asset_pack_json, @results_json, @notes, @created_at, @updated_at)
    ON CONFLICT(song_id) DO UPDATE SET
      title = excluded.title,
      artist_name = excluded.artist_name,
      brand_profile_id = excluded.brand_profile_id,
      release_type = excluded.release_type,
      release_status = excluded.release_status,
      release_date = excluded.release_date,
      readiness_json = excluded.readiness_json,
      distribution_json = excluded.distribution_json,
      asset_pack_json = excluded.asset_pack_json,
      results_json = excluded.results_json,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run({
    id: record.id,
    song_id: record.song_id,
    title: record.title,
    artist_name: record.artist_name || null,
    brand_profile_id: record.brand_profile_id || null,
    release_type: normalizeReleaseType(record.release_type),
    release_status: normalizeReleaseStatus(record.release_status),
    release_date: record.release_date || null,
    readiness_json: JSON.stringify(mergeNested({}, record.readiness, DEFAULT_READINESS)),
    distribution_json: JSON.stringify(mergeNested({}, record.distribution, DEFAULT_DISTRIBUTION)),
    asset_pack_json: JSON.stringify(mergeNested({}, record.asset_pack, DEFAULT_ASSET_PACK)),
    results_json: JSON.stringify(mergeNested({}, record.results, DEFAULT_RESULTS)),
    notes: record.notes || null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  });
}

function parseReleaseMarketing(row) {
  if (!row) return null;
  return {
    ...row,
    songId: row.song_id,
    artistName: row.artist_name,
    brandProfileId: row.brand_profile_id,
    releaseType: row.release_type,
    releaseStatus: row.release_status,
    releaseDate: row.release_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readiness: mergeNested(DEFAULT_READINESS, parseJsonObject(row.readiness_json), DEFAULT_READINESS),
    distribution: mergeNested(DEFAULT_DISTRIBUTION, parseJsonObject(row.distribution_json), DEFAULT_DISTRIBUTION),
    asset_pack: mergeNested(DEFAULT_ASSET_PACK, parseJsonObject(row.asset_pack_json), DEFAULT_ASSET_PACK),
    assetPack: mergeNested(DEFAULT_ASSET_PACK, parseJsonObject(row.asset_pack_json), DEFAULT_ASSET_PACK),
    results: mergeNested(DEFAULT_RESULTS, parseJsonObject(row.results_json), DEFAULT_RESULTS),
  };
}

function normalizeReleaseType(value) {
  return new Set(['single', 'ep', 'album']).has(value) ? value : 'single';
}

function normalizeReleaseStatus(value) {
  const allowed = new Set(['draft', 'ready_for_distribution', 'uploaded_to_distrokid', 'pre_release', 'released', 'archived']);
  return allowed.has(value) ? value : 'draft';
}

function inferReleaseStatus(song) {
  if (isOutreachCompleteSongStatus(song?.status) || song?.published_at) return 'released';
  if (isSubmittedSongStatus(song?.status) || song?.distributor_submission_date) return 'uploaded_to_distrokid';
  if (normalizeSongStatus(song?.status) === SONG_STATUSES.EDITING) return 'ready_for_distribution';
  return 'draft';
}

function seedDistributionFromSong(song) {
  const links = getReleaseLinks(song.id);
  const byPlatform = Object.fromEntries(links.map(link => [String(link.platform || '').toLowerCase(), link.url]));
  return {
    distrokidUploaded: Boolean(song.distributor_submission_date),
    distrokidUploadDate: song.distributor_submission_date || null,
    hyperfollowUrl: byPlatform.hyperfollow || byPlatform.distrokid || '',
    spotifyUrl: byPlatform.spotify || '',
    appleMusicUrl: byPlatform['apple music'] || '',
    youtubeMusicUrl: byPlatform['youtube music'] || byPlatform.youtube || '',
    otherLinks: links
      .filter(link => !['hyperfollow', 'distrokid', 'spotify', 'apple music', 'youtube music', 'youtube'].includes(String(link.platform || '').toLowerCase()))
      .map(link => ({ label: link.platform, url: link.url })),
  };
}

function computeReadinessPercent(readiness) {
  const checks = ['audioFinal', 'artworkFinal', 'lyricsFinal', 'metadataFinal', 'aiDisclosureApproved'];
  const passed = checks.filter(key => readiness?.[key]).length;
  return Math.round((passed / checks.length) * 100);
}

function mergeNested(base, patch, defaults) {
  return {
    ...defaults,
    ...normalizeObject(base),
    ...normalizeObject(patch),
  };
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

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
