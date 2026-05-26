/**
 * Music Pipeline — Web UI Server
 * Run with: ./bin/pancakerobot web
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);

const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import fs from 'fs';
import { spawn } from 'child_process';
import archiver from 'archiver';
import { createRequire as _cReq } from 'module';
const _multer = _cReq(import.meta.url)('multer');

import {
  getAllIdeas, getIdea, createIdea, updateIdea,
  deleteIdeas,
  getAllSongs, getSong, upsertSong, updateSongStatus, deleteSong,
  assignSongsToAlbum, createAlbum, reorderAlbumTracks, updateAlbum,
  getAssetsForSong, createAsset,
  getPublishingChecklist, updateChecklistItem, getChecklistProgress,
  getReleaseLinks, upsertReleaseLink,
  getPerformanceSnapshots,
  getDashboardStats,
  upsertReleaseCampaignTask,
} from '../shared/db.js';
import { getMarketingTargets } from '../shared/marketing-db.js';
import { getOutreachHistoryByTargetIds, normalizeOutletForApp } from '../shared/marketing-outlets.js';
import { pickSuggestedTopicFromSuggestions, runSuggestPipeline } from '../shared/suggest.js';
import {
  DEFAULT_PROFILE_ID,
  listBrandProfiles,
  loadBrandProfile,
  loadBrandProfileById,
  saveBrandProfileById,
  getActiveProfileId,
  setActiveProfileId,
  resolveBrandProfilePath,
} from '../shared/brand-profile.js';
import { generateThumbnails } from '../agents/creative-manager.js';
import { registerMarketingRouter } from './marketing/router-consolidated.js';
import { startDailySocialScheduler } from '../shared/social/daily-social-scheduler.js';
import { clearSongBaseImages, getSongCatalogMarketingSummary, scanMarketingPack, scanSongBaseImage } from '../shared/song-catalog-marketing.js';
import {
  getSongMarketingKit,
  saveSongMarketingKit,
  buildReleaseKitViewModel,
  MARKETING_LINK_FIELDS,
  MARKETING_ASSET_FIELDS,
} from '../shared/song-marketing-kit.js';
import {
  buildSongReleaseAssets,
  clearSongBaseImage,
  DEFAULT_RELEASE_ASSET_FORMATS,
  ensureReleaseAssetDerivatives,
  generatePrimaryImageWithOpenAI,
  getReleaseAssetState,
  getSongReleaseAssetState,
  markReleaseAssetsStale,
  selectSongPrimaryImage,
} from '../shared/song-release-assets-service.js';
import { getOrCreateReleaseMarketing } from '../shared/marketing-releases.js';
import {
  SONG_STATUSES,
  SONG_STATUS_OPTIONS,
  normalizeSongStatus,
  getSongStatusBadgeClass,
  getSongStatusLabel,
  isRecognizedSongStatusInput,
} from '../shared/song-status.js';
import { markSongSubmittedToDistroKid } from '../shared/distrokid-release.js';
import {
  captureHyperFollowLink,
  runDistroKidAlbumAutomation,
  runDistroKidSongAutomation,
} from '../shared/distrokid-automation.js';
import {
  clearDistroKidQueue,
  DISTROKID_JOB_STATUSES,
  getDistroKidJob,
  listDistroKidJobsBySongIds,
  queueSongForDistroKid,
} from '../shared/distrokid-jobs.js';
import { getSongNextAction } from '../shared/song-workflow.js';
import { analyzeRecentDraftSongsForReleaseSelection, analyzeSongForReleaseSelection } from '../agents/release-selection-agent.js';
import { generateMetadata } from '../agents/product-manager.js';
import { PIPELINE_STAGES } from '../lib/release-selection/constants.js';
import {
  ALBUM_COST_MODES,
  getAlbumSummary,
  repairAlbumBatch,
  resumeAlbumBatch,
  runAlbumBatch,
} from '../services/album-batch-service.js';
import { getAllAlbums, getAlbum, getSongsForAlbum } from '../shared/db.js';
import { removeSongsFromAlbum } from '../shared/album-track-membership.js';
import {
  assertReleaseLiveSubmitReady,
  buildReleaseCockpitViewModel,
  buildReleasePackageForCockpit,
  listReleaseCockpitEntries,
  logReleaseCockpitEvent,
  validateReleaseAction,
} from '../shared/release-cockpit.js';
import {
  createMagicReleaseCampaign,
  getMagicReleaseState,
  ingestBrowsyResult,
  refreshMagicReleasePlan,
  runMagicReleaseTask,
  runNextMagicReleaseTask,
} from '../shared/magic-release.js';
import {
  createOutreachRun,
  getCanonicalEmailOutletsForSelection,
} from '../agents/marketing-outreach-run-agent.js';

// ── Base image upload config ───────────────────────────────────────
const ALLOWED_IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const baseImageUpload = _multer({
  storage: _multer.diskStorage({
    destination: (req, _file, cb) => {
      const refDir = join(__dirname, '../../output/songs', req.params.id, 'reference');
      fs.mkdirSync(refDir, { recursive: true });
      clearSongBaseImages(req.params.id);
      cb(null, refDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `base-image${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_IMG_EXTS.has(ext));
  },
});

const albumImageUpload = _multer({
  storage: _multer.diskStorage({
    destination: (req, _file, cb) => {
      const refDir = join(__dirname, '../../output/albums', req.params.id, 'reference');
      fs.mkdirSync(refDir, { recursive: true });
      for (const name of fs.readdirSync(refDir)) {
        if (/^primary-image\.(png|jpe?g|webp)$/i.test(name)) fs.unlinkSync(join(refDir, name));
      }
      cb(null, refDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `primary-image${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_IMG_EXTS.has(ext));
  },
});

const albumCreateImageUpload = _multer({
  storage: _multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_IMG_EXTS.has(ext));
  },
});

// ── In-memory job store for suggest runs ──────────────────────────
const suggestJobs = new Map(); // jobId → { status, logs, results, error }

// In-memory job store for full song pipeline runs
const pipelineJobs = new Map(); // jobId → { status, logs, songId, error, startedAt }

const app = express();
const PORT = process.env.WEB_PORT || 3737;
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const APP_TITLE = BRAND_PROFILE.app_title || BRAND_NAME;
const DEFAULT_AUDIENCE_RANGE = BRAND_PROFILE.audience.age_range;
const DEFAULT_DISTRIBUTOR = BRAND_PROFILE.distribution.default_distributor || 'Distributor';
const DISTRIBUTOR_URL = BRAND_PROFILE.distribution.research_default_url || '';
const SUBMITTED_STATUS = SONG_STATUSES.SUBMITTED_TO_DISTROKID;

// ── Middleware ──────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));
// Serve generated output files under /media/
app.use('/media', express.static(join(__dirname, '../../output')));
app.use('/base-images', express.static(join(__dirname, '../../base images')));
app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
// extractScripts: false — scripts stay inline in the view (needed for Alpine.js x-data references)
app.set('layout extractScripts', false);

// ── Helpers injected into every template ───────────────────────
app.use((req, res, next) => {
  res.locals.formatDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  res.locals.formatDateTime = (iso) => {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };
  res.locals.timeAgo = (iso) => {
    if (!iso) return '—';
    const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  };
  res.locals.statusBadge = (status) => {
    if (isRecognizedSongStatusInput(status)) {
      return getSongStatusBadgeClass(status);
    }
    const map = {
      new: 'badge-gray',
      shortlisted: 'badge-blue',
      in_review: 'badge-yellow',
      promoted: 'badge-green',
      archived: 'badge-dim',
      rejected: 'badge-red',
    };
    return map[status] || 'badge-gray';
  };
  res.locals.songStatusOptions = SONG_STATUS_OPTIONS;
  res.locals.songStatusLabel = getSongStatusLabel;
  res.locals.recommendationLabel = recommendationLabel;
  res.locals.recommendationBadgeClass = recommendationBadgeClass;
  res.locals.treatmentBadgeClass = treatmentBadgeClass;
  res.locals.scoreBandClass = scoreBandClass;
  res.locals.currentPath = req.path;
  res.locals.brandProfile = BRAND_PROFILE;
  res.locals.brandName = BRAND_NAME;
  res.locals.appTitle = APP_TITLE;
  res.locals.logoPath = BRAND_PROFILE.ui.logo_path || '/logo.png';
  res.locals.sidebarSubtitle = BRAND_PROFILE.ui.sidebar_subtitle || 'Music Studio';
  res.locals.defaultAudienceRange = DEFAULT_AUDIENCE_RANGE;
  res.locals.defaultDistributor = DEFAULT_DISTRIBUTOR;
  res.locals.distributorUrl = DISTRIBUTOR_URL;
  res.locals.submittedStatus = SUBMITTED_STATUS;
  next();
});

// ── MARKETING ROUTER ────────────────────────────────────────────
registerMarketingRouter(app);

// ── DASHBOARD ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  const stats = getDashboardStats();
  const recentSongs = getAllSongs().slice(0, 5).map(s => ({
    ...s,
    progress: getChecklistProgress(s.id),
  }));
  const recentIdeas = getAllIdeas().slice(0, 5);
  res.render('dashboard', { stats, recentSongs, recentIdeas });
});

// ── RELEASE COCKPIT ─────────────────────────────────────────────
app.get('/releases', (req, res) => {
  res.render('releases/index', {
    releases: listReleaseCockpitEntries(),
  });
});

app.get('/releases/:type/:id', (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).render('404', { message: 'Release not found' });
  const feedbackMessage = String(req.query.notice || req.query.error || '').trim();
  const feedbackLevel = String(req.query.level || (req.query.error ? 'error' : 'info')).trim().toLowerCase();
  res.render('releases/detail', {
    cockpit,
    focus: String(req.query.focus || 'all'),
    actionFeedback: feedbackMessage ? { level: feedbackLevel, message: feedbackMessage } : null,
  });
});

app.post('/releases/:type/:id/actions/readiness', (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  const readiness = validateReleaseAction('readiness', cockpit);
  const canAdvance = cockpit.blockers.length === 0;
  logReleaseCockpitEvent(cockpit.type, cockpit.id, 'readiness_check', canAdvance ? 'complete' : 'blocked', canAdvance ? `Readiness passed; lifecycle can advance to ${cockpit.lifecycle.next}.` : `Readiness check found ${cockpit.blockers.length} blocker(s).`, { blockers: cockpit.blockers, lifecycle: cockpit.lifecycle, can_advance: canAdvance, readiness });
  respondReleaseAction(req, res, cockpit, canAdvance ? 'Readiness check passed.' : 'Readiness check found blockers.');
});

app.post('/releases/:type/:id/actions/package', async (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  try {
    validateReleaseAction('package', cockpit);
    const result = await buildReleasePackageForCockpit(cockpit.type, cockpit.id);
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'build_package', result.ok ? 'complete' : 'blocked', result.ok ? `Built canonical release package for ${result.trackCount} track(s).` : 'Release package built but is blocked.', result);
    respondReleaseAction(req, res, cockpit, 'Release package built.');
  } catch (error) {
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'build_package', /blocked/i.test(error.message) ? 'blocked' : 'failed', error.message);
    if (wantsJson(req)) return res.status(/blocked/i.test(error.message) ? 400 : 500).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(cockpit.type)}/${encodeURIComponent(cockpit.id)}`);
  }
});

app.post('/releases/:type/:id/actions/release-assets/build', async (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  try {
    const result = await ensureReleaseAssetDerivatives(cockpit.type === 'album' ? 'album' : 'song', cockpit.id, { force: true });
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'release_assets_build', 'complete', 'Release assets generated or refreshed.', {
      entityType: cockpit.type,
      releaseId: cockpit.id,
      previewUrl: result.previewUrl,
    });
    respondReleaseAction(req, res, cockpit, 'Release assets generated.');
  } catch (error) {
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'release_assets_build', /primary image/i.test(error.message) ? 'blocked' : 'failed', error.message);
    if (wantsJson(req)) return res.status(/primary image/i.test(error.message) ? 400 : 500).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(cockpit.type)}/${encodeURIComponent(cockpit.id)}#release-assets`);
  }
});

app.post('/releases/:type/:id/actions/package-validation', (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  const validation = cockpit.packageState?.validation;
  const ok = Boolean(validation?.ready);
  const message = validation?.summary || 'Canonical package manifest is missing.';
  logReleaseCockpitEvent(
    cockpit.type,
    cockpit.id,
    'package_validation',
    ok ? 'complete' : 'blocked',
    message,
    {
      package_path: cockpit.packageState?.path || null,
      manifest_path: cockpit.packageState?.manifestPath || null,
      validation,
    },
  );
  respondReleaseAction(req, res, cockpit, message, { level: ok ? 'success' : 'warning' });
});

app.post('/releases/:type/:id/actions/generate-metadata', async (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  try {
    const targets = cockpit.trackTable.rows.filter(row => row.affected.metadata);
    if (!targets.length) throw new Error('No tracks are missing metadata.');
    const results = [];
    for (const row of targets) {
      results.push(await generateMetadataForCockpitTrack(row.id));
    }
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'generate_metadata', 'complete', `Generated metadata for ${results.length} track(s).`, {
      songIds: results.map(result => result.songId),
    });
    respondReleaseAction(req, res, cockpit, `Generated metadata for ${results.length} track(s).`);
  } catch (error) {
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'generate_metadata', 'failed', error.message);
    if (wantsJson(req)) return res.status(500).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(cockpit.type)}/${encodeURIComponent(cockpit.id)}?focus=metadata#tracks`);
  }
});

app.post('/releases/:type/:id/actions/distrokid-preview', async (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  try {
    validateReleaseAction('preview', cockpit);
    if (cockpit.stages.find(stage => stage.key === 'distrokid_preview')?.status === 'running') {
      return respondReleaseAction(req, res, cockpit, 'DistroKid preview automation is already running.', { level: 'warning' });
    }
    const runId = `preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const command = buildDistroKidPreviewCommand(cockpit);
    const runningLog = logReleaseCockpitEvent(cockpit.type, cockpit.id, 'distrokid_preview', 'running', 'DistroKid preview automation started.', {
      runId,
      command,
      script: 'scripts/distrokid/upload-release.mjs',
      entityType: cockpit.type,
      releaseId: cockpit.id,
    });
    runReleaseAutomationInBackground({
      cockpit,
      action: 'distrokid_preview',
      runId,
      command,
      runner: () => cockpit.type === 'album'
        ? runDistroKidAlbumAutomation(cockpit.id, { mode: 'preview' })
        : runDistroKidSongAutomation(cockpit.id, { mode: 'preview' }),
      runningLog,
    });
    respondReleaseAction(req, res, cockpit, `DistroKid preview automation started. Run ID ${runId}.`, { level: 'info' });
  } catch (error) {
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'distrokid_preview', 'failed', error.message);
    if (wantsJson(req)) return res.status(500).json({ ok: false, error: error.message });
    res.redirect(303, buildReleaseDetailUrl(cockpit.type, cockpit.id, { error: error.message, level: 'error' }));
  }
});

app.post('/releases/:type/:id/actions/distrokid-live-submit', async (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  try {
    assertReleaseLiveSubmitReady(cockpit.type, cockpit.id);
    validateReleaseAction('live_submit', cockpit, { confirm: req.body?.confirm === 'true' || req.body?.confirm === true });
    const result = cockpit.type === 'album'
      ? await runDistroKidAlbumAutomation(cockpit.id, { mode: 'live', confirm: true })
      : await runDistroKidSongAutomation(cockpit.id, { mode: 'live', confirm: true });
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'distrokid_live_submit', 'complete', 'DistroKid live submit finished.', result);
    respondReleaseAction(req, res, cockpit, 'DistroKid live submit finished.');
  } catch (error) {
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'distrokid_live_submit', 'blocked', error.message);
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(cockpit.type)}/${encodeURIComponent(cockpit.id)}`);
  }
});

app.post('/releases/:type/:id/actions/approve-live-submit', async (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  try {
    validateReleaseAction('preview', cockpit);
    const state = getMagicReleaseState(cockpit.type, cockpit.id) || createMagicReleaseCampaign({ releaseType: cockpit.type, releaseId: cockpit.id });
    const reason = String(req.body?.reason || '').trim() || 'Approved from Release Cockpit.';
    upsertReleaseCampaignTask({
      campaign_id: state.campaign.id,
      task_key: 'distrokid_final_submit_approval',
      title: 'Ken approval gate for DistroKid final submit',
      owner: 'ken',
      status: 'complete',
      blocking: true,
      due_date: state.tasks.find(task => task.task_key === 'distrokid_final_submit_approval')?.due_date || null,
      action_url: `/releases/${encodeURIComponent(cockpit.type)}/${encodeURIComponent(cockpit.id)}`,
      reason,
      completed_at: new Date().toISOString(),
    });
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'approve_live_submit', 'complete', 'Live submit approved for external submission.', { reason });
    respondReleaseAction(req, res, cockpit, 'Live submit approved.');
  } catch (error) {
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'approve_live_submit', 'blocked', error.message);
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(cockpit.type)}/${encodeURIComponent(cockpit.id)}`);
  }
});

app.post('/releases/:type/:id/actions/hyperfollow', async (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  try {
    validateReleaseAction('hyperfollow', cockpit);
    const url = req.body?.hyperfollow_url || req.body?.url;
    const results = [];
    for (const track of cockpit.tracks) results.push(await captureHyperFollowLink(track.id, { hyperfollowUrl: url }));
    const captured = results.find(result => result.url) || results[0] || { url: null };
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'hyperfollow', captured.url ? 'complete' : 'pending', captured.url ? 'HyperFollow URL saved.' : 'HyperFollow URL is not available yet.', captured);
    respondReleaseAction(req, res, cockpit, captured.url ? 'HyperFollow URL saved.' : 'HyperFollow URL is not available yet.');
  } catch (error) {
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'hyperfollow', 'failed', error.message);
    if (wantsJson(req)) return res.status(500).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(cockpit.type)}/${encodeURIComponent(cockpit.id)}`);
  }
});

app.post('/releases/:type/:id/actions/outreach', (req, res) => {
  const cockpit = buildReleaseCockpitViewModel(req.params.type, req.params.id);
  if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
  try {
    const draftOnly = req.body?.draft_only === 'true' || req.body?.draft_only === true || !cockpit.hyperfollow?.url;
    validateReleaseAction('outreach', cockpit, { draftOnly });
    const outlets = getCanonicalEmailOutletsForSelection().slice(0, 25);
    if (!outlets.length) throw new Error('No approved email outreach outlets are available.');
    const result = createOutreachRun({
      song_ids: cockpit.tracks.map(track => track.id),
      outlet_ids: outlets.map(outlet => outlet.id),
      mode: cockpit.type === 'album' ? 'bundle' : 'single_release',
      dry_run: true,
      notes: draftOnly ? 'Cockpit pre-HyperFollow draft-only outreach run.' : 'Cockpit HyperFollow-ready draft outreach run.',
      allow_same_release: false,
    });
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'outreach_campaign', draftOnly ? 'draft_only' : 'complete', draftOnly ? 'Pre-HyperFollow draft-only outreach campaign built.' : 'Draft outreach campaign built.', { ...result, draft_only: draftOnly });
    respondReleaseAction(req, res, cockpit, 'Draft outreach campaign built.');
  } catch (error) {
    logReleaseCockpitEvent(cockpit.type, cockpit.id, 'outreach_campaign', 'blocked', error.message);
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(cockpit.type)}/${encodeURIComponent(cockpit.id)}`);
  }
});

app.post('/releases/:type/:id/magic-release/create', (req, res) => {
  try {
    const state = createMagicReleaseCampaign({ releaseType: req.params.type, releaseId: req.params.id });
    if (wantsJson(req)) return res.json({ ok: true, state });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  }
});

app.post('/releases/:type/:id/magic-release/plan', (req, res) => {
  try {
    const state = refreshMagicReleasePlan({ releaseType: req.params.type, releaseId: req.params.id });
    if (wantsJson(req)) return res.json({ ok: true, state });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  }
});

app.post('/releases/:type/:id/magic-release/run-next', async (req, res) => {
  try {
    const result = await runNextMagicReleaseTask({
      releaseType: req.params.type,
      releaseId: req.params.id,
      dryRun: req.body?.dry_run !== 'false',
    });
    if (wantsJson(req)) return res.json({ ok: true, result });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    if (wantsJson(req)) return res.status(500).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  }
});

app.post('/releases/:type/:id/magic-release/browsy-dry-run', async (req, res) => {
  try {
    const state = getMagicReleaseState(req.params.type, req.params.id) || createMagicReleaseCampaign({ releaseType: req.params.type, releaseId: req.params.id });
    const task = state.tasks.find(item => item.owner === 'browsy' && item.status === 'ready');
    if (!task) throw new Error('No ready Browsy task is available.');
    const result = await runMagicReleaseTask({ campaignId: state.campaign.id, taskKey: task.task_key, dryRun: true });
    if (wantsJson(req)) return res.json({ ok: true, result });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  }
});

app.post('/releases/:type/:id/magic-release/tasks/:taskKey/run', async (req, res) => {
  try {
    const state = getMagicReleaseState(req.params.type, req.params.id) || createMagicReleaseCampaign({ releaseType: req.params.type, releaseId: req.params.id });
    const result = await runMagicReleaseTask({
      campaignId: state.campaign.id,
      taskKey: req.params.taskKey,
      dryRun: req.body?.dry_run !== 'false',
    });
    if (wantsJson(req)) return res.json({ ok: true, result });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  }
});

app.post('/releases/:type/:id/magic-release/tasks/:taskKey/skip', async (req, res) => {
  try {
    const state = getMagicReleaseState(req.params.type, req.params.id) || createMagicReleaseCampaign({ releaseType: req.params.type, releaseId: req.params.id });
    const task = state.tasks.find(item => item.task_key === req.params.taskKey);
    if (!task) throw new Error('Magic Release task not found.');
    if (task.blocking) throw new Error('Required release steps cannot be skipped.');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new Error('A skip reason is required.');
    upsertReleaseCampaignTask({
      id: task.id,
      campaign_id: state.campaign.id,
      task_key: task.task_key,
      status: 'skipped',
      reason,
      completed_at: new Date().toISOString(),
    });
    logReleaseCockpitEvent(req.params.type, req.params.id, 'magic_release_skip', 'complete', `Skipped optional Magic Release task ${task.task_key}.`, {
      taskKey: task.task_key,
      reason,
    });
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  }
});

app.post('/releases/:type/:id/tracks/:songId/metadata/generate', async (req, res) => {
  try {
    await generateMetadataForCockpitTrack(req.params.songId);
    const returnTo = `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}?focus=metadata#tracks`;
    res.redirect(303, returnTo);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/releases/:type/:id/tracks/:songId/remove', (req, res) => {
  try {
    if (String(req.params.type || '').toLowerCase() !== 'album') throw new Error('Tracks can only be removed from album releases.');
    removeSongsFromAlbum(req.params.id, [req.params.songId]);
    markReleaseAssetsStale('album', req.params.id);
    logReleaseCockpitEvent('album', req.params.id, 'remove_track', 'complete', `Removed ${req.params.songId} from album release.`, { songId: req.params.songId });
    res.redirect(303, `/releases/album/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    res.status(/not found/i.test(error.message) ? 404 : 400).send(error.message);
  }
});

app.post('/releases/:type/:id/magic-release/ingest-result', (req, res) => {
  ingestBrowsyResult({
    resultPath: req.body?.result_path || req.body?.resultPath,
  }).then(result => {
    if (wantsJson(req)) return res.json({ ok: true, result });
    return res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  }).catch(error => {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: error.message });
    return res.redirect(303, `/releases/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}`);
  });
});

app.get('/magic-song', (req, res) => {
  res.render('magic-song', {
    topic: typeof req.query.topic === 'string' ? req.query.topic : '',
    notes: typeof req.query.notes === 'string' ? req.query.notes : '',
    error: null,
  });
});

app.post('/magic-song', async (req, res) => {
  let topic = String(req.body?.topic || '').trim();
  const notes = String(req.body?.notes || '').trim();

  if (!topic) {
    try {
      const suggestions = await runSuggestPipeline(() => {}, { brandProfileId: getActiveProfileId() });
      topic = pickSuggestedTopicFromSuggestions(suggestions);
    } catch (error) {
      return res.status(500).render('magic-song', {
        topic,
        notes,
        error: `Could not generate a Magic Song topic automatically: ${error.message}`,
      });
    }
  }

  if (!topic) {
    return res.status(500).render('magic-song', {
      topic,
      notes,
      error: 'Could not generate a Magic Song topic automatically.',
    });
  }

  const songId = `SONG_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'magic-song';

  upsertSong({
    id: songId,
    title: topic,
    slug,
    topic,
    status: 'draft',
    concept: topic,
    target_age_range: DEFAULT_AUDIENCE_RANGE,
    notes: notes || null,
    distributor: DEFAULT_DISTRIBUTOR,
    brand_profile_id: getActiveProfileId(),
  });

  res.redirect(`/songs/${encodeURIComponent(songId)}/generate?pipelineMode=magic&autoStart=1`);
});

// ── ALBUM BATCH ("Generate Album") ─────────────────────────────

const albumBatchJobs = new Map(); // jobId → { albumId, status, events, error }

app.get('/album-batch', (req, res) => {
  const profiles = listBrandProfiles();
  const albums = getAllAlbums().slice(0, 25).map(album => ({
    ...album,
    finance: album.finance_summary || null,
  }));
  res.render('album-batch/index', {
    profiles,
    activeBrandId: getActiveProfileId(),
    costModes: ALBUM_COST_MODES,
    albums,
    error: null,
  });
});

app.post('/album-batch', async (req, res) => {
  const brandProfileId = String(req.body?.brandProfileId || getActiveProfileId() || '').trim();
  const numberOfSongs = Math.max(1, Math.floor(Number(req.body?.numberOfSongs) || 0));
  const costMode = String(req.body?.costMode || 'standard').trim().toLowerCase();
  const albumTheme = String(req.body?.albumTheme || '').trim() || null;
  const releaseIntent = String(req.body?.releaseIntent || '').trim() || null;
  const notes = String(req.body?.notes || '').trim() || null;

  if (!brandProfileId || !numberOfSongs) {
    const profiles = listBrandProfiles();
    return res.status(400).render('album-batch/index', {
      profiles,
      activeBrandId: getActiveProfileId(),
      costModes: ALBUM_COST_MODES,
      albums: getAllAlbums().slice(0, 25),
      error: 'A brand profile and a number of songs are required.',
    });
  }

  const jobId = `albumjob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  albumBatchJobs.set(jobId, { status: 'running', events: [], albumId: null, error: null, startedAt: Date.now() });

  runAlbumBatch({
    brandProfileId,
    numberOfSongs,
    costMode,
    albumTheme,
    releaseIntent,
    notes,
    onEvent: (event) => {
      const job = albumBatchJobs.get(jobId);
      if (!job) return;
      if (event.albumId && !job.albumId) job.albumId = event.albumId;
      job.events.push(event);
    },
  }).then((result) => {
    const job = albumBatchJobs.get(jobId);
    if (job) {
      job.status = result.status;
      job.albumId = result.albumId;
      job.result = result;
    }
  }).catch((err) => {
    const job = albumBatchJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
  });

  res.redirect(`/album-batch/jobs/${encodeURIComponent(jobId)}`);
});

app.get('/album-batch/jobs/:jobId', (req, res) => {
  const job = albumBatchJobs.get(req.params.jobId);
  if (!job) return res.status(404).render('404', { message: 'Album batch job not found' });
  const album = job.albumId ? getAlbumSummary(job.albumId) : null;
  res.render('album-batch/job', { jobId: req.params.jobId, job, album });
});

app.get('/api/album-batch/jobs/:jobId', (req, res) => {
  const job = albumBatchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  res.json(job);
});

app.get('/albums/:id', (req, res) => {
  const summary = getAlbumSummary(req.params.id);
  if (!summary) return res.status(404).render('404', { message: 'Album not found' });
  const albumTracks = getSongsForAlbum(req.params.id);
  res.render('album-batch/detail', {
    ...summary,
    songs: albumTracks,
    albumAssets: getAlbumAssetState(req.params.id),
    albumSmartLink: buildAlbumSmartLink(albumTracks),
  });
});

app.post('/albums/add-tracks', albumCreateImageUpload.single('primary_image'), (req, res) => {
  try {
    const songIds = normalizeSongIdList(req.body?.song_ids || req.body?.songIds);
    const mode = req.body?.album_mode === 'existing' ? 'existing' : 'new';
    const warnings = validateAlbumTrackAssignment(songIds, { targetAlbumId: mode === 'existing' ? req.body?.existing_album_id : null });
    if (warnings.length && req.body?.allow_conflicts !== 'on' && req.body?.allow_conflicts !== true) {
      return res.status(400).send(`Album assignment needs confirmation: ${warnings.join('; ')}`);
    }

    let albumId = null;
    if (mode === 'existing') {
      albumId = String(req.body?.existing_album_id || '').trim();
      if (!getAlbum(albumId)) return res.status(404).send('Album not found');
      const existingTracks = getSongsForAlbum(albumId);
      assignSongsToAlbum(albumId, songIds, {
        startTrackNumber: existingTracks.reduce((max, song) => Math.max(max, Number(song.track_number) || 0), 0) + 1,
      });
      if (req.body?.release_date) updateAlbum(albumId, { release_date: req.body.release_date });
    } else {
      const title = String(req.body?.album_title || '').trim();
      if (!title) return res.status(400).send('Album title is required');
      albumId = createAlbum({
        album_title: title,
        album_theme: String(req.body?.album_theme || '').trim() || null,
        brand_profile_id: String(req.body?.brand_profile_id || '').trim() || getActiveProfileId(),
        release_date: String(req.body?.release_date || '').trim() || null,
        number_of_songs: songIds.length,
        status: 'assembled',
        cost_mode: 'standard',
      });
      assignSongsToAlbum(albumId, songIds, { startTrackNumber: 1 });
    }

    const orderedSongIds = parseTrackOrderFromBody(req.body, songIds);
    if (orderedSongIds.length) reorderAlbumTracks(albumId, orderedSongIds);
    if (req.file) saveUploadedAlbumPrimaryImage(albumId, req.file);

    res.redirect(303, `/albums/${encodeURIComponent(albumId)}`);
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    res.status(status).send(error.message);
  }
});

app.post('/api/albums/:id/primary-image', (req, res) => {
  const album = getAlbum(req.params.id);
  if (!album) return res.status(404).json({ ok: false, error: 'Album not found' });
  albumImageUpload.single('base_image')(req, res, (err) => {
    const wantsHtml = !String(req.headers.accept || '').includes('application/json');
    if (err || !req.file) {
      const error = err?.message || 'No valid image file provided (png/jpg/jpeg/webp)';
      if (wantsHtml) return res.redirect(303, `/albums/${encodeURIComponent(album.id)}?error=${encodeURIComponent(error)}`);
      return res.status(400).json({ ok: false, error });
    }
    markReleaseAssetsStale('album', album.id);
    if (wantsHtml) return res.redirect(303, `/albums/${encodeURIComponent(album.id)}`);
    return res.json({ ok: true, albumId: album.id, albumAssets: getAlbumAssetState(album.id) });
  });
});

app.post('/api/albums/:id/release-assets/build', async (req, res) => {
  const album = getAlbum(req.params.id);
  if (!album) return res.status(404).json({ ok: false, error: 'Album not found' });
  try {
    const result = await ensureReleaseAssetDerivatives('album', album.id, { force: true });
    if (!String(req.headers.accept || '').includes('application/json')) return res.redirect(303, `/albums/${encodeURIComponent(album.id)}`);
    res.json({ ok: true, albumId: album.id, result, albumAssets: getAlbumAssetState(album.id) });
  } catch (error) {
    const status = /primary image/i.test(error.message) ? 400 : 500;
    res.status(status).json({ ok: false, error: error.message });
  }
});

app.post('/api/albums/:id/release-assets/generate-image', async (req, res) => {
  try {
    const result = await generatePrimaryImageWithOpenAI('album', req.params.id, {
      entityType: 'album',
      entityId: req.params.id,
      brandProfileId: req.body?.brandProfileId || getActiveProfileId(),
      title: req.body?.title,
      artist: req.body?.artist,
      prompt: req.body?.prompt,
      styleGuardrails: req.body?.styleGuardrails,
      outputKind: req.body?.outputKind || 'cover',
    });
    res.status(result.ok === false ? 503 : 200).json(result);
  } catch (error) {
    res.status(error.message.startsWith('Album not found:') ? 404 : 500).json({ ok: false, error: error.message });
  }
});

app.get('/api/albums/:id/release-assets', (req, res) => {
  const album = getAlbum(req.params.id);
  if (!album) return res.status(404).json({ ok: false, error: 'Album not found' });
  res.json({ ok: true, albumId: album.id, albumAssets: getAlbumAssetState(album.id) });
});

app.get('/api/albums/:id/release-assets/state', (req, res) => {
  const album = getAlbum(req.params.id);
  if (!album) return res.status(404).json({ ok: false, error: 'Album not found' });
  res.json({ ok: true, albumId: album.id, albumAssets: getAlbumAssetState(album.id) });
});

app.get('/api/albums/:id/release-assets/preview', async (req, res) => {
  const album = getAlbum(req.params.id);
  if (!album) return res.status(404).json({ ok: false, error: 'Album not found' });
  try {
    const state = await ensureReleaseAssetDerivatives('album', album.id);
    res.redirect(state.dashboardUrl);
  } catch (error) {
    res.status(/primary image/i.test(error.message) ? 400 : 500).json({ ok: false, error: error.message });
  }
});

app.get('/api/albums/:id/release-assets/download', async (req, res) => {
  const album = getAlbum(req.params.id);
  if (!album) return res.status(404).json({ ok: false, error: 'Album not found' });
  try {
    await ensureReleaseAssetDerivatives('album', album.id);
    sendAssetPackZip(res, join(__dirname, '../../output/albums', album.id, 'assets'), `album-${album.id}-release-assets.zip`);
  } catch (error) {
    res.status(/primary image/i.test(error.message) ? 400 : 500).json({ ok: false, error: error.message });
  }
});

app.post('/albums/:id/repair', (req, res) => {
  const albumId = req.params.id;
  const jobId = `albumrepair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  albumBatchJobs.set(jobId, { status: 'running', events: [], albumId, error: null, startedAt: Date.now(), repair: true });

  repairAlbumBatch({
    albumId,
    onEvent: (event) => {
      const job = albumBatchJobs.get(jobId);
      if (!job) return;
      job.events.push(event);
    },
  }).then((result) => {
    const job = albumBatchJobs.get(jobId);
    if (job) {
      job.status = result.status;
      job.result = result;
    }
  }).catch((err) => {
    const job = albumBatchJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
  });

  res.redirect(`/album-batch/jobs/${encodeURIComponent(jobId)}`);
});

app.post('/albums/:id/tracks/order', (req, res) => {
  try {
    const tracks = getSongsForAlbum(req.params.id);
    const ordered = tracks
      .map(song => ({
        id: song.id,
        order: Number(req.body?.[`track_order_${song.id}`]) || Number(song.track_number) || 999,
      }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map(item => item.id);
    reorderAlbumTracks(req.params.id, ordered);
    res.redirect(303, `/albums/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    res.status(/not found/i.test(error.message) ? 404 : 400).send(error.message);
  }
});

app.post('/albums/:id/resume', (req, res) => {
  const albumId = req.params.id;
  const jobId = `albumresume_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  albumBatchJobs.set(jobId, { status: 'running', events: [], albumId, error: null, startedAt: Date.now(), resume: true });

  resumeAlbumBatch({
    albumId,
    onEvent: (event) => {
      const job = albumBatchJobs.get(jobId);
      if (!job) return;
      job.events.push(event);
    },
  }).then((result) => {
    const job = albumBatchJobs.get(jobId);
    if (job) {
      job.status = result.status;
      job.result = result;
    }
  }).catch((err) => {
    const job = albumBatchJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
  });

  res.redirect(`/album-batch/jobs/${encodeURIComponent(jobId)}`);
});

// ── IDEA GENERATOR (AI pipeline) ───────────────────────────────

// Page: shows generate UI / live stream / results
app.get('/ideas/generate', (req, res) => {
  const { job } = req.query;
  const jobData = job ? suggestJobs.get(job) : null;
  res.render('ideas/generate', { jobId: job || null, jobData: jobData || null });
});

// POST: kick off a new suggest job, redirect to SSE page
app.post('/api/suggest/run', (req, res) => {
  const jobId = `job_${Date.now().toString(36)}`;
  const themePrompt = typeof req.body?.themePrompt === 'string'
    ? req.body.themePrompt.trim()
    : '';

  suggestJobs.set(jobId, { status: 'running', logs: [], results: null, error: null, startedAt: Date.now(), themePrompt });

  // Run async — don't await
  runSuggestPipeline((msg) => {
    const job = suggestJobs.get(jobId);
    if (job) job.logs.push(msg);
  }, { themePrompt, brandProfileId: getActiveProfileId() }).then((results) => {
    const job = suggestJobs.get(jobId);
    if (job) { job.status = 'done'; job.results = results; }
  }).catch((err) => {
    const job = suggestJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = err.message; }
  });

  res.json({ ok: true, jobId });
});

// GET SSE: stream logs + completion event
app.get('/api/suggest/stream/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let lastLogIndex = 0;

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tick = () => {
    const job = suggestJobs.get(jobId);
    if (!job) { send('error', { message: 'Job not found' }); res.end(); return; }

    // Send any new log lines
    const newLogs = job.logs.slice(lastLogIndex);
    for (const line of newLogs) {
      send('log', { message: line });
    }
    lastLogIndex = job.logs.length;

    if (job.status === 'done') {
      send('complete', { results: job.results });
      res.end();
    } else if (job.status === 'error') {
      send('error', { message: job.error });
      res.end();
    } else {
      setTimeout(tick, 500);
    }
  };

  req.on('close', () => { /* client disconnected */ });
  tick();
});

