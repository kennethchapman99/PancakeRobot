/**
 * Music Pipeline — Web UI Server
 * Run with: npm run web  (node src/web/server.js)
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
import { createRequire as _cReq } from 'module';
const _multer = _cReq(import.meta.url)('multer');

import {
  getAllIdeas, getIdea, createIdea, updateIdea,
  deleteIdeas,
  getAllSongs, getSong, upsertSong, updateSongStatus, deleteSong,
  getAssetsForSong, createAsset,
  getPublishingChecklist, updateChecklistItem, getChecklistProgress,
  getReleaseLinks, upsertReleaseLink,
  getPerformanceSnapshots,
  getDashboardStats,
} from '../shared/db.js';
import { getMarketingTargets } from '../shared/marketing-db.js';
import { getOutreachHistoryByTargetIds, normalizeOutletForApp } from '../shared/marketing-outlets.js';
import { runSuggestPipeline } from '../shared/suggest.js';
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
import { scanMarketingPack, scanSongBaseImage } from '../shared/song-catalog-marketing.js';
import {
  getSongMarketingKit,
  saveSongMarketingKit,
  syncSongMarketingKitFromPack,
  buildReleaseKitViewModel,
  MARKETING_LINK_FIELDS,
  MARKETING_ASSET_FIELDS,
} from '../shared/song-marketing-kit.js';
import {
  SONG_STATUSES,
  SONG_STATUS_OPTIONS,
  normalizeSongStatus,
  getSongStatusBadgeClass,
  getSongStatusLabel,
  isRecognizedSongStatusInput,
} from '../shared/song-status.js';
import { getSongNextAction } from '../shared/song-workflow.js';

// ── Base image upload config ───────────────────────────────────────
const ALLOWED_IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const baseImageUpload = _multer({
  storage: _multer.diskStorage({
    destination: (req, _file, cb) => {
      const refDir = join(__dirname, '../../output/songs', req.params.id, 'reference');
      fs.mkdirSync(refDir, { recursive: true });
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
  const topic = song.topic || song.title || `${BRAND_PROFILE.music.default_style} song`;

  const spawnedProfileId = getActiveProfileId();
  pipelineJobs.set(jobId, {
    status: 'running',
    logs: [],
    songId: song.id,
    spawnedProfileId,
    error: null,
    startedAt: Date.now(),
  });

  const orchestratorPath = join(__dirname, '../orchestrator.js');
  const activeProfilePath = resolveBrandProfilePath(spawnedProfileId);
  const child = spawn('node', [orchestratorPath, '--new', '--id', song.id, topic], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, WEB_PIPELINE: '1', FORCE_COLOR: '0', BRAND_PROFILE_PATH: activeProfilePath },
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
        try { upsertSong({ id: job.songId, brand_profile_id: job.spawnedProfileId }); } catch {}
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
  res.flushHeaders();

  let lastIndex = 0;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const tick = () => {
    const job = pipelineJobs.get(jobId);
    if (!job) { send('error', { message: 'Job not found' }); res.end(); return; }

    const newLogs = job.logs.slice(lastIndex);
    for (const line of newLogs) send('log', { message: line });
    lastIndex = job.logs.length;

    if (job.status === 'done') {
      send('complete', { songId: job.songId, originalSongId: job.originalSongId });
      res.end();
    } else if (job.status === 'error') {
      send('error', { message: job.error });
      res.end();
    } else {
      setTimeout(tick, 600);
    }
  };

  req.on('close', () => {});
  tick();
});

// ── SONGS ──────────────────────────────────────────────────────
app.get('/songs', (req, res) => {
  let songs = getAllSongs().map(s => {
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
      hasArtwork: Boolean(previewImageUrl),
      lastOutreachAt: s.last_outreach?.contacted_at || s.last_outreach?.updated_at || null,
    };
  });

  const { q, status, sort, brand } = req.query;
  const normalizedFilterStatus = status ? normalizeSongStatus(status) : '';

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

  if (sort === 'readiness') songs.sort((a, b) => b.progress.pct - a.progress.pct);
  else if (sort === 'title') songs.sort((a, b) => String(a.title || a.topic || '').localeCompare(String(b.title || b.topic || '')));
  else if (sort === 'status') songs.sort((a, b) => songStatusSortOrder(a.status) - songStatusSortOrder(b.status) || new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  else if (sort === 'created') songs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  else {
    songs.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  }

  const profiles = listBrandProfiles();
  res.render('songs/index', { songs, q: q || '', filterStatus: normalizedFilterStatus || '', filterBrand: brand || '', sort: sort || '', totalCounts, profiles });
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

  // Read file contents for tabs
  const readFile = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } };
  const lyricsContent    = readFile(fsAssets.lyrics);
  const audioPromptContent = readFile(fsAssets.audioPrompt);
  const metadataContent  = fsAssets.metadata ? readFile(fsAssets.metadata) : null;
  const brandReviewContent = fsAssets.brandReview ? readFile(fsAssets.brandReview) : null;
  const metadataParsed   = metadataContent ? (() => { try { return JSON.parse(metadataContent); } catch { return null; } })() : null;
  const brandParsed      = brandReviewContent ? (() => { try { return JSON.parse(brandReviewContent); } catch { return null; } })() : null;

  const marketingPack = scanMarketingPack(song.id);
  const baseImage = scanSongBaseImage(song.id);
  const releaseOutreachRows = buildReleaseOutreachRows(song.id);
  const marketingKit = getSongMarketingKit(song, { releaseLinks: links, marketingPack, baseImage });
  const requestedTab = String(req.query.tab || '').toLowerCase();
  const initialTab = resolveSongDetailInitialTab({
    requestedTab,
    song,
    lyricsContent,
    audioPromptContent,
    metadataParsed,
  });

  res.render('songs/detail', {
    song, idea, assets, checklist, progress, links, snapshots, fsAssets,
    lyricsContent, audioPromptContent, metadataParsed, brandParsed,
    marketingPack, baseImage, releaseOutreachRows, marketingKit,
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

  const saved = saveSongMarketingKit(song.id, { marketing_links, marketing_assets });
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

function clearSongBaseImage(songId) {
  const refDir = join(__dirname, '../../output/songs', songId, 'reference');
  if (!fs.existsSync(refDir)) return;
  for (const f of fs.readdirSync(refDir)) {
    if (f.startsWith('base-image')) {
      try { fs.unlinkSync(join(refDir, f)); } catch {}
    }
  }
}

// Upload base image
app.post('/api/songs/:id/base-image', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  baseImageUpload.single('base_image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No valid image file provided (png/jpg/jpeg/webp)' });
    saveSongMarketingKit(req.params.id, { marketing_assets: { base_image_url: scanSongBaseImage(req.params.id)?.url || '' } });
    const info = scanSongBaseImage(req.params.id);
    res.json({ ok: true, baseImage: info });
  });
});

// Clear base image
app.delete('/api/songs/:id/base-image', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  clearSongBaseImage(req.params.id);
  saveSongMarketingKit(req.params.id, { marketing_assets: { base_image_url: '' } });
  res.json({ ok: true });
});

// ── SOCIAL ASSET PACK (Phase 6) ─────────────────────────────────────────────

const socialPackJobs = new Map(); // jobId → { status, logs, error, outputDir, dashboardUrl }

app.post('/api/songs/:id/social-assets', (req, res) => {
  const song = getSong(req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  const jobId = `pack_${song.id}_${Date.now().toString(36)}`;
  socialPackJobs.set(jobId, { status: 'running', logs: [], error: null, outputDir: null, dashboardUrl: null });

  const {
    mode = '', provider = '', formats = '', useBaseImage, regenerateBaseArt, renderVideos, requireApprovalBeforeVideo,
  } = req.body || {};
  const normalizedFormats = Array.isArray(formats) ? formats.join(',') : formats;

  const args = [join(__dirname, '../scripts/build-marketing-pack.js'), '--song-id', song.id];
  if (mode) args.push('--mode', mode);
  if (provider) args.push('--provider', provider);
  if (normalizedFormats) args.push('--formats', normalizedFormats);
  if (useBaseImage === false || useBaseImage === 'false') args.push('--no-use-base-image');
  if (regenerateBaseArt === true || regenerateBaseArt === 'true') args.push('--regenerate-base-art');
  if (renderVideos === false || renderVideos === 'false') args.push('--no-render-videos');
  if (requireApprovalBeforeVideo === true || requireApprovalBeforeVideo === 'true') args.push('--require-approval-before-video');

  const child = spawn('node', args, {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const job = socialPackJobs.get(jobId);
  const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHFABCDEFsuhl]/g,'').replace(/\x1B\][^\x07]*\x07/g,'').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g,'').trim();

  let buf = '';
  const onData = d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) { const c = stripAnsi(l); if (c) job.logs.push(c); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', code => {
    if (buf.trim()) { const c = stripAnsi(buf); if (c) job.logs.push(c); }
    job.status = code === 0 ? 'done' : 'error';
    if (code !== 0) job.error = `Process exited ${code}`;
    const packInfo = scanMarketingPack(song.id);
    try { syncSongMarketingKitFromPack(song.id, { marketingPack: packInfo }); } catch {}
    job.dashboardUrl = packInfo.dashboardUrl;
    job.outputDir = packInfo.exists ? join(__dirname, '../../output/marketing-ready', song.id) : null;
  });

  res.json({ ok: true, jobId });
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

app.get('/api/songs/social-assets/stream/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let cursor = 0;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const tick = () => {
    const job = socialPackJobs.get(req.params.jobId);
    if (!job) { send('error', { message: 'Job not found' }); return res.end(); }
    while (cursor < job.logs.length) send('log', { message: job.logs[cursor++] });
    if (job.status === 'done') { send('complete', { dashboardUrl: job.dashboardUrl }); return res.end(); }
    if (job.status === 'error') { send('error', { message: job.error }); return res.end(); }
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
  updateSongStatus(req.params.id, status);
  res.json({ ok: true });
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
  res.json({ ok: true });
});

// Bulk status update — must be before /:id routes
app.post('/api/songs/bulk-status', (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !status) return res.status(400).json({ error: 'ids[] and status required' });
  if (!SONG_STATUS_OPTIONS.some(option => option.value === status)) return res.status(400).json({ error: 'Invalid status' });
  let updated = 0;
  for (const id of ids) {
    try { updateSongStatus(id, status); updated++; } catch { /* skip unknown ids */ }
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

// ── 404 ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('404', { message: `Page not found: ${req.path}` });
});

// ── HELPERS ────────────────────────────────────────────────────
const OUTPUT_DIR = join(__dirname, '../../output');
function toWebUrl(absPath) {
  return '/media/' + absPath.replace(OUTPUT_DIR, '').replace(/\\/g, '/').replace(/^\//, '');
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

// ── START ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n${APP_TITLE} UI running at http://localhost:${PORT}\n`);
});
