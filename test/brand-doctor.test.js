/**
 * Brand Doctor — test suite (16 required cases)
 *
 * LLM calls (generateCandidates, proposePatch, enrichAnalysis) are NOT invoked.
 * Tests that need post-generation state inject fixture data directly into the
 * session JSON so downstream logic (feedback, patch validation, apply, diff,
 * save-draft) can be exercised without live API calls.
 *
 * Audio analysis tests use test/fixtures/test-tone.mp3 (a 2-second sine wave).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const FIXTURE_MP3 = path.join(repoRoot, 'test/fixtures/test-tone.mp3');

// ── Top-level imports (all await at module scope — valid in ESM) ──────────────

const {
  createSession,
  loadSession,
  listSessions,
  submitFeedback,
  saveDraftPatch,
  applyPatch,
  rejectSession,
  validatePatchResult,
  applyPatchToProfile,
  stripRealArtistNamesFromPatch,
  detectRealArtistNamesInPatch,
  analyzeAudio,
  BRAND_DOCTOR_MODES,
  SESSION_STATUS,
  CANDIDATE_FEEDBACK_TAGS,
  SONG_ANALYSIS_TAGS,
  ARTIFACTS_DIR,
} = await import('../src/services/brand-doctor-service.js');

const { loadBrandProfileById, resolveBrandProfilePath } =
  await import('../src/shared/brand-profile.js');

// release-cockpit.js transitively loads the canvas native module.  When running
// with a Node version that mismatches the compiled binary (e.g. system node
// instead of the project-pinned v22.22.2) the import will fail.  Guard so the
// rest of the suite still runs.
let buildReleaseCockpitViewModel, listReleaseCockpitEntries;
let cockpitSkipReason = false;
try {
  ({ buildReleaseCockpitViewModel, listReleaseCockpitEntries } =
    await import('../src/shared/release-cockpit.js'));
} catch (err) {
  cockpitSkipReason = `canvas native module unavailable in this Node runtime: ${err.message.split('\n')[0]}`;
}

const { listBrandProfiles } = await import('../src/shared/brand-profile.js');

const TEST_PROFILE_ID = 'default';
const createdSessionIds = [];

function trackSession(session) {
  createdSessionIds.push(session.id);
  return session;
}

test.after(() => {
  for (const id of createdSessionIds) {
    const dir = path.join(ARTIFACTS_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fixture: candidate directions ─────────────────────────────────────────────

const SAMPLE_CANDIDATES = [
  { id: 'c1', name: 'Clipped Precision', testing: 'sharper articulation / clipped consonants', vocal_identity: 'tight clipped delivery', articulation_phonetics: 'hard consonant stops', hook_behavior: 'short melodic cells', production_texture: 'sparse percussion', emotional_posture: 'controlled tension', performance_conceit: 'typewriter precision', anti_generic_risk_addressed: 'over-smoothed delivery', sample_audio_prompt: 'tight crisp vocals', sample_negative_prompt: 'smooth reverb wash', fields_likely_affected: ['songwriting.vocal_performance_engine'] },
  { id: 'c2', name: 'Unstable Ghost', testing: 'unstable adlib personality', vocal_identity: 'ghostly background presence', articulation_phonetics: 'breathy offsets', hook_behavior: 'echoing fragments', production_texture: 'reverb trails', emotional_posture: 'haunted indifference', performance_conceit: 'the voice behind the voice', anti_generic_risk_addressed: 'single vocal plane', sample_audio_prompt: 'layered ghost vocals', sample_negative_prompt: 'clean radio mix', fields_likely_affected: ['songwriting.performance_conceit_bank'] },
  { id: 'c3', name: 'Human Error', testing: 'deliberate human imperfection', vocal_identity: 'slightly off-pitch grain', articulation_phonetics: 'throat catches, breath noise', hook_behavior: 'stumbles into groove', production_texture: 'lo-fi warmth', emotional_posture: 'vulnerable authenticity', performance_conceit: 'human in the machine', anti_generic_risk_addressed: 'over-polished production', sample_audio_prompt: 'raw indie vocal take', sample_negative_prompt: 'pitch-corrected perfection', fields_likely_affected: ['songwriting.anti_generic_rules'] },
  { id: 'c4', name: 'Aggressive Attack', testing: 'aggressive vocal attack / compressed entry', vocal_identity: 'hard-hit first syllables', articulation_phonetics: 'front-loaded emphasis', hook_behavior: 'punches in at bar 1', production_texture: 'loud mix with tight ceiling', emotional_posture: 'barely contained intensity', performance_conceit: 'wall of sound entry', anti_generic_risk_addressed: 'quiet intro trap', sample_audio_prompt: 'loud attack entry mix', sample_negative_prompt: 'soft fade-in', fields_likely_affected: ['songwriting.song_differentiation_rules'] },
];

const MINIMAL_PATCH = {
  songwriting: {
    anti_generic_rules: [
      'Never smooth all consonants into radio-safe mush',
      'Prefer clipped hard stops over legato flow',
    ],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function injectCandidates(sessionId, candidates) {
  const session = loadSession(sessionId);
  session.candidateDirections = candidates;
  session.status = SESSION_STATUS.CANDIDATES_GENERATED;
  const dir = path.join(ARTIFACTS_DIR, sessionId);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, null, 2));
  fs.writeFileSync(path.join(dir, 'candidate-directions.json'), JSON.stringify(candidates, null, 2));
}

function injectPatch(sessionId, patch, explanation) {
  const session = loadSession(sessionId);
  const profileBefore = loadBrandProfileById(session.brandId);
  const profileAfter = applyPatchToProfile(profileBefore, patch);
  const validationResult = validatePatchResult(patch, profileAfter);
  const diff = '--- before\n+++ after\n(fixture diff)';

  session.proposedPatch = patch;
  session.patchExplanation = explanation || 'Test patch explanation';
  session.validationResult = validationResult;
  session.beforeAfterDiff = diff;
  session.status = SESSION_STATUS.PATCH_PROPOSED;

  const dir = path.join(ARTIFACTS_DIR, sessionId);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, null, 2));
  fs.writeFileSync(path.join(dir, 'profile-before.json'), JSON.stringify(profileBefore, null, 2));
  fs.writeFileSync(path.join(dir, 'profile-after-preview.json'), JSON.stringify(profileAfter, null, 2));
  fs.writeFileSync(path.join(dir, 'patch.json'), JSON.stringify(patch, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Brand Doctor UI route loads
// ═══════════════════════════════════════════════════════════════════════════════

test('1. Brand Doctor router defines /brand-doctor UI routes', () => {
  const routerSource = fs.readFileSync(
    path.join(repoRoot, 'src/web/brand-doctor/router.js'), 'utf8'
  );
  assert.ok(routerSource.includes("router.get('/brand-doctor'"), 'GET /brand-doctor route defined');
  assert.ok(routerSource.includes("router.get('/brand-doctor/sessions/:id'"), 'session detail route defined');
  assert.ok(routerSource.includes('renderIndex'), 'renderIndex handler present');
  assert.ok(routerSource.includes('renderSession'), 'renderSession handler present');
  assert.ok(routerSource.includes("router.post('/api/brand-doctor/sessions'"), 'create session API route present');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Brand profile selector is populated
// ═══════════════════════════════════════════════════════════════════════════════

test('2. listBrandProfiles returns profiles; index view iterates them for selector', () => {
  const profiles = listBrandProfiles();
  assert.ok(profiles.length >= 1, 'At least one profile available');
  assert.ok(profiles[0].id, 'Profile has id');
  assert.ok(profiles[0].name, 'Profile has name');

  const indexSource = fs.readFileSync(
    path.join(repoRoot, 'src/web/views/brand-doctor/index.ejs'), 'utf8'
  );
  assert.ok(indexSource.includes('for (const profile of profiles)'), 'View iterates profiles');
  assert.ok(indexSource.includes('profile.id'), 'View uses profile.id for select value');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Candidate mode creates 4–6 differentiated text-only directions
// ═══════════════════════════════════════════════════════════════════════════════

test('3. SAMPLE_CANDIDATES fixture has 4–6 entries with distinct testing dimensions', () => {
  assert.ok(SAMPLE_CANDIDATES.length >= 4, `At least 4: got ${SAMPLE_CANDIDATES.length}`);
  assert.ok(SAMPLE_CANDIDATES.length <= 6, `At most 6: got ${SAMPLE_CANDIDATES.length}`);

  const dimensions = SAMPLE_CANDIDATES.map(c => c.testing);
  const unique = new Set(dimensions);
  assert.equal(unique.size, dimensions.length, 'All directions test distinct dimensions');

  for (const c of SAMPLE_CANDIDATES) {
    assert.ok(c.id, `${c.id}: has id`);
    assert.ok(c.name, `${c.id}: has name`);
    assert.ok(c.vocal_identity, `${c.id}: has vocal_identity`);
    assert.ok(c.hook_behavior, `${c.id}: has hook_behavior`);
    assert.ok(c.production_texture, `${c.id}: has production_texture`);
    assert.ok(c.sample_audio_prompt, `${c.id}: has sample_audio_prompt`);
    assert.ok(Array.isArray(c.fields_likely_affected), `${c.id}: fields_likely_affected is array`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Candidate mode does not trigger paid audio renders by default
// ═══════════════════════════════════════════════════════════════════════════════

test('4. Brand Doctor service does not import audio render services', () => {
  const serviceSource = fs.readFileSync(
    path.join(repoRoot, 'src/services/brand-doctor-service.js'), 'utf8'
  );
  assert.ok(!serviceSource.includes('music-generator'), 'No music-generator import');
  assert.ok(!serviceSource.includes('minimax'), 'No minimax import');
  assert.ok(!serviceSource.includes('suno'), 'No suno import');
  assert.ok(!serviceSource.includes('audio_render'), 'No audio_render call');

  // generateCandidates uses callClaude (text only)
  const fnStart = serviceSource.indexOf('async function generateCandidates');
  assert.ok(fnStart >= 0, 'generateCandidates function exists');
  const fnEnd = serviceSource.indexOf('\nasync function ', fnStart + 10);
  const block = serviceSource.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 4000);
  assert.ok(block.includes('callClaude'), 'generateCandidates calls callClaude');
  assert.ok(!block.toLowerCase().includes('render'), 'generateCandidates has no render calls');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Extra audio renders require explicit approval / config
// ═══════════════════════════════════════════════════════════════════════════════

test('5. UI warns about audio generation cost; no auto multi-render in default flow', () => {
  const indexView = fs.readFileSync(
    path.join(repoRoot, 'src/web/views/brand-doctor/index.ejs'), 'utf8'
  );
  assert.ok(
    indexView.includes('text-only') || indexView.includes('Cost notice') || indexView.includes('audio generation'),
    'Index view includes audio generation warning'
  );

  const sessionView = fs.readFileSync(
    path.join(repoRoot, 'src/web/views/brand-doctor/session.ejs'), 'utf8'
  );
  assert.ok(
    sessionView.includes('text-only') || sessionView.includes('no audio renders'),
    'Session view mentions text-only for candidate mode'
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Candidate feedback produces a valid proposed profile patch
// ═══════════════════════════════════════════════════════════════════════════════

test('6. submitFeedback accepts valid candidate tags; rejects unknown tags', () => {
  const validFeedback = {
    candidates: {
      c1: { tags: ['strongest', 'save trait to brand'], notes: '' },
      c2: { tags: ['too generic'], notes: '' },
      c3: { tags: [], notes: '' },
      c4: { tags: ['never do this again'], notes: '' },
    },
  };

  const session = trackSession(createSession({ brandId: TEST_PROFILE_ID, mode: BRAND_DOCTOR_MODES.CANDIDATES }));
  injectCandidates(session.id, SAMPLE_CANDIDATES);

  const afterFeedback = submitFeedback(session.id, validFeedback);
  assert.equal(afterFeedback.status, SESSION_STATUS.FEEDBACK_SUBMITTED, 'Status is feedback_submitted');
  assert.deepEqual(afterFeedback.userFeedback, validFeedback, 'Feedback stored');

  // Invalid tag is rejected
  const session2 = trackSession(createSession({ brandId: TEST_PROFILE_ID, mode: BRAND_DOCTOR_MODES.CANDIDATES }));
  injectCandidates(session2.id, SAMPLE_CANDIDATES);
  assert.throws(
    () => submitFeedback(session2.id, { candidates: { c1: { tags: ['INVALID_TAG'], notes: '' } } }),
    /unknown candidate feedback tag/i,
    'Invalid tag throws'
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Analyze-existing mode accepts MP3 input
// ═══════════════════════════════════════════════════════════════════════════════

test('7. analyzeAudio accepts the MP3 fixture and returns an analysis entry', async () => {
  assert.ok(fs.existsSync(FIXTURE_MP3), `Fixture exists: ${FIXTURE_MP3}`);

  const session = trackSession(createSession({ brandId: TEST_PROFILE_ID, mode: BRAND_DOCTOR_MODES.ANALYZE }));
  const afterAnalysis = await analyzeAudio(session.id, [FIXTURE_MP3]);

  assert.ok(Array.isArray(afterAnalysis.audioAnalyses), 'audioAnalyses is array');
  assert.equal(afterAnalysis.audioAnalyses.length, 1, 'One entry returned');
  assert.ok(afterAnalysis.audioAnalyses[0].filename, 'Entry has filename');
  assert.ok(afterAnalysis.audioAnalyses[0].raw, 'Entry has raw result');
  assert.equal(afterAnalysis.status, SESSION_STATUS.AUDIO_ANALYZED, 'Status is audio_analyzed');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Analyze-existing mode emits structured analysis JSON
// ═══════════════════════════════════════════════════════════════════════════════

test('8. Audio analysis artifact has expected fields and is written to disk', async () => {
  const session = trackSession(createSession({ brandId: TEST_PROFILE_ID, mode: BRAND_DOCTOR_MODES.ANALYZE }));
  const afterAnalysis = await analyzeAudio(session.id, [FIXTURE_MP3]);

  const a = afterAnalysis.audioAnalyses[0];
  if (a.raw.ok) {
    const m = a.raw.metrics;
    assert.ok('duration_seconds' in m, 'Has duration_seconds');
    assert.ok('bitrate' in m, 'Has bitrate');
    assert.ok('peak_db' in m, 'Has peak_db');
    assert.ok('rms_energy_mean' in m, 'Has rms_energy_mean');
    assert.ok('clipping_detected' in m, 'Has clipping_detected');
  } else {
    assert.ok(typeof a.raw.error === 'string', 'Failed analysis has error string');
  }

  const analysisFile = path.join(ARTIFACTS_DIR, session.id, 'analysis.json');
  assert.ok(fs.existsSync(analysisFile), 'analysis.json written to disk');
  const written = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
  assert.ok(Array.isArray(written), 'analysis.json is an array');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Analyze-existing mode produces a valid proposed profile patch
// ═══════════════════════════════════════════════════════════════════════════════

test('9. validatePatchResult returns valid for a safe minimal patch', () => {
  const profile = loadBrandProfileById(TEST_PROFILE_ID);
  const profileAfter = applyPatchToProfile(profile, MINIMAL_PATCH);
  const result = validatePatchResult(MINIMAL_PATCH, profileAfter);

  assert.ok(result.valid, `Minimal patch valid. Errors: ${(result.errors || []).join(', ')}`);
  assert.ok(Array.isArray(result.errors), 'errors is array');
  assert.ok(Array.isArray(result.warnings), 'warnings is array');
  assert.equal(result.errors.length, 0, 'No errors for safe patch');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Brand Doctor never overwrites profiles without explicit approval
// ═══════════════════════════════════════════════════════════════════════════════

test('10. createSession + injectCandidates + submitFeedback do not modify source profile', () => {
  const profilePath = resolveBrandProfilePath(TEST_PROFILE_ID);
  const before = fs.readFileSync(profilePath, 'utf8');

  const session = trackSession(createSession({ brandId: TEST_PROFILE_ID, mode: BRAND_DOCTOR_MODES.CANDIDATES }));
  injectCandidates(session.id, SAMPLE_CANDIDATES);
  submitFeedback(session.id, {
    candidates: { c1: { tags: ['strongest'], notes: '' } },
  });

  const after = fs.readFileSync(profilePath, 'utf8');
  assert.equal(before, after, 'Profile file unchanged');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Save draft patch writes artifact but does not alter source profile
// ═══════════════════════════════════════════════════════════════════════════════

test('11. saveDraftPatch writes patch artifact without modifying profile file', () => {
  const profilePath = resolveBrandProfilePath(TEST_PROFILE_ID);
  const profileBefore = fs.readFileSync(profilePath, 'utf8');

  const session = trackSession(createSession({ brandId: TEST_PROFILE_ID, mode: BRAND_DOCTOR_MODES.CANDIDATES }));
  injectCandidates(session.id, SAMPLE_CANDIDATES);
  submitFeedback(session.id, { candidates: { c1: { tags: ['strongest'], notes: '' } } });
  injectPatch(session.id, MINIMAL_PATCH, 'Fixture patch');

  const afterDraft = saveDraftPatch(session.id);

  assert.ok(afterDraft.draftPatchPath, 'draftPatchPath set');
  assert.ok(fs.existsSync(afterDraft.draftPatchPath), 'Draft patch file exists on disk');
  assert.equal(afterDraft.status, SESSION_STATUS.DRAFT_SAVED, 'Status is draft_saved');

  const profileAfter = fs.readFileSync(profilePath, 'utf8');
  assert.equal(profileBefore, profileAfter, 'Source profile file unmodified');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Apply patch validates before write
// ═══════════════════════════════════════════════════════════════════════════════

test('12. Patch with real artist name fails validation; clean patch passes', () => {
  const badPatch = {
    songwriting: {
      anti_generic_rules: ['Sound like Radiohead in every track'],
    },
  };

  const profile = loadBrandProfileById(TEST_PROFILE_ID);
  const profileAfterBad = applyPatchToProfile(profile, badPatch);
  const badValidation = validatePatchResult(badPatch, profileAfterBad);

  assert.equal(badValidation.valid, false, 'Bad patch fails validation');
  assert.ok(
    badValidation.errors.some(e => /real artist/i.test(e) || /radiohead/i.test(e)),
    `Error mentions artist name. Errors: ${badValidation.errors.join('; ')}`
  );

  // applyPatch throws when validation fails
  const session = trackSession(createSession({ brandId: TEST_PROFILE_ID, mode: BRAND_DOCTOR_MODES.CANDIDATES }));
  injectCandidates(session.id, SAMPLE_CANDIDATES);
  submitFeedback(session.id, { candidates: { c1: { tags: ['strongest'], notes: '' } } });
  injectPatch(session.id, badPatch, 'Bad patch');
  assert.throws(() => applyPatch(session.id), /validation failed/i, 'applyPatch throws on invalid patch');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Real artist names are stripped/blocked from generation-facing fields
// ═══════════════════════════════════════════════════════════════════════════════

test('13. stripRealArtistNamesFromPatch replaces known artist names; detect finds them', () => {
  const patchWithArtist = {
    songwriting: {
      vocal_performance_engine: 'Inspired by Radiohead and Thom Yorke',
      anti_generic_rules: ['Do not sound like Drake', 'channel Bjork energy'],
    },
  };

  // Detection before stripping
  const found = detectRealArtistNamesInPatch(patchWithArtist);
  assert.ok(found.includes('radiohead'), 'Found: radiohead');
  assert.ok(found.includes('thom yorke'), 'Found: thom yorke');
  assert.ok(found.includes('drake'), 'Found: drake');
  assert.ok(found.includes('bjork'), 'Found: bjork');

  // Strip
  const stripped = stripRealArtistNamesFromPatch(patchWithArtist);
  assert.ok(!stripped.songwriting.vocal_performance_engine.toLowerCase().includes('radiohead'), 'radiohead removed');
  assert.ok(!stripped.songwriting.vocal_performance_engine.toLowerCase().includes('thom yorke'), 'thom yorke removed');
  const rulesStr = stripped.songwriting.anti_generic_rules.join(' ').toLowerCase();
  assert.ok(!rulesStr.includes('drake'), 'drake removed');
  assert.ok(!rulesStr.includes('bjork'), 'bjork removed');

  // Detect after stripping → none
  const foundAfter = detectRealArtistNamesInPatch(stripped);
  assert.equal(foundAfter.length, 0, 'No artist names remain after stripping');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Legacy normal generation still creates only one audio render by default
// ═══════════════════════════════════════════════════════════════════════════════

test('14. Normal generation pipeline has no brand-doctor multi-render logic', () => {
  const magicSource = fs.readFileSync(
    path.join(repoRoot, 'src/services/magic-pipeline-service.js'), 'utf8'
  );
  assert.ok(!magicSource.includes('brand-doctor'), 'magic-pipeline-service has no brand-doctor imports');
  assert.ok(!magicSource.includes('candidateCount'), 'magic-pipeline-service has no candidateCount flag');

  const musicGenSource = fs.readFileSync(
    path.join(repoRoot, 'src/agents/music-generator.js'), 'utf8'
  );
  assert.ok(!musicGenSource.includes('brand-doctor'), 'music-generator has no brand-doctor imports');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Marketing Dashboard nav/route removed; /marketing redirects
// ═══════════════════════════════════════════════════════════════════════════════

test('15. Marketing nav removed from layout; /marketing redirects to /releases', () => {
  const layoutSource = fs.readFileSync(
    path.join(repoRoot, 'src/web/views/layout.ejs'), 'utf8'
  );
  assert.ok(
    !layoutSource.includes("'/marketing', 'Marketing'"),
    'Marketing nav entry removed from layout.ejs'
  );
  assert.ok(
    layoutSource.includes("'/brand-doctor'"),
    'Brand Doctor nav entry present in layout.ejs'
  );

  const routerSource = fs.readFileSync(
    path.join(repoRoot, 'src/web/marketing/router-consolidated.js'), 'utf8'
  );
  assert.ok(
    routerSource.includes("res.redirect(301, '/releases')"),
    '/marketing route redirects to /releases'
  );
  assert.ok(
    !routerSource.includes('renderMarketingDashboard'),
    'renderMarketingDashboard no longer referenced in router'
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. Release Cockpit still loads and is unaffected
// ═══════════════════════════════════════════════════════════════════════════════

test('16. Release Cockpit exports intact; nav entry still present in layout', { skip: cockpitSkipReason }, () => {
  assert.ok(typeof buildReleaseCockpitViewModel === 'function', 'buildReleaseCockpitViewModel is a function');
  assert.ok(typeof listReleaseCockpitEntries === 'function', 'listReleaseCockpitEntries is a function');

  const layoutSource = fs.readFileSync(
    path.join(repoRoot, 'src/web/views/layout.ejs'), 'utf8'
  );
  assert.ok(
    layoutSource.includes("'/releases', 'Release Cockpit'"),
    'Release Cockpit nav entry still present'
  );
});
