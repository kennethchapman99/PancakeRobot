/**
 * Brand Doctor — Express router
 *
 * UI routes:
 *   GET /brand-doctor            → landing (session list + new session form)
 *   GET /brand-doctor/sessions/:id → session detail page
 *
 * API routes:
 *   POST   /api/brand-doctor/sessions
 *   GET    /api/brand-doctor/sessions/:id
 *   POST   /api/brand-doctor/sessions/:id/candidates
 *   POST   /api/brand-doctor/sessions/:id/analyze
 *   POST   /api/brand-doctor/sessions/:id/feedback
 *   POST   /api/brand-doctor/sessions/:id/propose-patch
 *   POST   /api/brand-doctor/sessions/:id/save-draft
 *   POST   /api/brand-doctor/sessions/:id/apply-patch
 *   POST   /api/brand-doctor/sessions/:id/reject
 */

import express from 'express';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';
import fs from 'fs';
import {
  createSession,
  loadSession,
  listSessions,
  generateCandidates,
  analyzeAudio,
  enrichAnalysisWithImplications,
  submitFeedback,
  proposePatch,
  saveDraftPatch,
  applyPatch,
  rejectSession,
  abortSession,
  BRAND_DOCTOR_MODES,
  SESSION_STATUS,
  CANDIDATE_FEEDBACK_TAGS,
  SONG_ANALYSIS_TAGS,
  ARTIFACTS_DIR,
} from '../../services/brand-doctor-service.js';
import { listBrandProfiles, loadBrandProfileById } from '../../shared/brand-profile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const multer = _require('multer');

const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg']);

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const uploadDir = join(ARTIFACTS_DIR, req.params.id, 'uploads');
      fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.mp3';
      const base = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 40);
      cb(null, `${base}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_AUDIO_EXTS.has(ext));
  },
});

export function registerBrandDoctorRouter(app) {
  const router = express.Router();

  // ── UI routes ────────────────────────────────────────────────────────────
  router.get('/brand-doctor', renderIndex);
  router.get('/brand-doctor/sessions/:id', renderSession);

  // ── API routes ───────────────────────────────────────────────────────────
  router.post('/api/brand-doctor/sessions', apiCreateSession);
  router.get('/api/brand-doctor/sessions/:id', apiGetSession);
  router.post('/api/brand-doctor/sessions/:id/candidates', apiGenerateCandidates);
  router.post('/api/brand-doctor/sessions/:id/analyze', audioUpload.array('audio', 20), apiAnalyzeAudio);
  router.post('/api/brand-doctor/sessions/:id/feedback', apiSubmitFeedback);
  router.post('/api/brand-doctor/sessions/:id/propose-patch', apiProposePatch);
  router.post('/api/brand-doctor/sessions/:id/save-draft', apiSaveDraft);
  router.post('/api/brand-doctor/sessions/:id/apply-patch', apiApplyPatch);
  router.post('/api/brand-doctor/sessions/:id/reject', apiReject);

  app.use(router);
}

// ── UI handlers ───────────────────────────────────────────────────────────────

function renderIndex(req, res) {
  try {
    const profiles = listBrandProfiles();
    const sessions = listSessions();
    res.render('brand-doctor/index', {
      title: 'Brand Doctor',
      profiles,
      sessions,
      modes: BRAND_DOCTOR_MODES,
      sessionStatus: SESSION_STATUS,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  } catch (err) {
    res.status(500).render('error', { message: err.message });
  }
}

function renderSession(req, res) {
  try {
    const session = loadSession(req.params.id);
    const profiles = listBrandProfiles();
    const profileEntry = profiles.find(p => p.id === session.brandId);

    res.render('brand-doctor/session', {
      title: `Brand Doctor — ${session.currentProfileSummary?.brand_name || session.brandId}`,
      session,
      profileEntry,
      modes: BRAND_DOCTOR_MODES,
      sessionStatus: SESSION_STATUS,
      candidateFeedbackTags: CANDIDATE_FEEDBACK_TAGS,
      songAnalysisTags: SONG_ANALYSIS_TAGS,
    });
  } catch (err) {
    if (/not found/i.test(err.message)) return res.status(404).render('404', { message: err.message });
    res.status(500).render('error', { message: err.message });
  }
}

// ── API handlers ──────────────────────────────────────────────────────────────

function apiCreateSession(req, res) {
  try {
    const { brandId, mode } = req.body || {};
    const session = createSession({ brandId, mode });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(session.id)}`);
  } catch (err) {
    res.redirect(303, `/brand-doctor?error=${encodeURIComponent(err.message)}`);
  }
}

