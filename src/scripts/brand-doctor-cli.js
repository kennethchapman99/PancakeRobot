#!/usr/bin/env node
/**
 * Brand Doctor CLI
 *
 * Usage (via pancakerobot launcher):
 *   pancakerobot brand-doctor --profile <brand-id> --mode candidates
 *   pancakerobot brand-doctor --profile <brand-id> --mode candidates --dry-run
 *   pancakerobot brand-doctor --profile <brand-id> --mode analyze --input <mp3-path>
 *   pancakerobot brand-doctor --profile <brand-id> --mode analyze --input <mp3-path> --dry-run
 *
 * --dry-run prints the proposed patch to stdout without writing anything.
 * Profiles are never overwritten without explicit confirmation.
 */

import 'dotenv/config';
import readline from 'readline';
import {
  createSession,
  generateCandidates,
  analyzeAudio,
  enrichAnalysisWithImplications,
  submitFeedback,
  proposePatch,
  saveDraftPatch,
  applyPatch,
  rejectSession,
  BRAND_DOCTOR_MODES,
  SESSION_STATUS,
  CANDIDATE_FEEDBACK_TAGS,
  SONG_ANALYSIS_TAGS,
} from '../services/brand-doctor-service.js';
import { listBrandProfiles } from '../shared/brand-profile.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') flags.dryRun = true;
    else if (args[i] === '--profile' && args[i + 1]) { flags.profile = args[i + 1]; i++; }
    else if (args[i] === '--mode' && args[i + 1]) { flags.mode = args[i + 1]; i++; }
    else if (args[i] === '--input' && args[i + 1]) {
      if (!flags.inputs) flags.inputs = [];
      flags.inputs.push(args[i + 1]);
      i++;
    }
    else if (args[i] === '--session' && args[i + 1]) { flags.sessionId = args[i + 1]; i++; }
    else if (args[i] === '--list') flags.list = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`
Brand Doctor CLI

Usage:
  pancakerobot brand-doctor --profile <brand-id> --mode candidates
  pancakerobot brand-doctor --profile <brand-id> --mode candidates --dry-run
  pancakerobot brand-doctor --profile <brand-id> --mode analyze --input <mp3>
  pancakerobot brand-doctor --profile <brand-id> --mode analyze --input <mp3> --dry-run
  pancakerobot brand-doctor --list

Options:
  --profile <id>   Brand profile ID (see: pancakerobot brand-doctor --list)
  --mode           "candidates" or "analyze"
  --input <path>   Path to an MP3/audio file (may be repeated; analyze mode only)
  --dry-run        Show proposed patch without writing anything
  --list           List brand profiles
  --session <id>   Resume an existing session (skips create/generate)
  --help           Show this help
  `);
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function collectCandidateFeedback(rl, candidates) {
  console.log('\nRate each candidate direction. Enter tags separated by commas.');
  console.log(`Valid tags: ${CANDIDATE_FEEDBACK_TAGS.join(', ')}\n`);

  const feedback = { candidates: {} };

  for (const c of candidates) {
    console.log(`\n--- ${c.id}: ${c.name} ---`);
    console.log(`  Testing: ${c.testing}`);
    console.log(`  Vocal: ${c.vocal_identity}`);
    console.log(`  Hook: ${c.hook_behavior}`);

    const raw = await askQuestion(rl, `  Tags (or Enter to skip): `);
    const tags = raw ? raw.split(',').map(t => t.trim()).filter(t => CANDIDATE_FEEDBACK_TAGS.includes(t)) : [];
    const notes = await askQuestion(rl, `  Notes (optional): `);

    if (tags.length > 0 || notes) {
      feedback.candidates[c.id] = { tags, notes };
    } else {
      feedback.candidates[c.id] = { tags: [], notes: '' };
    }
  }

  return feedback;
}

async function collectAudioFeedback(rl, analyses) {
  console.log('\nTag each song. Enter tags separated by commas.');
  console.log(`Valid tags: ${SONG_ANALYSIS_TAGS.join(', ')}\n`);

  const feedback = { songs: {} };

  for (const a of analyses) {
    console.log(`\n--- ${a.filename} ---`);
    if (a.raw?.ok) {
      const m = a.raw.metrics;
      console.log(`  Duration: ${m.duration_seconds ? Math.round(m.duration_seconds) + 's' : 'unknown'}`);
      console.log(`  RMS mean: ${m.rms_energy_mean ?? '?'} dB | Peak: ${m.peak_db ?? '?'} dB`);
    }
    if (a.brandImplications?.file_summary) {
      console.log(`  Summary: ${a.brandImplications.file_summary}`);
    }

    const raw = await askQuestion(rl, `  Tags (or Enter to skip): `);
    const tags = raw ? raw.split(',').map(t => t.trim()).filter(t => SONG_ANALYSIS_TAGS.includes(t)) : [];
    const notes = await askQuestion(rl, `  Notes (optional): `);

    feedback.songs[a.filename] = { tags, notes };
  }

  return feedback;
}