// GET: job status/results (for polling fallback)
app.get('/api/suggest/status/:jobId', (req, res) => {
  const job = suggestJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── IDEAS ──────────────────────────────────────────────────────
app.get('/ideas', (req, res) => {
  let ideas = getAllIdeas();
  const { q, status, category, brand } = req.query;
  if (q) {
    const lq = q.toLowerCase();
    ideas = ideas.filter(i =>
      (i.title || '').toLowerCase().includes(lq) ||
      (i.concept || '').toLowerCase().includes(lq) ||
      (i.hook || '').toLowerCase().includes(lq) ||
      (i.tags || []).some(t => t.toLowerCase().includes(lq))
    );
  }
  if (status) ideas = ideas.filter(i => i.status === status);
  if (category) ideas = ideas.filter(i => i.category === category);
  if (brand) ideas = ideas.filter(i => i.brand_profile_id === brand);

  const categories = [...new Set(getAllIdeas().map(i => i.category).filter(Boolean))].sort();
  const profiles = listBrandProfiles();
  res.render('ideas/index', { ideas, q: q || '', filterStatus: status || '', filterCategory: category || '', filterBrand: brand || '', categories, profiles });
});

app.get('/ideas/new', (req, res) => {
  res.render('ideas/form', { idea: null, error: null });
});

app.post('/ideas', (req, res) => {
  const { title, concept, hook, target_age_range, category, mood, educational_angle, tags, lyric_seed, thumbnail_seed, notes } = req.body;
  if (!title || !title.trim()) {
    return res.render('ideas/form', { idea: req.body, error: 'Title is required.' });
  }
  createIdea({
    title: title.trim(),
    concept: concept?.trim() || null,
    hook: hook?.trim() || null,
    target_age_range: target_age_range || DEFAULT_AUDIENCE_RANGE,
    category: category?.trim() || null,
    mood: mood?.trim() || null,
    educational_angle: educational_angle?.trim() || null,
    tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    lyric_seed: lyric_seed?.trim() || null,
    thumbnail_seed: thumbnail_seed?.trim() || null,
    notes: notes?.trim() || null,
    source_type: 'manual',
    brand_profile_id: getActiveProfileId(),
  });
  res.redirect('/ideas');
});

app.get('/ideas/:id', (req, res) => {
  // Guard: don't catch named routes
  if (req.params.id === 'generate' || req.params.id === 'new') return res.redirect('/ideas/' + req.params.id === 'generate' ? '/ideas/generate' : '/ideas/new');
  const idea = getIdea(req.params.id);
  if (!idea) return res.status(404).render('404', { message: 'Idea not found' });
  const song = idea.promoted_song_id ? getSong(idea.promoted_song_id) : null;
  res.render('ideas/detail', { idea, song });
});

app.get('/ideas/:id/edit', (req, res) => {
  const idea = getIdea(req.params.id);
  if (!idea) return res.status(404).render('404', { message: 'Idea not found' });
  res.render('ideas/form', { idea, error: null });
});

app.post('/ideas/:id', (req, res) => {
  const { title, concept, hook, target_age_range, category, mood, educational_angle, tags, lyric_seed, thumbnail_seed, notes } = req.body;
  if (!title || !title.trim()) {
    const idea = getIdea(req.params.id);
    return res.render('ideas/form', { idea: { ...idea, ...req.body }, error: 'Title is required.' });
  }
  updateIdea(req.params.id, {
    title: title.trim(),
    concept: concept?.trim() || null,
    hook: hook?.trim() || null,
    target_age_range: target_age_range || DEFAULT_AUDIENCE_RANGE,
    category: category?.trim() || null,
    mood: mood?.trim() || null,
    educational_angle: educational_angle?.trim() || null,
    tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    lyric_seed: lyric_seed?.trim() || null,
    thumbnail_seed: thumbnail_seed?.trim() || null,
    notes: notes?.trim() || null,
  });
  res.redirect(`/ideas/${req.params.id}`);
});

// API: permanently delete selected ideas
app.post('/api/ideas/bulk-delete', (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(id => String(id || '').trim()).filter(Boolean)
      : [];

    if (ids.length === 0) {
      return res.status(400).json({ ok: false, error: 'Select at least one idea to delete.' });
    }

    const deleted = deleteIdeas(ids);
    res.json({ ok: true, deleted, requested: new Set(ids).size });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: update idea status
app.post('/api/ideas/:id/status', (req, res) => {
  const { status } = req.body;
  const allowed = ['new', 'shortlisted', 'in_review', 'promoted', 'archived'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  updateIdea(req.params.id, { status });
  res.json({ ok: true });
});

// API: duplicate idea
app.post('/api/ideas/:id/duplicate', (req, res) => {
  const idea = getIdea(req.params.id);
  if (!idea) return res.status(404).json({ error: 'Not found' });
  const newId = createIdea({
    ...idea,
    id: undefined,
    title: `${idea.title} (copy)`,
    status: 'new',
    promoted_song_id: null,
    source_type: 'derived',
    source_ref: idea.id,
  });
  res.json({ ok: true, id: newId });
});

// Promote idea → song
app.post('/api/ideas/:id/promote', (req, res) => {
  const idea = getIdea(req.params.id);
  if (!idea) return res.status(404).json({ error: 'Not found' });

  const songId = `SONG_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const slug = (idea.title || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  upsertSong({
    id: songId,
    title: idea.title,
    slug,
    topic: idea.concept || idea.title,
    status: 'draft',
    originating_idea_id: idea.id,
    concept: idea.concept || null,
    target_age_range: idea.target_age_range || DEFAULT_AUDIENCE_RANGE,
    mood_tags: idea.mood ? [idea.mood] : [],
    keywords: idea.tags || [],
    notes: idea.notes || null,
    distributor: DEFAULT_DISTRIBUTOR,
    brand_profile_id: idea.brand_profile_id || getActiveProfileId(),
  });

  updateIdea(idea.id, { status: 'promoted', promoted_song_id: songId });

  // Return generateUrl so the UI can redirect straight to the pipeline terminal
  res.json({ ok: true, songId, generateUrl: `/songs/${songId}/generate` });
});

// ── SONG PIPELINE (generate song from topic) ───────────────────

// Page: live terminal for song generation
app.get('/songs/:id/generate', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).render('404', { message: 'Song not found' });
  const job = req.query.job ? pipelineJobs.get(req.query.job) : null;
  res.render('songs/generate', { song, jobId: req.query.job || null, job: job || null });
});

// POST: spawn the orchestrator pipeline for a song
app.post('/api/songs/:id/generate', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  const jobId = `pipe_${Date.now().toString(36)}`;
  const generationProfile = resolveSongBrandProfile(song);
  const topic = song.topic || song.title || `${generationProfile.profile.music.default_style} song`;
  const pipelineMode = String(req.body?.pipelineMode || 'standard').trim().toLowerCase() === 'magic' ? 'magic' : 'standard';
  const pipelineFlag = pipelineMode === 'magic' ? '--magic' : '--new';

  const spawnedProfileId = generationProfile.id;
  pipelineJobs.set(jobId, {
    status: 'running',
    logs: [],
    songId: song.id,
    pipelineMode,
    spawnedProfileId,
    error: null,
    startedAt: Date.now(),
  });

  const orchestratorPath = join(__dirname, '../orchestrator.js');
  const activeProfilePath = resolveBrandProfilePath(spawnedProfileId);
  const child = spawn('node', [orchestratorPath, pipelineFlag, '--id', song.id, topic], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      WEB_PIPELINE: '1',
      REGENERATE_FROM_EXISTING: '1',
      FORCE_COLOR: '0',
      BRAND_PROFILE_PATH: activeProfilePath,
    },
  });

  const job = pipelineJobs.get(jobId);

  // Aggressive ANSI + chalk artifact stripper
  const stripAnsi = (s) => s
    .replace(/\x1B\[[0-9;]*[mGKHFABCDEFsuhl]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
    .trim();

  const processLine = (line) => {
    const clean = stripAnsi(line);
    if (!clean) return;
    job.logs.push(clean);
    // Try multiple patterns to catch Song ID
    const idMatch = clean.match(/SONG_[A-Z0-9_]+/);
    if (idMatch && idMatch[0].length > 8) job.songId = idMatch[0];
  };

  let stderrBuf = '';
  let stdoutBuf = '';

  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    lines.forEach(processLine);
  });

  child.stderr.on('data', (data) => {
    stderrBuf += data.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    lines.forEach(l => {
      const clean = stripAnsi(l);
      if (clean && !clean.includes('DeprecationWarning') && !clean.includes('ExperimentalWarning')) {
        job.logs.push('⚠ ' + clean);
      }
    });
  });

  child.on('close', (code) => {
    if (stdoutBuf.trim()) processLine(stdoutBuf);

    if (code === 0) {
      job.status = 'done';
      job.logs.push('✅ Pipeline complete!');
      if (job.spawnedProfileId) {
        try {
          const completedSong = getSong(job.songId);
          upsertSong({
            id: job.songId,
            brand_profile_id: completedSong?.brand_profile_id || job.spawnedProfileId,
          });
        } catch {}
      }
    } else {
      job.status = 'error';
      job.error = `Process exited with code ${code}`;
      job.logs.push(`❌ Pipeline failed (exit code ${code})`);
      job.logs.push('👆 Scroll up to find the error above');
    }
  });

  child.on('error', (err) => {
    job.status = 'error';
    job.error = err.message;
    job.logs.push('❌ Failed to start: ' + err.message);
  });

  res.json({ ok: true, jobId });
});

// GET SSE: stream pipeline logs
app.get('/api/songs/pipeline/stream/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let lastIndex = 0;
  let closed = false;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(': heartbeat\n\n');
  }, 15000);

  const closeStream = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.end();
  };

  const tick = () => {
    if (closed) return;
    const job = pipelineJobs.get(jobId);
    if (!job) {
      send('error', { message: 'Job not found' });
      closeStream();
      return;
    }

    const newLogs = job.logs.slice(lastIndex);
    for (const line of newLogs) send('log', { message: line });
    lastIndex = job.logs.length;

    if (job.status === 'done') {
      send('complete', { songId: job.songId, originalSongId: job.originalSongId });
      closeStream();
    } else if (job.status === 'error') {
      send('error', { message: job.error });
      closeStream();
    } else {
      setTimeout(tick, 600);
    }
  };

  req.on('close', () => {
    clearInterval(heartbeat);
    closed = true;
  });
  tick();
});

// ── SONGS ──────────────────────────────────────────────────────
app.get('/songs', (req, res) => {
  const baseSongs = getAllSongs();
  const distrokidJobsBySongId = listDistroKidJobsBySongIds(baseSongs.map(song => song.id));
  let songs = baseSongs.map(s => {
    const songDir = join(__dirname, '../../output/songs', s.id);
    const fsAssets = scanSongDir(songDir);
    const metadata = readSongMetadata(songDir);
    const lyricsContent = readTextFile(fsAssets.lyrics);
    const audio = (fsAssets.audioFiles || [])[0] || null;
    const links = getReleaseLinks(s.id);
    const marketingPack = scanMarketingPack(s.id);
    const marketingSummary = getSongCatalogMarketingSummary(s.id, { releaseLinks: links });
    const normalizedStatus = normalizeSongStatus(s.status);
    const previewImageUrl = marketingSummary.baseImage?.url || marketingSummary.socialImages[0]?.url || null;
    return {
      ...s,
      status: normalizedStatus,
      releaseSelection: getReleaseRecommendationSummary(s),
      progress: getChecklistProgress(s.id),
      previewImageUrl,
      hasAudio: audio !== null,
      durationSeconds: getSongDurationSeconds(metadata),
      durationLabel: formatDuration(getSongDurationSeconds(metadata)),
      wordCount: countLyricsWords(lyricsContent),
      description: summarizeSongDescription(s),
      releaseLinkCount: links.length,
      hasMarketingPack: marketingPack.status === 'built',
      hasLyrics: Boolean(fsAssets.lyrics),
      hasMetadata: Boolean(fsAssets.metadata),
      hasArtwork: Boolean(previewImageUrl),
      lastOutreachAt: s.last_outreach?.contacted_at || s.last_outreach?.updated_at || null,
      distrokidJob: distrokidJobsBySongId.get(s.id) || null,
    };
  });

  const { q, status, sort, brand, releaseRecommendation, releaseTreatment, analyzed, scoreMin, scoreMax } = req.query;
  const normalizedFilterStatus = status ? normalizeSongStatus(status) : '';
  const normalizedRecommendation = normalizeRecommendationFilter(releaseRecommendation);
  const normalizedTreatment = normalizeRecommendationFilter(releaseTreatment);
  const minScore = Number(scoreMin);
  const maxScore = Number(scoreMax);

  // Count totals BEFORE filtering for tab badges
  const totalCounts = {
    all: songs.length,
    draft: songs.filter(s => s.status === SONG_STATUSES.DRAFT).length,
    editing: songs.filter(s => s.status === SONG_STATUSES.EDITING).length,
    submitted: songs.filter(s => s.status === SONG_STATUSES.SUBMITTED_TO_DISTROKID).length,
    outreachComplete: songs.filter(s => s.status === SONG_STATUSES.OUTREACH_COMPLETE).length,
    archived: songs.filter(s => s.status === SONG_STATUSES.ARCHIVED).length,
  };

  if (q) {
    const lq = q.toLowerCase();
    songs = songs.filter(s =>
      (s.title || '').toLowerCase().includes(lq) ||
      (s.topic || '').toLowerCase().includes(lq) ||
      (s.concept || '').toLowerCase().includes(lq) ||
      (s.notes || '').toLowerCase().includes(lq)
    );
  }
  if (normalizedFilterStatus) songs = songs.filter(s => s.status === normalizedFilterStatus);
  if (brand) songs = songs.filter(s => s.brand_profile_id === brand);
  if (normalizedRecommendation) songs = songs.filter(s => s.releaseSelection.value === normalizedRecommendation);
  if (normalizedTreatment) songs = songs.filter(s => s.releaseSelection.treatment === normalizedTreatment);
  if (analyzed === 'yes') songs = songs.filter(s => s.releaseSelection.isAnalyzed);
  if (analyzed === 'no') songs = songs.filter(s => !s.releaseSelection.isAnalyzed);
  if (Number.isFinite(minScore)) songs = songs.filter(s => Number.isFinite(s.releaseSelection.score) && s.releaseSelection.score >= minScore);
  if (Number.isFinite(maxScore)) songs = songs.filter(s => Number.isFinite(s.releaseSelection.score) && s.releaseSelection.score <= maxScore);

  if (sort === 'readiness') songs.sort((a, b) => b.progress.pct - a.progress.pct);
  else if (sort === 'title') songs.sort((a, b) => String(a.title || a.topic || '').localeCompare(String(b.title || b.topic || '')));
  else if (sort === 'status') songs.sort((a, b) => songStatusSortOrder(a.status) - songStatusSortOrder(b.status) || new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  else if (sort === 'ar_score') songs.sort((a, b) => (b.releaseSelection.score || -1) - (a.releaseSelection.score || -1));
  else if (sort === 'ar_recommendation') songs.sort((a, b) => String(a.releaseSelection.value || 'zzz').localeCompare(String(b.releaseSelection.value || 'zzz')) || new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  else if (sort === 'created') songs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  else {
    songs.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  }

  const profiles = listBrandProfiles();
  const albums = getAllAlbums();
  res.render('songs/index', {
    songs,
    q: q || '',
    filterStatus: normalizedFilterStatus || '',
    filterBrand: brand || '',
    filterRecommendation: normalizedRecommendation || '',
    filterTreatment: normalizedTreatment || '',
    filterAnalyzed: analyzed || '',
    filterScoreMin: Number.isFinite(minScore) ? String(minScore) : '',
    filterScoreMax: Number.isFinite(maxScore) ? String(maxScore) : '',
    sort: sort || '',
    totalCounts,
    profiles,
    albums,
  });
});

app.get('/songs/:id', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).render('404', { message: 'Song not found' });

  const idea = song.originating_idea_id ? getIdea(song.originating_idea_id) : null;
  const assets = getAssetsForSong(song.id);
  const checklist = getPublishingChecklist(song.id);
  const progress = getChecklistProgress(song.id);
  const links = getReleaseLinks(song.id);
  const snapshots = getPerformanceSnapshots(song.id);

  const songDir = join(__dirname, '../../output/songs', song.id);
  const fsAssets = scanSongDir(songDir);

  const songBrand = resolveSongBrandProfile(song);

  // Read canonical song files first, then fall back to the legacy output scan.
  const lyricsFile = readSongDetailFile(song.lyrics_path, fsAssets.lyrics);
  const audioPromptFile = readSongDetailFile(song.audio_prompt_path, fsAssets.audioPrompt);
  const metadataFile = readSongDetailFile(song.metadata_path, fsAssets.metadata);
  const brandReviewFile = readSongDetailFile(null, fsAssets.brandReview);
  const lyricsContent = lyricsFile.content;
  const audioPromptContent = audioPromptFile.content;
  const metadataContent = metadataFile.content;
  const brandReviewContent = brandReviewFile.content;
  const metadataParsed   = metadataContent ? (() => { try { return JSON.parse(metadataContent); } catch { return null; } })() : null;
  const brandParsed      = brandReviewContent ? (() => { try { return JSON.parse(brandReviewContent); } catch { return null; } })() : null;

  const marketingPack = scanMarketingPack(song.id);
  const baseImage = scanSongBaseImage(song.id);
  const releaseAssetState = getReleaseAssetState('song', song.id);
  const releaseOutreachRows = buildReleaseOutreachRows(song.id);
  const marketingKit = getSongMarketingKit(song, { releaseLinks: links, marketingPack, baseImage });
  if (
    normalizeSongStatus(song.status) === SUBMITTED_STATUS
    && !hasGeneratedReleaseAssetPreviews(marketingKit.marketing_assets)
    && !marketingPack.dashboardUrl
  ) {
    try {
      queueSongReleaseAssetBuild(song.id, {
        trigger: 'song-detail-load',
        formats: DEFAULT_RELEASE_ASSET_FORMATS,
        renderVideos: false,
      });
    } catch {}
  }
  const releaseMarketing = getOrCreateReleaseMarketing(song.id);
  const distrokidJob = getDistroKidJob(song.id);
  const albumContext = song.album_id ? getAlbum(song.album_id) : null;
  const requestedTab = String(req.query.tab || '').toLowerCase();
  const releaseSelectionSummary = getReleaseRecommendationSummary(song);
  const initialTab = resolveSongDetailInitialTab({
    requestedTab,
    song,
    lyricsContent,
    audioPromptContent,
    metadataParsed,
  });

  res.render('songs/detail', {
    song, idea, assets, checklist, progress, links, snapshots, fsAssets,
    lyricsSourcePath: lyricsFile.path,
    audioPromptSourcePath: audioPromptFile.path,
    metadataSourcePath: metadataFile.path,
    lyricsContent, audioPromptContent, metadataParsed, brandParsed,
    marketingPack, baseImage, releaseAssetState, releaseOutreachRows, marketingKit, releaseMarketing,
    songBrandProfile: songBrand.profile,
    songBrandProfileId: songBrand.id,
    songBrandLabel: songBrand.label,
    brandProfile: songBrand.profile,
    brandName: songBrand.profile.brand_name,
    appTitle: songBrand.profile.app_title || songBrand.profile.brand_name,
    logoPath: songBrand.profile.ui?.logo_path || '/logo.png',
    sidebarSubtitle: songBrand.profile.ui?.sidebar_subtitle || 'Music Studio',
    defaultDistributor: songBrand.profile.distribution?.default_distributor || DEFAULT_DISTRIBUTOR,
    distributorUrl: songBrand.profile.distribution?.research_default_url || DISTRIBUTOR_URL,
    albumContext,
    distrokidJob,
    distrokidRecentLog: summarizeDistroKidRunLog(song.id),
    releaseSelectionSummary,
    nextAction: getSongNextAction(song, marketingKit),
    initialTab,
    showDebugDiagnostics: req.query.debug === '1' || process.env.NODE_ENV !== 'production',
  });
});

app.get('/songs/:id/edit', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).render('404', { message: 'Song not found' });
  res.render('songs/edit', { song, error: null });
});

app.post('/songs/:id', (req, res) => {
  const { title, status, concept, target_age_range, notes, release_date, genre_tags, mood_tags } = req.body;
  upsertSong({
    id: req.params.id,
    title: title?.trim() || undefined,
    status: status || undefined,
    concept: concept?.trim() || undefined,
    target_age_range: target_age_range || undefined,
    notes: notes?.trim() || undefined,
    release_date: release_date || undefined,
    genre_tags: genre_tags ? genre_tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
    mood_tags: mood_tags ? mood_tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
  });
  res.redirect(`/songs/${req.params.id}`);
});

app.post('/songs/:id/marketing-kit', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).render('404', { message: 'Song not found' });

  const marketing_links = Object.fromEntries(MARKETING_LINK_FIELDS.map(field => [field, req.body[field] || '']));
  const marketing_assets = Object.fromEntries(
    MARKETING_ASSET_FIELDS
      .filter(field => Object.prototype.hasOwnProperty.call(req.body, field))
      .map(field => [field, req.body[field] || ''])
  );
  if (Object.prototype.hasOwnProperty.call(req.body, 'release_kit_published')) {
    marketing_assets.release_kit_published = req.body.release_kit_published === 'on';
  }

  const marketing_inputs_from_ar = {
    ...(song.marketing_inputs_from_ar || {}),
  };
  if (Object.prototype.hasOwnProperty.call(req.body, 'use_in_daily_social_push')) {
    marketing_inputs_from_ar.use_in_daily_social_push = req.body.use_in_daily_social_push === 'on';
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'prioritize_next_daily_campaign')) {
    marketing_inputs_from_ar.prioritize_next_daily_campaign = req.body.prioritize_next_daily_campaign === 'on';
  }

  const saved = saveSongMarketingKit(song.id, { marketing_links, marketing_assets });
  upsertSong({ id: song.id, marketing_inputs_from_ar });
  syncReleaseLinksFromMarketingKit(song.id, saved.marketing_links);
  res.redirect(`/songs/${song.id}?message=${encodeURIComponent('Marketing kit saved.')}`);
});

app.get('/release-kit/:id', (req, res) => {
  const viewModel = buildReleaseKitViewModel(req.params.id);
  if (!viewModel) return res.status(404).render('404', { message: 'Release kit not found' });
  const preview = req.query.preview === '1';
  res.render('release-kit', { releaseKit: viewModel, preview });
});

app.post('/api/songs/:id/thumbnails', async (_req, res) => {
  res.status(410).json({ error: 'Thumbnail generation has been retired. Use the base image and release asset builder instead.' });
});

app.get('/api/songs/:id/thumbnails', async (_req, res) => {
  res.status(410).json({ error: 'Thumbnail generation has been retired. Use the base image and release asset builder instead.' });
});

// ── SONG REVISION ──────────────────────────────────────────────
const reviseJobs = new Map(); // jobId → { status, logs, error }

app.post('/api/songs/:id/revise', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  const { feedback } = req.body;
  if (!feedback?.trim()) return res.status(400).json({ error: 'feedback is required' });

  const jobId = `revise_${song.id}_${Date.now()}`;
  reviseJobs.set(jobId, { status: 'running', logs: [] });

  const feedbackB64 = Buffer.from(feedback.trim()).toString('base64');
  const scriptPath = join(__dirname, '../scripts/revise-song.js');
  const child = spawn('node', [scriptPath, song.id, feedbackB64], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const job = reviseJobs.get(jobId);
  const stripAnsi = (s) => s.replace(/\x1B\[[0-9;]*[mGKHFABCDEFsuhl]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '').trim();

  let buf = '';
  const handleLine = (line) => { const c = stripAnsi(line); if (c) job.logs.push(c); };
  const onData = (d) => { buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handleLine); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    if (buf) handleLine(buf);
    job.status = code === 0 ? 'done' : 'error';
    if (code !== 0) job.error = `Process exited with code ${code}`;
  });

  res.json({ ok: true, jobId });
});

app.get('/api/songs/revise/stream/:jobId', (req, res) => {
  const job = reviseJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let cursor = 0;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const tick = () => {
    while (cursor < job.logs.length) send('log', { message: job.logs[cursor++] });
    if (job.status === 'done') { send('complete', {}); return res.end(); }
    if (job.status === 'error') { send('error', { message: job.error || 'Revision failed' }); return res.end(); }
    setTimeout(tick, 300);
  };
  tick();
});

app.get('/api/songs/thumbnails/stream/:jobId', (_req, res) => {
  res.status(410).json({ error: 'Thumbnail generation has been retired.' });
});

// ── BASE IMAGE (Phase 4) ────────────────────────────────────────────────────

// Upload base image
app.post('/api/songs/:id/base-image', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (song.album_id) return res.status(409).json({ ok: false, error: 'This song inherits release assets from its album. Edit album assets instead.' });

  baseImageUpload.single('base_image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No valid image file provided (png/jpg/jpeg/webp)' });
    saveSongMarketingKit(req.params.id, { marketing_assets: { base_image_url: scanSongBaseImage(req.params.id)?.url || '' } });
    markReleaseAssetsStale('song', req.params.id);
    res.json(getSongReleaseAssetState(req.params.id));
  });
});

app.post('/api/songs/:id/release-assets/generate-image', async (req, res) => {
  try {
    const result = await generatePrimaryImageWithOpenAI('song', req.params.id, {
      entityType: 'single',
      entityId: req.params.id,
      brandProfileId: req.body?.brandProfileId || getActiveProfileId(),
      title: req.body?.title,
      artist: req.body?.artist,
      prompt: req.body?.prompt,
      styleGuardrails: req.body?.styleGuardrails,
      outputKind: req.body?.outputKind || 'cover',
    });
    res.status(result.ok === false ? 503 : 200).json(result);
  } catch (error) {
    res.status(error.message.startsWith('Song not found:') ? 404 : 500).json({ ok: false, error: error.message });
  }
});

app.post('/api/songs/:id/release-assets/select-default-image', (req, res) => {
  try {
    res.json(selectSongPrimaryImage(req.params.id, null, {
      useDefaultBaseImage: true,
      generationSource: 'default_base_image_pool',
    }));
  } catch (error) {
    res.status(error.message.startsWith('Song not found:') ? 404 : 400).json({ ok: false, error: error.message });
  }
});

app.post('/api/songs/:id/base-image/clear', (req, res) => {
  try {
    res.json(clearSongBaseImage(req.params.id));
  } catch (error) {
    res.status(error.message.startsWith('Song not found:') ? 404 : 500).json({ ok: false, error: error.message });
  }
});

app.delete('/api/songs/:id/base-image', (req, res) => {
  try {
    res.json(clearSongBaseImage(req.params.id));
  } catch (error) {
    res.status(error.message.startsWith('Song not found:') ? 404 : 500).json({ ok: false, error: error.message });
  }
});

// ── SOCIAL ASSET PACK (Phase 6) ─────────────────────────────────────────────

const socialPackJobs = new Map(); // jobId → { status, logs, error, outputDir, dashboardUrl, songId, manifest, result }
const activeSocialPackJobsBySongId = new Map();

function queueSongReleaseAssetBuild(songId, options = {}) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);

  const existingJobId = activeSocialPackJobsBySongId.get(song.id);
  const existingJob = existingJobId ? socialPackJobs.get(existingJobId) : null;
  if (existingJob && existingJob.status === 'running') {
    return { jobId: existingJobId, existing: true, job: existingJob };
  }

  const jobId = `pack_${song.id}_${Date.now().toString(36)}`;
  const trigger = options.trigger || 'manual';
  const job = {
    status: 'running',
    logs: [`Starting release asset build (${trigger}).`],
    error: null,
    outputDir: null,
    dashboardUrl: null,
    songId: song.id,
    manifest: null,
    result: null,
  };
  socialPackJobs.set(jobId, job);
  activeSocialPackJobsBySongId.set(song.id, jobId);

  (async () => {
    try {
      const result = await buildSongReleaseAssets(song.id, {
        mode: options.mode || 'render_from_existing_visuals',
        provider: options.provider || null,
        imageProvider: options.provider || null,
        formats: Array.isArray(options.formats) && options.formats.length ? options.formats : DEFAULT_RELEASE_ASSET_FORMATS,
        useBaseImage: options.useBaseImage !== false,
        regenerateBaseArt: options.regenerateBaseArt === true,
        renderVideos: options.renderVideos === true ? true : false,
        requireApprovalBeforeVideo: options.requireApprovalBeforeVideo === true,
      });
      job.result = result;
      job.status = 'done';
      if (result.qaWarnings?.length) {
        for (const warning of result.qaWarnings) job.logs.push(`WARN: ${warning}`);
      }
      if (result.qaFailures?.length) {
        for (const failure of result.qaFailures) job.logs.push(`QA: ${failure}`);
      }
      job.logs.push(result.qaFailures?.length ? 'Release assets generated with QA review required.' : 'Release assets generated.');
      const packInfo = scanMarketingPack(song.id);
      job.dashboardUrl = packInfo.dashboardUrl;
      job.manifest = packInfo.manifest || null;
      job.outputDir = packInfo.exists ? join(__dirname, '../../output/marketing-ready', song.id) : null;
    } catch (error) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      job.logs.push(`ERROR: ${job.error}`);
    } finally {
      if (activeSocialPackJobsBySongId.get(song.id) === jobId) activeSocialPackJobsBySongId.delete(song.id);
    }
  })();

  return { jobId, existing: false, job };
}

app.post('/api/songs/:id/social-assets', (req, res) => {
  try {
    const { jobId, existing } = queueSongReleaseAssetBuild(req.params.id, {
      trigger: 'legacy-ui',
      mode: req.body?.mode || 'render_from_existing_visuals',
      provider: req.body?.provider || null,
      formats: Array.isArray(req.body?.formats) ? req.body.formats : String(req.body?.formats || '').split(',').map(item => item.trim()).filter(Boolean),
      useBaseImage: booleanFromRequest(req.body?.useBaseImage, true),
      regenerateBaseArt: booleanFromRequest(req.body?.regenerateBaseArt, false),
      renderVideos: booleanFromRequest(req.body?.renderVideos, false),
      requireApprovalBeforeVideo: booleanFromRequest(req.body?.requireApprovalBeforeVideo, false),
    });
    if (existing) {
      return res.status(409).json({ error: 'Release asset regeneration is already running for this song.', jobId });
    }
    res.json({ ok: true, jobId });
  } catch (error) {
    res.status(error.message.startsWith('Song not found:') ? 404 : 500).json({ ok: false, error: error.message });
  }
});

app.get('/api/songs/:id/release-assets', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ ok: false, error: 'Song not found' });
  const canonicalState = getReleaseAssetState('song', song.id);
  const marketingPack = scanMarketingPack(song.id);
  const marketingKit = getSongMarketingKit(song.id, { marketingPack });
  const summary = getSongCatalogMarketingSummary(song.id);
  res.json({
    ok: true,
    releaseAssets: canonicalState,
    manifest: marketingPack.manifest,
    dashboardUrl: marketingPack.dashboardUrl,
    marketingKit,
    summary,
  });
});

app.get('/api/songs/:id/release-assets/state', (req, res) => {
  try {
    res.json(getSongReleaseAssetState(req.params.id));
  } catch (error) {
    res.status(error.message.startsWith('Song not found:') ? 404 : 500).json({ ok: false, error: error.message });
  }
});

app.get('/api/songs/:id/release-assets/preview', async (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ ok: false, error: 'Song not found' });
  try {
    const state = await ensureReleaseAssetDerivatives('song', song.id);
    res.redirect(state.dashboardUrl);
  } catch (error) {
    res.status(/primary image/i.test(error.message) ? 400 : 500).json({ ok: false, error: error.message });
  }
});

app.get('/api/songs/:id/release-assets/download', async (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ ok: false, error: 'Song not found' });
  try {
    const state = await ensureReleaseAssetDerivatives('song', song.id);
    const ownerId = state.owner.id;
    const dir = state.owner.type === 'album'
      ? join(__dirname, '../../output/albums', ownerId, 'assets')
      : join(__dirname, '../../output/marketing-ready', ownerId);
    const prefix = state.owner.type === 'album' ? `album-${ownerId}` : `song-${ownerId}`;
    sendAssetPackZip(res, dir, `${prefix}-release-assets.zip`);
  } catch (error) {
    res.status(/primary image/i.test(error.message) ? 400 : 500).json({ ok: false, error: error.message });
  }
});

app.post('/api/songs/:id/release-assets/build', async (req, res) => {
  const formats = Array.isArray(req.body?.formats) ? req.body.formats : [];
  try {
    const result = await buildSongReleaseAssets(req.params.id, {
      mode: req.body?.mode || 'render_from_existing_visuals',
      provider: req.body?.provider || null,
      imageProvider: req.body?.provider || null,
      formats,
      useBaseImage: booleanFromRequest(req.body?.useBaseImage, true),
      regenerateBaseArt: booleanFromRequest(req.body?.regenerateBaseArt, false),
      renderVideos: booleanFromRequest(req.body?.renderVideos, true),
      requireApprovalBeforeVideo: booleanFromRequest(req.body?.requireApprovalBeforeVideo, false),
    });
    res.status(result.qaFailures.length ? 202 : 200).json(result);
  } catch (error) {
    res.status(error.message.startsWith('Song not found:') ? 404 : 500).json({ ok: false, error: error.message });
  }
});

app.post('/api/songs/:id/marketing-assets/approve', express.json(), (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ ok: false, error: 'Song not found' });
  const assetKey = String(req.body.assetKey || '').trim();
  if (!assetKey) return res.status(400).json({ ok: false, error: 'assetKey is required' });
  const kit = getSongMarketingKit(song.id);
  const approvals = { ...(kit.marketing_assets.asset_approvals || {}), [assetKey]: req.body.approved !== false };
  const saved = saveSongMarketingKit(song.id, { marketing_assets: { asset_approvals: approvals } });
  res.json({ ok: true, approvals: saved.marketing_assets.asset_approvals });
});

app.get('/api/songs', (req, res) => {
  const normalizedRecommendation = normalizeRecommendationFilter(req.query.releaseRecommendation);
  const normalizedTreatment = normalizeRecommendationFilter(req.query.releaseTreatment);
  let songs = getAllSongs();
  if (normalizedRecommendation) songs = songs.filter(song => song.release_recommendation?.value === normalizedRecommendation);
  if (normalizedTreatment) songs = songs.filter(song => song.release_recommendation?.recommended_release_treatment === normalizedTreatment);
  res.json({
    ok: true,
    songs: songs.map(song => ({
      id: song.id,
      title: song.title,
      status: song.status,
      pipeline_stage: song.pipeline_stage || null,
      release_recommendation: song.release_recommendation || null,
      marketing_inputs_from_ar: song.marketing_inputs_from_ar || null,
    })),
  });
});

app.post('/api/songs/:id/release-selection/analyze', async (req, res) => {
  try {
    const result = await analyzeSongForReleaseSelection(req.params.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error.message === 'Song not found' ? 404 : 500).json({ ok: false, error: error.message });
  }
});

app.post('/api/batches/:batchId/release-selection/analyze', async (req, res) => {
  try {
    const result = await analyzeRecentDraftSongsForReleaseSelection({
      songIds: Array.isArray(req.body?.songIds) ? req.body.songIds : null,
      limit: Number(req.body?.limit) || 10,
    });
    res.json({ ok: true, batchId: req.params.batchId, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/songs/:id/release-selection/approve', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ ok: false, error: 'Song not found' });
  const action = String(req.body?.action || '').trim().toLowerCase();
  const recommendation = song.release_recommendation || null;
  if (!recommendation) return res.status(400).json({ ok: false, error: 'Song has not been analyzed yet.' });

  if (action === 'publish') {
    upsertSong({ id: song.id, status: SONG_STATUSES.DRAFT, pipeline_stage: PIPELINE_STAGES.APPROVED_FOR_RELEASE_PACKAGING });
  } else if (action === 'edit') {
    upsertSong({ id: song.id, status: SONG_STATUSES.EDITING, pipeline_stage: 'editing_requested_from_release_selection' });
  } else if (action === 'hold') {
    upsertSong({ id: song.id, status: SONG_STATUSES.DRAFT, pipeline_stage: PIPELINE_STAGES.HELD_AFTER_RELEASE_SELECTION });
  } else if (action === 'archive') {
    upsertSong({ id: song.id, status: SONG_STATUSES.ARCHIVED, pipeline_stage: 'archived_after_release_selection' });
  } else if (action === 'review_issues') {
    upsertSong({ id: song.id, status: SONG_STATUSES.DRAFT, pipeline_stage: PIPELINE_STAGES.MANUAL_REVIEW_REQUIRED });
  } else {
    return res.status(400).json({ ok: false, error: 'Invalid action' });
  }

  res.json({ ok: true, song: getSong(song.id) });
});

app.post('/api/songs/:id/release-selection/override', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ ok: false, error: 'Song not found' });
  const value = normalizeRecommendationFilter(req.body?.value);
  const treatment = normalizeRecommendationFilter(req.body?.recommended_release_treatment);
  if (!value) return res.status(400).json({ ok: false, error: 'value is required' });
  const existing = song.release_recommendation || {};
  const updatedAt = new Date().toISOString();
  const recommendation = {
    ...existing,
    value,
    recommended_release_treatment: treatment || existing.recommended_release_treatment || null,
    updated_at: updatedAt,
    override_reason: String(req.body?.reason || '').trim() || null,
    overridden_by_operator: true,
  };
  const history = Array.isArray(song.release_recommendation_history) ? song.release_recommendation_history : [];
  history.push({
    updated_at: updatedAt,
    value: recommendation.value,
    recommended_release_treatment: recommendation.recommended_release_treatment,
    override_reason: recommendation.override_reason,
    operator_override: true,
  });
  upsertSong({
    id: song.id,
    release_recommendation: recommendation,
    release_recommendation_history: history.slice(-20),
  });
  res.json({ ok: true, song: getSong(song.id) });
});

app.get('/api/songs/social-assets/stream/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let cursor = 0;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const tick = () => {
    const job = socialPackJobs.get(req.params.jobId);
    if (!job) { send('failed', { message: 'Job not found' }); return res.end(); }
    while (cursor < job.logs.length) send('log', { message: job.logs[cursor++] });
    if (job.status === 'done') {
      send('complete', {
        dashboardUrl: job.dashboardUrl,
        generatedAt: job.manifest?.generatedAt || job.manifest?.generated_at || null,
        manifest: job.manifest,
      });
      return res.end();
    }
    if (job.status === 'error') { send('failed', { message: job.error || 'Release asset regeneration failed.' }); return res.end(); }
    setTimeout(tick, 400);
  };
  tick();
});

// API: update checklist item
app.post('/api/songs/:id/checklist/:key', (req, res) => {
  const { status, note } = req.body;
  const allowed = ['not_started', 'in_progress', 'done', 'blocked'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  updateChecklistItem(req.params.id, req.params.key, { status, note });
  const progress = getChecklistProgress(req.params.id);
  res.json({ ok: true, progress });
});

// API: update song status
app.post('/api/songs/:id/status', (req, res) => {
  const { status } = req.body;
  if (!SONG_STATUS_OPTIONS.some(option => option.value === status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  updateSongStatus(req.params.id, status);
  const normalizedStatus = normalizeSongStatus(status);
  let releaseAssetsBuild = null;
  if (normalizedStatus === SUBMITTED_STATUS) {
    const queued = queueSongReleaseAssetBuild(req.params.id, {
      trigger: 'status-update',
      formats: DEFAULT_RELEASE_ASSET_FORMATS,
      renderVideos: false,
    });
    releaseAssetsBuild = { started: !queued.existing, jobId: queued.jobId, existing: queued.existing };
  }
  res.json({ ok: true, releaseAssetsBuild });
});

// API: add release link
app.delete('/api/songs/:id', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  // Delete DB record (cascades to checklist, assets, links, snapshots)
  deleteSong(req.params.id);

  // Delete files on disk
  const songDir = join(__dirname, '../../output/songs', req.params.id);
  try {
    if (fs.existsSync(songDir)) fs.rmSync(songDir, { recursive: true, force: true });
  } catch (err) {
    // Non-fatal — DB is already cleaned up
    console.warn(`[SERVER] Could not delete song dir ${songDir}: ${err.message}`);
  }

  res.json({ ok: true });
});

app.post('/api/songs/:id/approve', (req, res) => {
  res.status(410).json({ error: 'Status approval endpoint removed. Use a canonical song status instead.' });
});

// Mark as submitted to the active profile distributor (with optional link)
app.post('/api/songs/:id/publish', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  const { url } = req.body;
  updateSongStatus(req.params.id, SUBMITTED_STATUS);
  upsertSong({
    id: req.params.id,
    distributor: song.distributor || DEFAULT_DISTRIBUTOR,
    distributor_submission_date: new Date().toISOString().slice(0, 10),
  });
  if (url) upsertReleaseLink(req.params.id, DEFAULT_DISTRIBUTOR, url);
  const queued = queueSongReleaseAssetBuild(req.params.id, {
    trigger: 'publish',
    formats: DEFAULT_RELEASE_ASSET_FORMATS,
    renderVideos: false,
  });
  res.json({ ok: true, releaseAssetsBuild: { started: !queued.existing, jobId: queued.jobId, existing: queued.existing } });
});

// DistroKid completion callback — called after human finalizes submission
// Payload: { song_id?, distrokid_url, status?, submitted_at?, notes? }
app.post('/api/distrokid/releases/:songId/complete', (req, res) => {
  const { songId } = req.params;
  try {
    if (req.body?.song_id && req.body.song_id !== songId) {
      return res.status(400).json({ error: 'song_id payload does not match route songId' });
    }
    if (req.body?.status && req.body.status !== 'submitted') {
      return res.status(400).json({ error: 'status must be submitted' });
    }
    const result = markSongSubmittedToDistroKid(songId, req.body || {});
    res.json({ ok: true, result });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

function distrokidSongIdsFromBody(body = {}) {
  const raw = Array.isArray(body.songIds)
    ? body.songIds
    : Array.isArray(body.ids)
      ? body.ids
      : [body.song_id || body.songId].filter(Boolean);
  return [...new Set(raw.map(id => String(id || '').trim()).filter(Boolean))];
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function distrokidCommands(songId) {
  const manifestPath = `output/release-packages/${songId}/manifest.json`;
  return {
    save_auth: './bin/pancakerobot distrokid:save-auth',
    check_auth: './bin/pancakerobot distrokid:check-auth',
    build_package: `./bin/pancakerobot distrokid:package --song-id ${songId}`,
    upload_dry_run: `./bin/pancakerobot distrokid:upload --manifest ${manifestPath} --dry-run`,
    run_queued: './bin/pancakerobot distrokid:run-queued --limit 5 --dry-run',
    mark_submitted: `./bin/pancakerobot distrokid:mark-submitted --song-id ${songId} --distrokid-url "URL_FROM_DISTROKID"`,
  };
}

function distrokidJobPayload(songId) {
  const manifestPath = join(__dirname, '../../output/release-packages', songId, 'manifest.json');
  const missingPath = join(__dirname, '../../output/release-packages', songId, 'missing-fields.json');
  const manifest = readJsonIfExists(manifestPath);
  const missing = readJsonIfExists(missingPath);
  const job = getDistroKidJob(songId) || {
    song_id: songId,
    status: DISTROKID_JOB_STATUSES.NOT_QUEUED,
    package_path: null,
    latest_run_log_path: null,
    latest_error: null,
    distrokid_url: null,
    attempt_count: 0,
  };
  const blocking = manifest?.readiness?.blocking_missing_fields
    || missing?.blocking_missing_fields
    || job.latest_error?.blocking_missing_fields
    || job.latest_error?.errors?.map(item => item.field).filter(Boolean)
    || [];
  return {
    job,
    readiness: {
      ready_for_distrokid_dry_run: Boolean(manifest?.readiness?.ready_for_distrokid_dry_run),
      blocking_missing_fields: blocking,
      summary: manifest
        ? (manifest.readiness?.ready_for_distrokid_dry_run ? 'Ready for DistroKid dry-run upload' : 'Blocked until required package fields are present')
        : 'Package has not been built yet',
      manifest_path: manifest ? `output/release-packages/${songId}/manifest.json` : null,
      missing_fields_path: missing ? `output/release-packages/${songId}/missing-fields.json` : null,
    },
    package: {
      path: job.package_path || (manifest ? `output/release-packages/${songId}` : null),
      manifest_path: manifest ? `output/release-packages/${songId}/manifest.json` : `output/release-packages/${songId}/manifest.json`,
    },
    commands: distrokidCommands(songId),
    recent_log_summary: summarizeDistroKidRunLog(songId),
  };
}

function summarizeDistroKidRunLog(songId) {
  const runLogPath = join(__dirname, '../../output/release-packages', songId, 'distrokid-run', 'run-log.json');
  const log = readJsonIfExists(runLogPath);
  if (!log) return [];
  return [
    `Started: ${log.started_at || 'unknown'}`,
    `Finished: ${log.finished_at || 'unknown'}`,
    `Filled ${log.filled_count || 0}; skipped ${log.skipped_count || 0}; errors ${log.error_count || 0}`,
    log.stopped_before_submit === false ? 'Final submit was attempted' : 'Stopped before final submit',
  ];
}

app.post('/api/distrokid/jobs/queue', (req, res) => {
  try {
    const ids = distrokidSongIdsFromBody(req.body);
    if (!ids.length) return res.status(400).json({ ok: false, message: 'No song IDs provided.', job: null, jobs: [], errors: ['songIds[] required'] });
    const jobs = ids.map(id => queueSongForDistroKid(String(id).trim()));
    res.json({ ok: true, message: `Queued ${jobs.length} song${jobs.length === 1 ? '' : 's'} for DistroKid.`, job: jobs[0] || null, jobs, errors: [] });
  } catch (error) {
    res.status(/not found|refusing/i.test(error.message) ? 400 : 500).json({ ok: false, message: 'DistroKid queue failed.', job: null, jobs: [], errors: [error.message], error: error.message });
  }
});

app.post('/api/distrokid/jobs/clear', (req, res) => {
  try {
    const ids = distrokidSongIdsFromBody(req.body);
    if (!ids.length) return res.status(400).json({ ok: false, message: 'No song IDs provided.', job: null, jobs: [], errors: ['songIds[] required'] });
    const jobs = ids.map(id => clearDistroKidQueue(String(id).trim(), req.body?.notes || null));
    res.json({ ok: true, message: `Cleared DistroKid queue for ${jobs.length} song${jobs.length === 1 ? '' : 's'}.`, job: jobs[0] || null, jobs, errors: [] });
  } catch (error) {
    res.status(/not found/i.test(error.message) ? 404 : 500).json({ ok: false, message: 'DistroKid queue clear failed.', job: null, jobs: [], errors: [error.message], error: error.message });
  }
});

app.get('/api/distrokid/jobs/:songId', (req, res) => {
  try {
    if (!getSong(req.params.songId)) {
      return res.status(404).json({ ok: false, message: 'Song not found.', job: null, errors: [`Song not found: ${req.params.songId}`] });
    }
    const payload = distrokidJobPayload(req.params.songId);
    res.json({ ok: true, message: 'DistroKid job loaded.', errors: [], ...payload });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'DistroKid job load failed.', job: null, errors: [error.message], error: error.message });
  }
});

app.post('/api/distrokid/jobs/:songId/package', (req, res) => {
  try {
    if (!getSong(req.params.songId)) {
      return res.status(404).json({ ok: false, message: 'Song not found.', job: null, errors: [`Song not found: ${req.params.songId}`] });
    }
    const payload = distrokidJobPayload(req.params.songId);
    res.json({
      ok: true,
      message: 'Package building is CLI-only from the web UI. Run the build package command below.',
      errors: [],
      safe_to_run_from_web: false,
      ...payload,
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'DistroKid package command lookup failed.', job: null, errors: [error.message], error: error.message });
  }
});

app.post('/api/distrokid/jobs/:songId/automation-preview', async (req, res) => {
  try {
    const result = await runDistroKidSongAutomation(req.params.songId, { mode: 'preview' });
    res.json({ ok: true, message: 'Automation preview finished.', result, ...distrokidJobPayload(req.params.songId), errors: [] });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    res.status(status).json({ ok: false, message: 'Automation preview failed.', errors: [error.message], error: error.message, ...distrokidJobPayload(req.params.songId) });
  }
});

app.post('/api/distrokid/jobs/:songId/live-submit', async (req, res) => {
  try {
    const result = await runDistroKidSongAutomation(req.params.songId, { mode: 'live', confirm: req.body?.confirm === true });
    res.json({ ok: true, message: 'Live submit finished.', result, ...distrokidJobPayload(req.params.songId), errors: [] });
  } catch (error) {
    const status = /not found|confirmation/i.test(error.message) ? 400 : 500;
    res.status(status).json({ ok: false, message: 'Live submit failed.', errors: [error.message], error: error.message, ...distrokidJobPayload(req.params.songId) });
  }
});

app.post('/api/distrokid/jobs/:songId/hyperfollow', async (req, res) => {
  try {
    const hyperfollow = await captureHyperFollowLink(req.params.songId, { hyperfollowUrl: req.body?.hyperfollow_url || req.body?.url });
    res.json({ ok: true, message: hyperfollow.url ? 'HyperFollow link saved.' : 'HyperFollow link is not available yet.', hyperfollow, ...distrokidJobPayload(req.params.songId), errors: [] });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    res.status(status).json({ ok: false, message: 'HyperFollow capture failed.', errors: [error.message], error: error.message });
  }
});

app.post('/api/distrokid/albums/:albumId/automation-preview', async (req, res) => {
  try {
    const result = await runDistroKidAlbumAutomation(req.params.albumId, { mode: 'preview' });
    res.json({ ok: true, message: 'Album automation preview finished.', result, errors: [] });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    res.status(status).json({ ok: false, message: 'Album automation preview failed.', errors: [error.message], error: error.message });
  }
});

app.post('/api/distrokid/albums/:albumId/live-submit', async (req, res) => {
  try {
    const result = await runDistroKidAlbumAutomation(req.params.albumId, { mode: 'live', confirm: req.body?.confirm === true });
    res.json({ ok: true, message: 'Album live submit finished.', result, errors: [] });
  } catch (error) {
    const status = /not found|confirmation/i.test(error.message) ? 400 : 500;
    res.status(status).json({ ok: false, message: 'Album live submit failed.', errors: [error.message], error: error.message });
  }
});

app.post('/api/distrokid/albums/:albumId/hyperfollow', async (req, res) => {
  try {
    const tracks = getSongsForAlbum(req.params.albumId);
    if (!tracks.length) return res.status(400).json({ ok: false, message: 'Album has no tracks.', errors: ['Album has no tracks.'] });
    const results = [];
    for (const track of tracks) {
      results.push(await captureHyperFollowLink(track.id, { hyperfollowUrl: req.body?.hyperfollow_url || req.body?.url }));
    }
    const hyperfollow = results.find(result => result.url) || results[0] || { status: 'submitted_pending_hyperfollow', url: null };
    res.json({ ok: true, message: hyperfollow.url ? 'HyperFollow link saved for album tracks.' : 'HyperFollow link is not available yet.', hyperfollow, errors: [] });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    res.status(status).json({ ok: false, message: 'Album HyperFollow capture failed.', errors: [error.message], error: error.message });
  }
});

app.post('/api/distrokid/jobs/:songId/mark-submitted', (req, res) => {
  try {
    const distrokidUrl = String(req.body?.distrokid_url || req.body?.distrokidUrl || req.body?.url || '').trim();
    if (!distrokidUrl) {
      return res.status(400).json({ ok: false, message: 'DistroKid URL is required.', job: null, errors: ['distrokid_url required'] });
    }
    const result = markSongSubmittedToDistroKid(req.params.songId, {
      distrokid_url: distrokidUrl,
      notes: req.body?.notes || '',
    });
    res.json({ ok: true, message: 'Song marked submitted to DistroKid.', job: getDistroKidJob(req.params.songId), result, errors: [] });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 500;
    res.status(status).json({ ok: false, message: 'Mark submitted failed.', job: null, errors: [error.message], error: error.message });
  }
});

// Bulk status update — must be before /:id routes
app.post('/api/songs/bulk-status', (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !status) return res.status(400).json({ error: 'ids[] and status required' });
  if (!SONG_STATUS_OPTIONS.some(option => option.value === status)) return res.status(400).json({ error: 'Invalid status' });
  let updated = 0;
  for (const id of ids) {
    try {
      updateSongStatus(id, status);
      if (normalizeSongStatus(status) === SUBMITTED_STATUS) {
        queueSongReleaseAssetBuild(id, {
          trigger: 'bulk-status-update',
          formats: DEFAULT_RELEASE_ASSET_FORMATS,
          renderVideos: false,
        });
      }
      updated++;
    } catch {
      /* skip unknown ids */
    }
  }
  res.json({ ok: true, updated });
});

app.post('/api/songs/:id/links', (req, res) => {
  const { platform, url } = req.body;
  if (!platform || !url) return res.status(400).json({ error: 'platform and url required' });
  upsertReleaseLink(req.params.id, platform, url);
  res.json({ ok: true });
});

// ── BRAND EDITOR ───────────────────────────────────────────────
app.get('/brand', (req, res) => {
  const activeForGenerationId = getActiveProfileId();
  const activeProfileId = req.query.profile ? normalizeProfileId(req.query.profile) : activeForGenerationId;
  const profiles = listBrandProfiles();
  const profile = loadBrandProfileById(activeProfileId);

  res.render('brand/edit', {
    profileJson: JSON.stringify(profile, null, 2),
    profiles,
    activeProfileId,
    activeForGenerationId,
  });
});

app.post('/api/brand', express.json(), (req, res) => {
  try {
    const profileId = normalizeProfileId(req.body.profileId);
    const profile = JSON.parse(req.body.profileJson);
    saveBrandProfileById(profileId, profile);
    res.json({ ok: true, profileId });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/brand/activate', express.json(), (req, res) => {
  try {
    const profileId = normalizeProfileId(req.body.profileId);
    setActiveProfileId(profileId);
    res.json({ ok: true, profileId });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

function normalizeProfileId(value) {
  const raw = String(value || '').trim();
  return raw || DEFAULT_PROFILE_ID;
}

function resolveSongBrandProfile(song) {
  const requestedId = normalizeProfileId(song?.brand_profile_id || getActiveProfileId());
  try {
    const profile = loadBrandProfileById(requestedId);
    return {
      id: requestedId,
      profile,
      label: profile.brand_name || requestedId,
    };
  } catch (error) {
    const fallbackId = getActiveProfileId();
    try {
      const profile = loadBrandProfileById(fallbackId);
      return {
        id: fallbackId,
        profile,
        label: `${profile.brand_name || fallbackId} (fallback for missing ${requestedId})`,
      };
    } catch {
      return {
        id: DEFAULT_PROFILE_ID,
        profile: BRAND_PROFILE,
        label: BRAND_NAME,
      };
    }
  }
}

// ── 404 ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('404', { message: `Page not found: ${req.path}` });
});

// ── HELPERS ────────────────────────────────────────────────────
const OUTPUT_DIR = join(__dirname, '../../output');
function toWebUrl(absPath) {
  return '/media/' + absPath.replace(OUTPUT_DIR, '').replace(/\\/g, '/').replace(/^\//, '');
}

function normalizeSongIdList(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  return [...new Set(raw.map(id => String(id || '').trim()).filter(Boolean))];
}

function validateAlbumTrackAssignment(songIds, { targetAlbumId = null } = {}) {
  const warnings = [];
  const songs = songIds.map(id => getSong(id)).filter(Boolean);
  if (songs.length !== songIds.length) warnings.push('One or more selected songs were not found');

  const brands = new Set(songs.map(song => song.brand_profile_id || '').filter(Boolean));
  if (brands.size > 1) warnings.push('Selected songs use mixed brand profiles');

  const assigned = songs.filter(song => song.album_id && song.album_id !== targetAlbumId);
  if (assigned.length) warnings.push(`${assigned.length} selected song${assigned.length === 1 ? ' is' : 's are'} already assigned to another album`);

  const missingAudio = [];
  const missingMetadata = [];
  const missingTitle = [];
  for (const song of songs) {
    const songDir = join(__dirname, '../../output/songs', song.id);
    const fsAssets = scanSongDir(songDir);
    if (!(fsAssets.audioFiles || []).length) missingAudio.push(song.id);
    if (!fsAssets.metadata) missingMetadata.push(song.id);
    if (!song.title && !song.topic) missingTitle.push(song.id);
  }
  if (missingAudio.length) warnings.push(`${missingAudio.length} selected song${missingAudio.length === 1 ? ' is' : 's are'} missing audio files`);
  if (missingMetadata.length) warnings.push(`${missingMetadata.length} selected song${missingMetadata.length === 1 ? ' is' : 's are'} missing metadata files`);
  if (missingTitle.length) warnings.push(`${missingTitle.length} selected song${missingTitle.length === 1 ? ' is' : 's are'} missing title metadata`);
  return warnings;
}

function parseTrackOrderFromBody(body, fallbackSongIds) {
  return fallbackSongIds
    .map((id, index) => ({
      id,
      order: Number(body?.[`track_order_${id}`]) || index + 1,
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(item => item.id);
}

function saveUploadedAlbumPrimaryImage(albumId, file) {
  const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
  if (!ALLOWED_IMG_EXTS.has(ext)) throw new Error('No valid image file provided (png/jpg/jpeg/webp)');
  const refDir = join(__dirname, '../../output/albums', albumId, 'reference');
  fs.mkdirSync(refDir, { recursive: true });
  for (const name of fs.readdirSync(refDir)) {
    if (/^primary-image\.(png|jpe?g|webp)$/i.test(name)) fs.unlinkSync(join(refDir, name));
  }
  fs.writeFileSync(join(refDir, `primary-image${ext}`), file.buffer);
  markReleaseAssetsStale('album', albumId);
}

function buildAlbumSmartLink(tracks) {
  for (const track of tracks || []) {
    const link = getReleaseLinks(track.id).find(item => /hyperfollow/i.test(item.platform || '') || /hyperfollow/i.test(item.url || ''));
    if (link?.url) return link.url;
    if (track.marketing_links?.smart_link) return track.marketing_links.smart_link;
  }
  return '';
}

function wantsJson(req) {
  return String(req.headers.accept || '').includes('application/json') || req.xhr;
}

function respondReleaseAction(req, res, cockpit, message, options = {}) {
  if (wantsJson(req)) {
    return res.json({
      ok: true,
      message,
      level: options.level || 'info',
      cockpit: buildReleaseCockpitViewModel(cockpit.type, cockpit.id),
    });
  }
  return res.redirect(303, buildReleaseDetailUrl(cockpit.type, cockpit.id, {
    notice: message,
    level: options.level || 'info',
    anchor: options.anchor || '',
  }));
}

function buildReleaseDetailUrl(type, id, options = {}) {
  const params = new URLSearchParams();
  if (options.notice) params.set('notice', options.notice);
  if (options.error) params.set('error', options.error);
  if (options.level) params.set('level', options.level);
  if (options.focus) params.set('focus', options.focus);
  const query = params.toString();
  const anchor = options.anchor ? `#${String(options.anchor).replace(/^#/, '')}` : '';
  return `/releases/${encodeURIComponent(type)}/${encodeURIComponent(id)}${query ? `?${query}` : ''}${anchor}`;
}

function buildDistroKidPreviewCommand(cockpit) {
  const modeArgs = cockpit.type === 'album'
    ? `--manifest output/release-packages/${cockpit.id}/manifest.json --no-pause --dry-run`
    : `--manifest output/release-packages/${cockpit.id}/manifest.json --no-pause --dry-run`;
  return `${process.execPath} scripts/distrokid/upload-release.mjs ${modeArgs}`;
}

function runReleaseAutomationInBackground({ cockpit, action, runId, command, runner }) {
  void Promise.resolve()
    .then(async () => {
      const result = await runner();
      const logPath = findReleaseAutomationLogPath(cockpit, result);
      logReleaseCockpitEvent(cockpit.type, cockpit.id, action, 'complete', `${humanizeReleaseAction(action)} finished.`, {
        runId,
        command,
        script: 'scripts/distrokid/upload-release.mjs',
        latest_run_log_path: logPath,
        result,
      });
    })
    .catch(error => {
      const logPath = error.runLogPath || findReleaseAutomationLogPath(cockpit, null);
      logReleaseCockpitEvent(cockpit.type, cockpit.id, action, 'failed', error.message, {
        runId,
        command,
        script: 'scripts/distrokid/upload-release.mjs',
        latest_run_log_path: logPath,
        error: error.message,
        details: error.details || [],
      });
    });
}

function findReleaseAutomationLogPath(cockpit, result) {
  const explicit = result?.job?.latest_run_log_path
    || result?.latest_run_log_path
    || result?.latestRunLogPath;
  if (explicit) return explicit;
  return `output/release-packages/${cockpit.id}/distrokid-run/run-log.json`;
}

function humanizeReleaseAction(action) {
  return {
    distrokid_preview: 'DistroKid preview automation',
    distrokid_live_submit: 'DistroKid live submit automation',
    hyperfollow: 'HyperFollow capture',
    outreach_campaign: 'Outreach build',
  }[action] || action;
}

function scanSongDir(songDir) {
  if (!fs.existsSync(songDir)) return {};
  const result = {};

  const tryFile = (path) => fs.existsSync(path) ? path : null;

  result.lyrics = tryFile(join(songDir, 'lyrics.md'));
  result.audioPrompt = tryFile(join(songDir, 'audio-prompt.md'));
  result.metadata = tryFile(join(songDir, 'metadata.json'));
  result.brandReview = tryFile(join(songDir, 'brand-review.json'));
  result.qaReport = tryFile(join(songDir, 'qa-report.json'));

  // Audio
  const audioDir = join(songDir, 'audio');
  const audioRoot = tryFile(join(songDir, 'audio.mp3')) || tryFile(join(songDir, 'audio.wav'));
  let audioFiles = [];
  if (audioRoot) audioFiles.push({ path: audioRoot, url: toWebUrl(audioRoot) });
  if (fs.existsSync(audioDir)) {
    const found = fs.readdirSync(audioDir)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.wav'))
      .map(f => {
        const p = join(audioDir, f);
        return { path: p, url: toWebUrl(p), name: f, size: fs.statSync(p).size };
      });
    audioFiles = audioFiles.concat(found);
  }
  result.audioFiles = audioFiles;

  // Thumbnails
  const thumbDir = join(songDir, 'thumbnails');
  result.thumbnails = fs.existsSync(thumbDir)
    ? filterVisibleThumbnailNames(fs.readdirSync(thumbDir))
        .map(f => {
          const p = join(thumbDir, f);
          return { path: p, url: toWebUrl(p), name: f };
        })
    : [];

  return result;
}

function readTextFile(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function readSongDetailFile(primaryPath, fallbackPath) {
  for (const candidate of [primaryPath, fallbackPath]) {
    const filePath = String(candidate || '').trim();
    if (!filePath) continue;
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return { path: filePath, content: fs.readFileSync(filePath, 'utf8') };
      }
    } catch {}
  }
  return { path: null, content: null };
}

async function generateMetadataForCockpitTrack(songId) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);
  const songDir = join(__dirname, '../../output/songs', song.id);
  const fsAssets = scanSongDir(songDir);
  const lyrics = readSongDetailFile(song.lyrics_path, fsAssets.lyrics).content || '';
  const result = await generateMetadata({
    songId: song.id,
    title: song.title || song.topic || song.id,
    topic: song.topic || song.title || song.id,
    lyrics,
    bpm: null,
    researchReport: null,
  });
  return {
    songId: song.id,
    metadataPath: result.metadataPath,
  };
}

function readSongMetadata(songDir) {
  const filePath = join(songDir, 'metadata.json');
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

function getSongDurationSeconds(metadata) {
  const raw = metadata?.duration_seconds ?? metadata?.durationSeconds ?? metadata?.length_seconds ?? null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function formatDuration(durationSeconds) {
  if (!durationSeconds) return '—';
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = String(durationSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function countLyricsWords(text) {
  if (!text) return 0;
  return text
    .replace(/\[[^\]]+\]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function summarizeSongDescription(song) {
  return song.concept || song.notes || song.topic || 'No description yet.';
}

function getReleaseRecommendationSummary(song) {
  const recommendation = song.release_recommendation || null;
  const marketingInputs = song.marketing_inputs_from_ar || {};
  if (!recommendation) {
    return {
      value: null,
      treatment: null,
      score: null,
      confidence: null,
      suggestedAssetStrategy: null,
      lastAnalyzed: null,
      topIssue: 'Not yet analyzed',
      bestHookPhrase: null,
      bestClipLabel: '—',
      isAnalyzed: false,
    };
  }
  return {
    value: recommendation.value || null,
    treatment: recommendation.recommended_release_treatment || null,
    score: Number.isFinite(Number(recommendation.score)) ? Number(recommendation.score) : null,
    confidence: recommendation.confidence || null,
    suggestedAssetStrategy: marketingInputs.suggested_asset_strategy || recommendation.recommended_asset_strategy || null,
    lastAnalyzed: recommendation.updated_at || recommendation.created_at || null,
    topIssue: recommendation.release_blockers?.[0] || recommendation.detected_issues?.[0] || 'No issues detected',
    bestHookPhrase: marketingInputs.best_hook_phrase || null,
    bestClipLabel: formatClipWindow(marketingInputs.best_clip_start_seconds, marketingInputs.best_clip_end_seconds),
    isAnalyzed: true,
  };
}

function formatClipWindow(start, end) {
  if (!Number.isFinite(Number(start))) return '—';
  const startLabel = formatDuration(Math.max(0, Math.round(Number(start))));
  if (!Number.isFinite(Number(end))) return startLabel;
  return `${startLabel}–${formatDuration(Math.max(0, Math.round(Number(end))))}`;
}

function normalizeRecommendationFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || '';
}

function recommendationBadgeClass(value) {
  switch (value) {
    case 'recommend_to_publish':
      return 'bg-emerald-100 text-emerald-700 border border-emerald-200';
    case 'recommend_to_edit':
      return 'bg-amber-100 text-amber-800 border border-amber-200';
    case 'recommend_to_hold':
      return 'bg-sky-100 text-sky-700 border border-sky-200';
    case 'recommend_to_archive':
      return 'bg-zinc-100 text-zinc-600 border border-zinc-200';
    case 'needs_manual_review':
      return 'bg-rose-100 text-rose-700 border border-rose-200';
    default:
      return 'bg-zinc-100 text-zinc-500 border border-zinc-200';
  }
}

function treatmentBadgeClass(value) {
  switch (value) {
    case 'full_push':
      return 'bg-emerald-100 text-emerald-700 border border-emerald-200';
    case 'light_push':
      return 'bg-lime-100 text-lime-700 border border-lime-200';
    case 'social_only':
      return 'bg-pink-100 text-pink-700 border border-pink-200';
    case 'catalog_depth':
      return 'bg-slate-100 text-slate-700 border border-slate-200';
    case 'edit_then_reassess':
      return 'bg-amber-100 text-amber-800 border border-amber-200';
    case 'hold_for_future':
      return 'bg-sky-100 text-sky-700 border border-sky-200';
    case 'archive_candidate':
      return 'bg-zinc-100 text-zinc-600 border border-zinc-200';
    case 'manual_review_required':
      return 'bg-rose-100 text-rose-700 border border-rose-200';
    default:
      return 'bg-zinc-100 text-zinc-500 border border-zinc-200';
  }
}

function recommendationLabel(value) {
  return String(value || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, char => char.toUpperCase()) || 'Not Yet Analyzed';
}

function scoreBandClass(score) {
  if (!Number.isFinite(Number(score))) return 'text-zinc-400';
  if (score >= 85) return 'text-emerald-700';
  if (score >= 70) return 'text-lime-700';
  if (score >= 55) return 'text-amber-700';
  return 'text-zinc-500';
}

function songStatusSortOrder(status) {
  const normalized = normalizeSongStatus(status);
  const order = [
    SONG_STATUSES.DRAFT,
    SONG_STATUSES.EDITING,
    SONG_STATUSES.SUBMITTED_TO_DISTROKID,
    SONG_STATUSES.OUTREACH_COMPLETE,
    SONG_STATUSES.ARCHIVED,
  ];
  const index = order.indexOf(normalized);
  return index === -1 ? order.length : index;
}

function filterVisibleThumbnailNames(files) {
  const pngs = files.filter(f => f.endsWith('.png'));
  const finals = new Set(
    pngs
      .filter(f => f.endsWith('-final.png'))
      .map(f => f.replace(/-final\.png$/, ''))
  );

  return pngs.filter(f => {
    if (!f.endsWith('-base.png')) return true;
    const stem = f.replace(/-base\.png$/, '');
    return !finals.has(stem);
  });
}

function buildReleaseOutreachRows(songId) {
  const targets = getMarketingTargets({});
  const targetIds = targets.map(target => target.id);
  const allHistory = getOutreachHistoryByTargetIds(targetIds);
  const releaseHistory = getOutreachHistoryByTargetIds(targetIds, { release_id: songId });
  const outletsById = new Map(
    targets.map(target => [
      target.id,
      normalizeOutletForApp(target, { outreachHistory: allHistory.get(target.id) || [] }),
    ])
  );

  return Array.from(releaseHistory.entries())
    .map(([targetId, history]) => {
      const outlet = outletsById.get(targetId);
      if (!outlet || !history.length) return null;
      const latest = history[0];
      return {
        outlet_id: targetId,
        outlet_name: outlet.name,
        recipient: latest.recipient_email || latest.recipient_name || '—',
        contacted_at: latest.contacted_at,
        channel: latest.channel || outlet.contactability.best_channel || 'unknown',
        last_message: latest.message_body || latest.message_preview || '',
        replied: history.some(event => event.status === 'replied'),
        do_not_contact: outlet.do_not_contact === true,
        bounced: history.some(event => event.status === 'bounced'),
        last_contact_overall: outlet.last_contact,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.contacted_at || 0) - new Date(a.contacted_at || 0));
}

function resolveSongDetailInitialTab({ requestedTab, song, lyricsContent, audioPromptContent, metadataParsed }) {
  const normalizedRequested = String(requestedTab || '').trim().toLowerCase();
  if (normalizedRequested === 'preview') return 'marketing';

  const allowed = new Set(['lyrics', 'prompt', 'meta', 'marketing', 'performance']);
  if (allowed.has(normalizedRequested)) return normalizedRequested;

  if (normalizeSongStatus(song?.status) === SONG_STATUSES.SUBMITTED_TO_DISTROKID) return 'marketing';
  if (lyricsContent) return 'lyrics';
  if (audioPromptContent) return 'prompt';
  if (metadataParsed) return 'meta';
  return 'marketing';
}

function syncReleaseLinksFromMarketingKit(songId, links = {}) {
  const mapping = [
    ['smart_link', 'HyperFollow'],
    ['spotify_url', 'Spotify'],
    ['apple_music_url', 'Apple Music'],
    ['youtube_music_url', 'YouTube Music'],
    ['youtube_video_url', 'YouTube'],
    ['cover_art_url', 'Cover Art'],
    ['lyrics_url', 'Lyrics'],
  ];
  for (const [field, platform] of mapping) {
    const url = String(links[field] || '').trim();
    if (url) upsertReleaseLink(songId, platform, url);
  }
}

function booleanFromRequest(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function hasGeneratedReleaseAssetPreviews(marketingAssets = {}) {
  return Boolean(
    marketingAssets?.square_post_url
    || marketingAssets?.vertical_post_url
    || marketingAssets?.portrait_post_url
    || marketingAssets?.outreach_banner_url
    || marketingAssets?.cover_safe_promo_url
    || marketingAssets?.no_text_variation_url
  );
}

function getAlbumAssetState(albumId) {
  return getReleaseAssetState('album', albumId);
}

function sendAssetPackZip(res, dir, filename) {
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'Asset pack has not been generated yet.' });
  res.attachment(filename);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', error => {
    if (!res.headersSent) res.status(500);
    res.end(error.message);
  });
  archive.pipe(res);
  archive.directory(dir, false);
  archive.finalize();
}

// ── START ───────────────────────────────────────────────────────
export { app };

if (process.argv[1] === __filename) {
  startDailySocialScheduler();
  app.listen(PORT, () => {
    console.log(`\n${APP_TITLE} UI running at http://localhost:${PORT}\n`);
  });
}
