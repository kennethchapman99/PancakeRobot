/**
 * Brand Doctor Service
 *
 * Manages Brand Doctor sessions: candidate generation, audio analysis,
 * profile patch proposals, and controlled patch application.
 *
 * Safety invariants:
 *   - Profiles are never overwritten without an explicit applyPatch() call.
 *   - Candidate generation is text-only; no audio generation whatsoever.
 *   - Analyze mode accepts uploaded audio for analysis only; never generates new audio.
 *   - Tune mode proposes text patches only; never generates new audio.
 *   - Real artist names are stripped from all generation-facing fields.
 *   - Patches validate before applying.
 *
 * Audio generation contract: Brand Doctor NEVER calls MiniMax or any paid audio
 * render API.  Any future change that would add audio generation MUST go through
 * the confirmPaidRerender=true guard defined in the music generation module.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  loadBrandProfileById,
  saveBrandProfileById,
  listBrandProfiles,
  resolveBrandProfilePath,
} from '../shared/brand-profile.js';
import { lintProfile } from '../shared/profile-enrichment.js';
import { analyzeAudioFile } from '../lib/release-selection/audio-analysis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
export const ARTIFACTS_DIR = join(ROOT_DIR, 'artifacts/brand-doctor');

// ── Safety lists ──────────────────────────────────────────────────────────────

const KNOWN_REAL_ARTIST_NAMES = [
  'doechii', 'radiohead', 'thom yorke', 'kendrick lamar', 'tyler', 'kanye', 'jay-z',
  'beyonce', 'drake', 'eminem', 'travis scott', 'frank ocean', 'anderson paak',
  'childish gambino', 'donald glover', 'wu-tang', 'wu tang', 'a tribe called quest',
  'tribe called quest', 'lorde', 'bjork', 'grimes', 'burial', 'aphex twin',
  'rage against the machine', 'smashing pumpkins', 'nirvana', 'soundgarden',
];

// Fields that feed directly into generation prompts — artist names must not appear here
const GENERATION_FACING_FIELDS = [
  'music.default_style',
  'music.default_prompt',
  'character.core_concept',
  'songwriting.reference_artists_for_internal_vibe_only',
  'songwriting.allowed_elements',
  'songwriting.forbidden_elements',
  'songwriting.required_elements',
  'songwriting.qa_rules',
  'songwriting.render_safety',
  'songwriting.vocal_performance_engine',
  'songwriting.anti_generic_rules',
  'songwriting.performance_conceit_bank',
];

const CANDIDATE_FEEDBACK_TAGS = [
  'strongest',
  'interesting but wrong',
  'too generic',
  'too derivative',
  'wrong vocal character',
  'wrong production',
  'save trait to brand',
  'never do this again',
];

const SONG_ANALYSIS_TAGS = [
  'gold',
  'boundary',
  'negative',
  'too generic',
  'too derivative',
  'wrong vocal character',
  'wrong production',
  'strong vocal identity',
  'weak vocal identity',
  'strong hook',
  'weak hook',
  'strong lyrics',
  'weak lyrics',
];

// ── Session status constants ──────────────────────────────────────────────────

export const SESSION_STATUS = {
  IN_PROGRESS: 'in_progress',
  CANDIDATES_GENERATED: 'candidates_generated',
  AUDIO_ANALYZED: 'audio_analyzed',
  FEEDBACK_SUBMITTED: 'feedback_submitted',
  PATCH_PROPOSED: 'patch_proposed',
  DRAFT_SAVED: 'draft_saved',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  ABORTED: 'aborted',
};

export const BRAND_DOCTOR_MODES = {
  CANDIDATES: 'candidates',
  ANALYZE: 'analyze',
};

// ── Anthropic client ──────────────────────────────────────────────────────────

let _client = null;
function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseURL = process.env.ANTHROPIC_BASE_URL || undefined;
    _client = new Anthropic({ apiKey, baseURL });
  }
  return _client;
}

// ── Session storage ───────────────────────────────────────────────────────────

function sessionDir(sessionId) {
  return join(ARTIFACTS_DIR, sessionId);
}

function sessionPath(sessionId) {
  return join(sessionDir(sessionId), 'session.json');
}

export function listSessions() {
  if (!fs.existsSync(ARTIFACTS_DIR)) return [];
  return fs.readdirSync(ARTIFACTS_DIR)
    .filter(name => {
      const p = join(ARTIFACTS_DIR, name, 'session.json');
      return fs.existsSync(p);
    })
    .map(name => {
      try {
        return JSON.parse(fs.readFileSync(join(ARTIFACTS_DIR, name, 'session.json'), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function loadSession(sessionId) {
  const p = sessionPath(sessionId);
  if (!fs.existsSync(p)) throw new Error(`Brand Doctor session not found: ${sessionId}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveSession(session) {
  const dir = sessionDir(session.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
  return session;
}

// ── Profile summary ───────────────────────────────────────────────────────────

function buildProfileSummary(profile) {
  const sw = profile.songwriting || {};
  return {
    brand_name: profile.brand_name || profile.character?.name || 'Unknown Brand',
    brand_type: profile.brand_type || 'music',
    genre_style_center: profile.music?.default_style || 'not specified',
    character_name: profile.character?.name || null,
    core_concept: profile.character?.core_concept || null,
    vocal_performance_engine: sw.vocal_performance_engine || null,
    performance_conceit_bank: sw.performance_conceit_bank || [],
    anti_generic_rules: sw.anti_generic_rules || [],
    album_mode_lanes: sw.album_mode_lanes || [],
    song_differentiation_rules: sw.song_differentiation_rules || [],
    do_not_repeat_across_album: sw.do_not_repeat_across_album || [],
    evaluation_targets: sw.evaluation_targets || null,
    candidate_generation_strategy: sw.candidate_generation_strategy || null,
    weak_areas: detectWeakAreas(profile),
  };
}

function detectWeakAreas(profile) {
  const sw = profile.songwriting || {};
  const weak = [];
  if (!sw.vocal_performance_engine) weak.push('vocal_performance_engine not defined');
  if (!sw.anti_generic_rules || sw.anti_generic_rules.length < 3) weak.push('anti_generic_rules sparse or missing');
  if (!sw.performance_conceit_bank || sw.performance_conceit_bank.length === 0) weak.push('performance_conceit_bank empty');
  if (!sw.song_differentiation_rules || sw.song_differentiation_rules.length === 0) weak.push('song_differentiation_rules empty');
  if (!profile.character?.core_concept) weak.push('character.core_concept missing');
  return weak;
}

// ── Artist name safety ────────────────────────────────────────────────────────

export function stripRealArtistNamesFromPatch(patch) {
  return deepMapStrings(patch, (str) => {
    let result = str;
    for (const name of KNOWN_REAL_ARTIST_NAMES) {
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
      result = result.replace(pattern, '[abstract influence]');
    }
    return result;
  });
}

function deepMapStrings(obj, fn) {
  if (typeof obj === 'string') return fn(obj);
  if (Array.isArray(obj)) return obj.map(item => deepMapStrings(item, fn));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deepMapStrings(v, fn);
    }
    return out;
  }
  return obj;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectRealArtistNamesInPatch(patch) {
  const found = new Set();
  function scan(obj) {
    if (typeof obj === 'string') {
      for (const name of KNOWN_REAL_ARTIST_NAMES) {
        const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
        if (pattern.test(obj)) found.add(name);
      }
    } else if (Array.isArray(obj)) {
      obj.forEach(scan);
    } else if (obj && typeof obj === 'object') {
      Object.values(obj).forEach(scan);
    }
  }
  scan(patch);
  return [...found];
}

// ── Session creation ──────────────────────────────────────────────────────────

export function createSession({ brandId, mode }) {
  if (!brandId) throw new Error('brandId is required');
  if (!Object.values(BRAND_DOCTOR_MODES).includes(mode)) {
    throw new Error(`mode must be one of: ${Object.values(BRAND_DOCTOR_MODES).join(', ')}`);
  }

  const profile = loadBrandProfileById(brandId);
  const sessionId = `bd-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const profileSummary = buildProfileSummary(profile);
  const profilePath = resolveBrandProfilePath(brandId);

  fs.writeFileSync(
    join(dir, 'profile-before.json'),
    JSON.stringify(profile, null, 2)
  );

  const session = {
    id: sessionId,
    timestamp: new Date().toISOString(),
    brandId,
    brandProfilePath: profilePath,
    mode,
    status: SESSION_STATUS.IN_PROGRESS,
    currentProfileSummary: profileSummary,
    candidateDirections: null,
    audioAnalyses: null,
    userFeedback: null,
    proposedPatch: null,
    patchExplanation: null,
    validationResult: null,
    beforeAfterDiff: null,
    appliedAt: null,
    draftPatchPath: null,
  };

  return saveSession(session);
}

// ── Mode 1: Candidate generation ──────────────────────────────────────────────

export async function generateCandidates(sessionId) {
  const session = loadSession(sessionId);
  if (session.mode !== BRAND_DOCTOR_MODES.CANDIDATES) {
    throw new Error('Session mode is not "candidates"');
  }

  const profile = loadBrandProfileById(session.brandId);
  const summary = session.currentProfileSummary;

  const systemPrompt = buildCandidateSystemPrompt();
  const userPrompt = buildCandidateUserPrompt(profile, summary);

  const rawText = await callClaude(systemPrompt, userPrompt, 8000, 'brand-doctor-candidates');
  const candidates = parseCandidatesJson(rawText);

  const dir = sessionDir(sessionId);
  fs.writeFileSync(join(dir, 'candidate-directions.json'), JSON.stringify(candidates, null, 2));

  session.candidateDirections = candidates;
  session.status = SESSION_STATUS.CANDIDATES_GENERATED;
  return saveSession(session);
}

function buildCandidateSystemPrompt() {
  return `You are a music brand strategist specializing in vocal identity, production texture, and brand differentiation.
Your task is to generate 4–6 candidate creative directions for a music brand.
Each direction must test a DISTINCT creative dimension — not just a different song title or mood.
Directions must be grounded in production and performance specifics, not generic adjectives.
Return ONLY valid JSON — no markdown, no explanation outside the JSON.`;
}

function buildCandidateUserPrompt(profile, summary) {
  return `Generate 4–6 candidate creative directions for this brand. Each direction must explore a DIFFERENT creative dimension.

CURRENT BRAND PROFILE:
Brand: ${summary.brand_name}
Type: ${summary.brand_type}
Genre/Style: ${summary.genre_style_center}
Character: ${summary.character_name || 'not defined'}
Core concept: ${summary.core_concept || 'not defined'}
Vocal engine: ${JSON.stringify(summary.vocal_performance_engine || 'not defined')}
Anti-generic rules: ${JSON.stringify(summary.anti_generic_rules)}
Weak areas: ${summary.weak_areas.join(', ') || 'none detected'}

Return a JSON array of candidate direction objects. Each object must have exactly these fields:
{
  "id": "c1",
  "name": "Short Direction Name",
  "testing": "What creative dimension this direction tests",
  "vocal_identity": "Specific vocal character and technique",
  "articulation_phonetics": "How consonants, vowels, syllables are handled",
  "hook_behavior": "How hooks and ear-worms work in this direction",
  "production_texture": "Instrumentation, density, space, sonic character",
  "emotional_posture": "The emotional stance — not generic adjectives",
  "performance_conceit": "The central artistic conceit the performer embodies",
  "anti_generic_risk_addressed": "Which genericness trap this direction avoids",
  "sample_audio_prompt": "A concrete prompt for this direction",
  "sample_negative_prompt": "What to explicitly avoid",
  "fields_likely_affected": ["list", "of", "profile", "fields"]
}

Candidate dimensions to vary across directions (use each at most once):
- sharper articulation / clipped consonants
- stranger hook behavior (unexpected cadence, anti-melodic)
- unstable adlib or background personality
- deliberate human imperfection (breathiness, grain, tempo drift)
- aggressive or compressed vocal attack
- emotional contradiction (happy delivery, dark content or vice versa)
- unconventional structure (no traditional chorus)
- unusual production texture (sparse, overloaded, or genre-alien elements)
- more theatrical / character-driven performance
- less polished, rawer sonic identity

Return the JSON array only. No other text.`;
}

function parseCandidatesJson(rawText) {
  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const arrayMatch = cleaned.match(/\[[\s\S]+\]/);
    if (arrayMatch) {
      parsed = JSON.parse(arrayMatch[0]);
    } else {
      throw new Error(`Could not parse candidate directions JSON: ${e.message}`);
    }
  }
  if (!Array.isArray(parsed) || parsed.length < 4 || parsed.length > 6) {
    throw new Error(`Expected 4–6 candidate directions, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
  }
  return parsed;
}

// ── Mode 2: Audio analysis ────────────────────────────────────────────────────

export async function analyzeAudio(sessionId, audioPaths) {
  const session = loadSession(sessionId);
  if (session.mode !== BRAND_DOCTOR_MODES.ANALYZE) {
    throw new Error('Session mode is not "analyze"');
  }
  if (!Array.isArray(audioPaths) || audioPaths.length === 0) {
    throw new Error('audioPaths must be a non-empty array');
  }

  const analyses = audioPaths.map(audioPath => {
    const filename = path.basename(audioPath);
    const result = analyzeAudioFile(audioPath);
    return {
      filename,
      audioPath,
      tags: [],
      notes: '',
      raw: result,
      brandImplications: null,
    };
  });

  const dir = sessionDir(sessionId);
  fs.writeFileSync(join(dir, 'analysis.json'), JSON.stringify(analyses, null, 2));

  session.audioAnalyses = analyses;
  session.status = SESSION_STATUS.AUDIO_ANALYZED;
  return saveSession(session);
}

// ── Feedback submission ───────────────────────────────────────────────────────

export function submitFeedback(sessionId, feedback) {
  const session = loadSession(sessionId);

  if (session.mode === BRAND_DOCTOR_MODES.CANDIDATES) {
    validateCandidateFeedback(feedback, session.candidateDirections);
  } else {
    validateAudioFeedback(feedback, session.audioAnalyses);
  }

  session.userFeedback = feedback;
  session.status = SESSION_STATUS.FEEDBACK_SUBMITTED;
  return saveSession(session);
}

function validateCandidateFeedback(feedback, candidates) {
  if (!feedback || typeof feedback !== 'object') throw new Error('feedback must be an object');
  if (!feedback.candidates || typeof feedback.candidates !== 'object') {
    throw new Error('feedback.candidates is required');
  }
  const validIds = new Set((candidates || []).map(c => c.id));
  for (const tag of Object.values(feedback.candidates).flatMap(c => c.tags || [])) {
    if (!CANDIDATE_FEEDBACK_TAGS.includes(tag)) {
      throw new Error(`Unknown candidate feedback tag: "${tag}". Valid: ${CANDIDATE_FEEDBACK_TAGS.join(', ')}`);
    }
  }
}

function validateAudioFeedback(feedback, analyses) {
  if (!feedback || typeof feedback !== 'object') throw new Error('feedback must be an object');
  if (!feedback.songs || typeof feedback.songs !== 'object') {
    throw new Error('feedback.songs is required for analyze mode');
  }
  for (const tag of Object.values(feedback.songs).flatMap(s => s.tags || [])) {
    if (!SONG_ANALYSIS_TAGS.includes(tag)) {
      throw new Error(`Unknown song tag: "${tag}". Valid: ${SONG_ANALYSIS_TAGS.join(', ')}`);
    }
  }
}

// ── Patch proposal ────────────────────────────────────────────────────────────

export async function proposePatch(sessionId) {
  const session = loadSession(sessionId);
  if (!session.userFeedback) throw new Error('Feedback must be submitted before proposing a patch');

  const profile = loadBrandProfileById(session.brandId);
  const systemPrompt = buildPatchSystemPrompt();
  const userPrompt = buildPatchUserPrompt(session, profile);

  const rawText = await callClaude(systemPrompt, userPrompt, 8000, 'brand-doctor-patch', 'claude-sonnet-4-6');
  const { patch, explanation } = parsePatchJson(rawText);

  const safePatch = stripRealArtistNamesFromPatch(patch);
  const artistNamesFound = detectRealArtistNamesInPatch(patch);
  if (artistNamesFound.length > 0) {
    console.warn(`[brand-doctor] Stripped real artist names from patch: ${artistNamesFound.join(', ')}`);
  }

  const profileBefore = JSON.parse(
    fs.readFileSync(join(sessionDir(sessionId), 'profile-before.json'), 'utf8')
  );
  const profileAfter = applyPatchToProfile(profileBefore, safePatch);

  const diff = buildDiff(profileBefore, profileAfter);
  const validationResult = validatePatchResult(safePatch, profileAfter);

  const dir = sessionDir(sessionId);
  fs.writeFileSync(join(dir, 'patch.json'), JSON.stringify(safePatch, null, 2));
  fs.writeFileSync(join(dir, 'profile-after-preview.json'), JSON.stringify(profileAfter, null, 2));
  fs.writeFileSync(join(dir, 'diff.txt'), diff);

  session.proposedPatch = safePatch;
  session.patchExplanation = explanation;
  session.validationResult = validationResult;
  session.beforeAfterDiff = diff;
  session.status = SESSION_STATUS.PATCH_PROPOSED;
  return saveSession(session);
}

function buildPatchSystemPrompt() {
  return `You are a music brand consultant proposing targeted improvements to a brand profile JSON.
You produce structured, minimal patches — only change what the feedback clearly indicates.
You never add real artist names to generation-facing fields.
You preserve distribution metadata, safety guardrails, and existing strong identity signals.
Return ONLY valid JSON with two top-level keys: "patch" and "explanation". No other text.`;
}

function buildPatchUserPrompt(session, profile) {
  const feedback = session.userFeedback;
  const summary = session.currentProfileSummary;
  const mode = session.mode;

  let feedbackSection = '';
  if (mode === BRAND_DOCTOR_MODES.CANDIDATES) {
    const candidateFeedback = feedback.candidates || {};
    const lines = [];
    for (const [id, fb] of Object.entries(candidateFeedback)) {
      const candidate = (session.candidateDirections || []).find(c => c.id === id);
      if (candidate) {
        lines.push(`- Candidate "${candidate.name}" (${id}): tags=[${(fb.tags || []).join(', ')}]${fb.notes ? ` notes="${fb.notes}"` : ''}`);
        if (fb.tags?.includes('strongest') || fb.tags?.includes('save trait to brand')) {
          lines.push(`  ^ Direction: ${candidate.testing}`);
          lines.push(`  ^ Vocal: ${candidate.vocal_identity}`);
          lines.push(`  ^ Fields affected: ${(candidate.fields_likely_affected || []).join(', ')}`);
        }
      }
    }
    feedbackSection = lines.join('\n');
  } else {
    const songFeedback = feedback.songs || {};
    const lines = [];
    for (const [filename, fb] of Object.entries(songFeedback)) {
      const analysis = (session.audioAnalyses || []).find(a => a.filename === filename || a.audioPath === filename);
      lines.push(`- Song "${filename}": tags=[${(fb.tags || []).join(', ')}]${fb.notes ? ` notes="${fb.notes}"` : ''}`);
      if (analysis?.raw?.ok) {
        const m = analysis.raw.metrics;
        lines.push(`  ^ duration=${m.duration_seconds}s, rms_mean=${m.rms_energy_mean}dB, peak=${m.peak_db}dB`);
      }
    }
    feedbackSection = lines.join('\n');
  }

  return `Propose a targeted profile patch based on Brand Doctor feedback.

CURRENT PROFILE (abbreviated):
Brand: ${summary.brand_name}
Style: ${summary.genre_style_center}
Vocal engine: ${JSON.stringify(summary.vocal_performance_engine || null)}
Anti-generic rules: ${JSON.stringify(summary.anti_generic_rules)}
Conceit bank: ${JSON.stringify(summary.performance_conceit_bank)}

FEEDBACK:
${feedbackSection}

PATCH RULES:
- Only touch fields that feedback clearly supports changing
- Patchable fields: songwriting.vocal_performance_engine, songwriting.performance_conceit_bank,
  songwriting.album_mode_lanes, songwriting.song_differentiation_rules,
  songwriting.anti_generic_rules, songwriting.do_not_repeat_across_album,
  songwriting.evaluation_targets, songwriting.candidate_generation_strategy
- Do NOT change: distribution.*, audience.guardrail, brand_name, character.name
- Do NOT introduce real artist names anywhere
- If feedback tags include "never do this again", add corresponding anti_generic_rules entries
- If feedback tags include "save trait to brand", incorporate that trait into the relevant field

Return JSON with exactly two keys:
{
  "patch": { "songwriting": { ...changed fields only... } },
  "explanation": "Human-readable paragraph explaining what changed and why"
}

Return JSON only. No other text.`;
}

function parsePatchJson(rawText) {
  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const objMatch = cleaned.match(/\{[\s\S]+\}/);
    if (objMatch) {
      parsed = JSON.parse(objMatch[0]);
    } else {
      throw new Error(`Could not parse patch JSON: ${e.message}`);
    }
  }
  if (!parsed.patch || typeof parsed.patch !== 'object') {
    throw new Error('Patch response missing "patch" key');
  }
  if (!parsed.explanation || typeof parsed.explanation !== 'string') {
    throw new Error('Patch response missing "explanation" key');
  }
  return { patch: parsed.patch, explanation: parsed.explanation };
}

export function applyPatchToProfile(profile, patch) {
  const result = JSON.parse(JSON.stringify(profile));
  for (const [topKey, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        result[topKey] && typeof result[topKey] === 'object' && !Array.isArray(result[topKey])) {
      result[topKey] = { ...result[topKey], ...value };
    } else {
      result[topKey] = value;
    }
  }
  return result;
}

// ── Patch validation ──────────────────────────────────────────────────────────

export function validatePatchResult(patch, profileAfter) {
  const errors = [];
  const warnings = [];

  // Lint the full post-patch profile
  try {
    const lintResult = lintProfile(profileAfter, 'brand-doctor-preview');
    if (lintResult.errors?.length) errors.push(...lintResult.errors.map(e => `lint: ${e}`));
    if (lintResult.warnings?.length) warnings.push(...lintResult.warnings.map(w => `lint: ${w}`));
  } catch (e) {
    errors.push(`Profile lint failed: ${e.message}`);
  }

  // Check no real artist names in patch's generation-facing content
  const artistNames = detectRealArtistNamesInPatch(patch);
  if (artistNames.length > 0) {
    errors.push(`Patch contains real artist names in generation-facing fields: ${artistNames.join(', ')}`);
  }

  // Verify distribution metadata untouched
  const distKeys = ['default_distributor', 'legacy_distributor', 'default_artist', 'default_album',
    'primary_genre', 'coppa_status', 'content_advisory'];
  const patchDist = patch.distribution || {};
  for (const key of distKeys) {
    if (key in patchDist) {
      warnings.push(`Patch touches distribution.${key} — verify this is intentional`);
    }
  }

  // Verify guardrail is not removed
  if (patch.audience?.guardrail === null || patch.audience?.guardrail === '') {
    errors.push('Patch removes audience.guardrail — this is not allowed');
  }

  const valid = errors.length === 0;
  return { valid, errors, warnings };
}

function buildDiff(before, after) {
  const beforeStr = JSON.stringify(before, null, 2);
  const afterStr = JSON.stringify(after, null, 2);

  if (beforeStr === afterStr) return '(no changes)';

  const beforeLines = beforeStr.split('\n');
  const afterLines = afterStr.split('\n');

  const lines = [];
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < maxLen; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === undefined) {
      lines.push(`+ ${a}`);
    } else if (a === undefined) {
      lines.push(`- ${b}`);
    } else if (b !== a) {
      lines.push(`- ${b}`);
      lines.push(`+ ${a}`);
    }
  }
  return lines.join('\n');
}

// ── Draft save ────────────────────────────────────────────────────────────────

export function saveDraftPatch(sessionId) {
  const session = loadSession(sessionId);
  if (!session.proposedPatch) throw new Error('No proposed patch to save as draft');

  const dir = sessionDir(sessionId);
  const draftPath = join(dir, 'patch.json');

  // patch.json is already written during proposePatch; this just records the path
  if (!fs.existsSync(draftPath)) {
    fs.writeFileSync(draftPath, JSON.stringify(session.proposedPatch, null, 2));
  }

  session.draftPatchPath = draftPath;
  session.status = SESSION_STATUS.DRAFT_SAVED;
  return saveSession(session);
}

// ── Apply patch ───────────────────────────────────────────────────────────────

export function applyPatch(sessionId) {
  const session = loadSession(sessionId);
  if (!session.proposedPatch) throw new Error('No proposed patch to apply');
  if (session.status === SESSION_STATUS.APPLIED) throw new Error('Patch already applied');
  if (session.status === SESSION_STATUS.REJECTED) throw new Error('Session was rejected');

  const profileBefore = JSON.parse(
    fs.readFileSync(join(sessionDir(sessionId), 'profile-before.json'), 'utf8')
  );
  const profileAfter = applyPatchToProfile(profileBefore, session.proposedPatch);

  const validation = validatePatchResult(session.proposedPatch, profileAfter);
  if (!validation.valid) {
    throw new Error(`Patch validation failed:\n${validation.errors.join('\n')}`);
  }

  saveBrandProfileById(session.brandId, profileAfter);

  session.validationResult = validation;
  session.appliedAt = new Date().toISOString();
  session.status = SESSION_STATUS.APPLIED;
  return saveSession(session);
}

// ── Reject / abort ────────────────────────────────────────────────────────────

export function rejectSession(sessionId) {
  const session = loadSession(sessionId);
  session.status = SESSION_STATUS.REJECTED;
  return saveSession(session);
}

export function abortSession(sessionId) {
  const session = loadSession(sessionId);
  session.status = SESSION_STATUS.ABORTED;
  return saveSession(session);
}

// ── Audio analysis for Mode 2 with brand implications ─────────────────────────

export async function enrichAnalysisWithImplications(sessionId) {
  const session = loadSession(sessionId);
  if (!session.audioAnalyses || session.audioAnalyses.length === 0) {
    throw new Error('No audio analyses to enrich');
  }

  const summary = session.currentProfileSummary;
  const analysisForPrompt = session.audioAnalyses.map(a => ({
    filename: a.filename,
    tags: a.tags,
    notes: a.notes,
    metrics: a.raw?.ok ? {
      duration_seconds: a.raw.metrics?.duration_seconds,
      rms_energy_mean: a.raw.metrics?.rms_energy_mean,
      peak_db: a.raw.metrics?.peak_db,
      clipping_detected: a.raw.metrics?.clipping_detected,
      high_energy_segments: a.raw.metrics?.high_energy_segments?.length,
      intro_energy_ramp: a.raw.metrics?.intro_energy_ramp,
      bitrate: a.raw.metrics?.bitrate,
    } : { error: a.raw?.reason || 'analysis failed' },
  }));

  const systemPrompt = `You are a music brand consultant interpreting audio analysis data.
Given technical audio metrics and user-provided tags, describe what each song reveals about the brand.
Note: simple audio analysis cannot fully determine vocal originality, copyright safety, or emotional nuance.
Be honest about inference limits. Return ONLY valid JSON.`;

  const userPrompt = `Interpret these audio analysis results for brand profile implications.

Brand: ${summary.brand_name} (${summary.genre_style_center})
Anti-generic rules: ${JSON.stringify(summary.anti_generic_rules)}

Songs analyzed:
${JSON.stringify(analysisForPrompt, null, 2)}

Return a JSON array, one entry per song:
[{
  "filename": "...",
  "file_summary": "one sentence",
  "detected_audio_traits": ["list"],
  "user_tag_summary": "interpretation of the tags",
  "likely_brand_strengths": ["list"],
  "mismatch_risks": ["list"],
  "genericness_risk": "low|medium|high",
  "production_notes": "...",
  "vocal_performance_notes": "... (note if inference is weak)",
  "suggested_brand_profile_implications": ["list"]
}]

Return the JSON array only.`;

  const rawText = await callClaude(systemPrompt, userPrompt, 6000, 'brand-doctor-analysis', 'claude-sonnet-4-6');
  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const implications = JSON.parse(cleaned);

  const enriched = session.audioAnalyses.map((a, i) => ({
    ...a,
    brandImplications: implications[i] || null,
  }));

  const dir = sessionDir(sessionId);
  fs.writeFileSync(join(dir, 'analysis.json'), JSON.stringify(enriched, null, 2));

  session.audioAnalyses = enriched;
  return saveSession(session);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userPrompt, maxTokens, agentLabel, model = 'claude-haiku-4-5-20251001') {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(`${agentLabel}: ANTHROPIC_API_KEY is not set`);
  }

  const client = getClient();
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = response.content?.[0];
  if (!content || content.type !== 'text') {
    throw new Error(`${agentLabel}: unexpected response format`);
  }
  return content.text;
}

export {
  CANDIDATE_FEEDBACK_TAGS,
  SONG_ANALYSIS_TAGS,
};