async function main() {
  const flags = parseArgs(process.argv);

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  if (flags.list) {
    const profiles = listBrandProfiles();
    console.log('\nAvailable brand profiles:');
    for (const p of profiles) {
      console.log(`  ${p.id.padEnd(20)} ${p.name}${p.isDefault ? ' (default)' : ''}`);
    }
    process.exit(0);
  }

  if (!flags.profile) {
    console.error('Error: --profile <brand-id> is required');
    printHelp();
    process.exit(1);
  }

  if (!flags.mode || !Object.values(BRAND_DOCTOR_MODES).includes(flags.mode)) {
    console.error(`Error: --mode must be one of: ${Object.values(BRAND_DOCTOR_MODES).join(', ')}`);
    process.exit(1);
  }

  if (flags.mode === BRAND_DOCTOR_MODES.ANALYZE && (!flags.inputs || flags.inputs.length === 0)) {
    console.error('Error: --input <mp3-path> is required for analyze mode');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Create or resume session
    let session;
    if (flags.sessionId) {
      const { loadSession } = await import('../services/brand-doctor-service.js');
      session = loadSession(flags.sessionId);
      console.log(`\nResuming session: ${session.id} (status: ${session.status})`);
    } else {
      console.log(`\nCreating Brand Doctor session for profile "${flags.profile}" in ${flags.mode} mode...`);
      session = createSession({ brandId: flags.profile, mode: flags.mode });
      console.log(`Session created: ${session.id}`);
      console.log(`Artifacts: ${process.cwd()}/artifacts/brand-doctor/${session.id}/`);
    }

    const { brand_name, genre_style_center } = session.currentProfileSummary;
    console.log(`\nBrand: ${brand_name} (${genre_style_center})`);
    if (session.currentProfileSummary.weak_areas?.length) {
      console.log(`Weak areas detected: ${session.currentProfileSummary.weak_areas.join('; ')}`);
    }

    // --- CANDIDATES MODE ---
    if (flags.mode === BRAND_DOCTOR_MODES.CANDIDATES) {
      if (session.status === SESSION_STATUS.IN_PROGRESS) {
        console.log('\nGenerating candidate directions (text-only)...');
        session = await generateCandidates(session.id);
      }

      console.log(`\n${session.candidateDirections.length} candidate directions generated.\n`);
      for (const c of session.candidateDirections) {
        console.log(`  [${c.id}] ${c.name}`);
        console.log(`       Testing: ${c.testing}`);
      }

      if (flags.dryRun) {
        console.log('\n[dry-run] Skipping feedback and patch proposal.');
        console.log('Session artifacts saved to:', `artifacts/brand-doctor/${session.id}/`);
        rl.close();
        return;
      }

      const feedback = await collectCandidateFeedback(rl, session.candidateDirections);
      console.log('\nSubmitting feedback...');
      session = submitFeedback(session.id, feedback);

      console.log('\nProposing profile patch...');
      session = await proposePatch(session.id);
    }

    // --- ANALYZE MODE ---
    if (flags.mode === BRAND_DOCTOR_MODES.ANALYZE) {
      if (session.status === SESSION_STATUS.IN_PROGRESS) {
        console.log('\nRunning audio analysis...');
        session = await analyzeAudio(session.id, flags.inputs);
        console.log('\nEnriching analysis with brand implications...');
        try {
          session = await enrichAnalysisWithImplications(session.id);
        } catch (e) {
          console.warn(`Warning: enrichment failed (non-fatal): ${e.message}`);
        }
      }

      console.log(`\n${session.audioAnalyses.length} file(s) analyzed.`);

      if (flags.dryRun) {
        for (const a of session.audioAnalyses) {
          console.log(`\n  ${a.filename}`);
          if (a.brandImplications?.file_summary) console.log(`    ${a.brandImplications.file_summary}`);
        }
        console.log('\n[dry-run] Skipping feedback and patch proposal.');
        rl.close();
        return;
      }

      const feedback = await collectAudioFeedback(rl, session.audioAnalyses);
      console.log('\nSubmitting feedback...');
      session = submitFeedback(session.id, feedback);

      console.log('\nProposing profile patch...');
      session = await proposePatch(session.id);
    }

    // --- PATCH REVIEW ---
    console.log('\n===== PROPOSED PATCH =====');
    console.log(JSON.stringify(session.proposedPatch, null, 2));
    console.log('\n===== EXPLANATION =====');
    console.log(session.patchExplanation);
    console.log('\n===== VALIDATION =====');
    const v = session.validationResult;
    if (v.valid) {
      console.log('✅ Valid');
    } else {
      console.log('❌ Validation errors:');
      for (const e of v.errors) console.log(`  - ${e}`);
    }
    if (v.warnings?.length) {
      for (const w of v.warnings) console.log(`  ⚠️  ${w}`);
    }

    if (!v.valid) {
      console.log('\nPatch is invalid. Session saved as draft.');
      saveDraftPatch(session.id);
      rl.close();
      return;
    }

    const choice = await askQuestion(rl, '\nApply patch? [apply / draft / reject]: ');

    if (choice === 'apply') {
      console.log('\nApplying patch...');
      session = applyPatch(session.id);
      console.log('✅ Patch applied. Profile updated.');
    } else if (choice === 'draft') {
      console.log('\nSaving draft patch...');
      session = saveDraftPatch(session.id);
      console.log(`Draft saved: artifacts/brand-doctor/${session.id}/patch.json`);
    } else {
      console.log('\nRejecting session...');
      session = rejectSession(session.id);
      console.log('Session rejected. No changes made.');
    }

    console.log(`\nSession: artifacts/brand-doctor/${session.id}/session.json`);

  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