function apiGetSession(req, res) {
  try {
    const session = loadSession(req.params.id);
    res.json({ ok: true, session });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
}

async function apiGenerateCandidates(req, res) {
  try {
    const session = await generateCandidates(req.params.id);
    if (acceptsJson(req)) return res.json({ ok: true, session });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}`);
  } catch (err) {
    if (acceptsJson(req)) return res.status(500).json({ ok: false, error: err.message });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent(err.message)}`);
  }
}

async function apiAnalyzeAudio(req, res) {
  try {
    const uploadedFiles = (req.files || []).map(f => f.path);

    // Also accept JSON body paths (for CLI/test use)
    const bodyPaths = Array.isArray(req.body?.audioPaths) ? req.body.audioPaths : [];
    const allPaths = [...uploadedFiles, ...bodyPaths].filter(Boolean);

    if (allPaths.length === 0) {
      return res.status(400).json({ ok: false, error: 'No audio files provided' });
    }

    let session = await analyzeAudio(req.params.id, allPaths);

    // Enrich with brand implications (requires LLM)
    try {
      session = await enrichAnalysisWithImplications(req.params.id);
    } catch (enrichErr) {
      console.warn(`[brand-doctor] Analysis enrichment failed (non-fatal): ${enrichErr.message}`);
    }

    if (acceptsJson(req)) return res.json({ ok: true, session });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}`);
  } catch (err) {
    if (acceptsJson(req)) return res.status(500).json({ ok: false, error: err.message });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent(err.message)}`);
  }
}

function apiSubmitFeedback(req, res) {
  try {
    const feedback = req.body?.feedback;
    const parsed = typeof feedback === 'string' ? JSON.parse(feedback) : feedback;
    const session = submitFeedback(req.params.id, parsed);
    if (acceptsJson(req)) return res.json({ ok: true, session });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}`);
  } catch (err) {
    if (acceptsJson(req)) return res.status(400).json({ ok: false, error: err.message });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent(err.message)}`);
  }
}

async function apiProposePatch(req, res) {
  try {
    const session = await proposePatch(req.params.id);
    if (acceptsJson(req)) return res.json({ ok: true, session });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}`);
  } catch (err) {
    if (acceptsJson(req)) return res.status(500).json({ ok: false, error: err.message });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent(err.message)}`);
  }
}

function apiSaveDraft(req, res) {
  try {
    const session = saveDraftPatch(req.params.id);
    if (acceptsJson(req)) return res.json({ ok: true, session });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}?message=${encodeURIComponent('Draft patch saved.')}`);
  } catch (err) {
    if (acceptsJson(req)) return res.status(400).json({ ok: false, error: err.message });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent(err.message)}`);
  }
}

function apiApplyPatch(req, res) {
  try {
    const session = applyPatch(req.params.id);
    if (acceptsJson(req)) return res.json({ ok: true, session });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}?message=${encodeURIComponent('Patch applied successfully.')}`);
  } catch (err) {
    if (acceptsJson(req)) return res.status(400).json({ ok: false, error: err.message });
    res.redirect(303, `/brand-doctor/sessions/${encodeURIComponent(req.params.id)}?error=${encodeURIComponent(err.message)}`);
  }
}

function apiReject(req, res) {
  try {
    const session = rejectSession(req.params.id);
    if (acceptsJson(req)) return res.json({ ok: true, session });
    res.redirect(303, `/brand-doctor?message=${encodeURIComponent('Session rejected.')}`);
  } catch (err) {
    if (acceptsJson(req)) return res.status(400).json({ ok: false, error: err.message });
    res.redirect(303, `/brand-doctor?error=${encodeURIComponent(err.message)}`);
  }
}

function acceptsJson(req) {
  return req.headers?.accept?.includes('application/json') ||
    req.headers?.['content-type']?.includes('application/json');
}
