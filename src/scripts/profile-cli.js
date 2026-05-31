#!/usr/bin/env node
/**
 * Profile CLI — interactive enrichment and linting for brand profiles.
 *
 * Usage (via pancakerobot launcher):
 *   pancakerobot profile enrich --interactive
 *   pancakerobot profile enrich --profile <id> --interactive
 *   pancakerobot profile enrich --all --interactive
 *   pancakerobot profile enrich --profile <id> --dry-run
 *   pancakerobot profile enrich --all --dry-run        (makes N LLM calls — see cost note)
 *   pancakerobot profile enrich --profile <id> --offline --dry-run  (deterministic, no API)
 *   pancakerobot profile lint
 *   pancakerobot profile lint --profile <id>
 *
 * --offline uses the deterministic enrichProfileProposal() (no API cost, but generic output).
 * Default (without --offline) calls the LLM enricher per profile.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import {
  listBrandProfiles,
  loadBrandProfileById,
  saveBrandProfileById,
  getBrandProfilesDir,
  validateBrandProfile,
} from '../shared/brand-profile.js';
import { enrichProfileProposal, lintProfile } from '../shared/profile-enrichment.js';
import { enrichProfileWithLLM } from '../agents/profile-enricher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const DRAFTS_DIR = path.join(ROOT_DIR, 'output', 'profile-drafts');

function parseArgs(argv) {
  const args = argv.slice(2);
  const subcommand = args[0] || 'help';
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--interactive') flags.interactive = true;
    else if (args[i] === '--dry-run') flags.dryRun = true;
    else if (args[i] === '--all') flags.all = true;
    else if (args[i] === '--draft') flags.draft = true;
    else if (args[i] === '--offline') flags.offline = true;
    else if (args[i] === '--profile' && args[i + 1]) { flags.profile = args[i + 1]; i++; }
    else if (args[i] === '--json') flags.json = true;
  }
  return { subcommand, flags };
}

async function main() {
  const { subcommand, flags } = parseArgs(process.argv);

  switch (subcommand) {
    case 'enrich': return runEnrich(flags);
    case 'lint': return runLint(flags);
    case 'help':
    default:
      printHelp();
      return;
  }
}

function printHelp() {
  console.log(`
Profile CLI — enrich and lint Pancake Robot brand profiles.

Commands:
  enrich   Propose and apply enriched performance-identity fields
  lint     Check profiles for missing/generic/unsafe fields

enrich flags:
  --profile <id>   Enrich one profile
  --all            Enrich all profiles
  --interactive    Ask for notes + approval before each write (default behavior)
  --dry-run        Print proposal and diff; never write
  --draft          Write to output/profile-drafts/ instead of profile file
  --offline        Use deterministic templates (no LLM call, no API cost)

lint flags:
  --profile <id>   Lint one profile
  --json           Output results as JSON

Examples:
  pancakerobot profile enrich --profile basement-cypher --interactive
  pancakerobot profile enrich --all --dry-run
  pancakerobot profile enrich --all --offline --dry-run    (free, no API)
  pancakerobot profile lint
  pancakerobot profile lint --profile doechii
`);
}

async function runEnrich(flags) {
  const profiles = flags.profile
    ? [{ id: flags.profile, name: flags.profile }]
    : flags.all
      ? listBrandProfiles().filter(p => !p.isDefault)
      : (() => {
          printHelp();
          console.error('\nError: provide --profile <id> or --all');
          process.exit(1);
        })();

  const needStdin = !flags.dryRun;
  const rl = needStdin ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

  const useOffline = flags.offline;
  if (!useOffline && !flags.dryRun) {
    console.log(`\nUsing LLM enricher (use --offline for free deterministic templates).`);
  } else if (!useOffline && flags.dryRun) {
    console.log(`\nDry-run with LLM enricher — will call the API but not write any files.`);
    if (flags.all) {
      console.log(`NOTE: --all --dry-run will make one LLM call per profile (~$0.05-0.15 each).`);
    }
  }

  let enrichedCount = 0;
  let skippedCount = 0;

  for (const profileMeta of profiles) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Profile: ${profileMeta.name} (${profileMeta.id})`);
    console.log('─'.repeat(60));

    let profile;
    try {
      profile = loadBrandProfileById(profileMeta.id);
    } catch (err) {
      console.error(`  ✗ Failed to load: ${err.message}`);
      skippedCount++;
      continue;
    }

    console.log(`\nBrand: ${profile.brand_name}`);
    if (profile.display_name && profile.display_name !== profile.brand_name) {
      console.log(`Display: ${profile.display_name}`);
    }
    console.log(`Character: ${profile.character?.name}`);
    console.log(`Style: ${profile.music?.default_style}`);
    console.log(`Type: ${profile.songwriting?.song_type || '(not set)'}`);

    // Check which fields are already present.
    const sw = profile.songwriting || {};
    const ENRICHED_KEYS = ['vocal_performance_engine', 'performance_conceit_bank', 'album_mode_lanes', 'song_differentiation_rules', 'anti_generic_rules', 'do_not_repeat_across_album', 'hidden_brief_requirements'];
    const missingKeys = ENRICHED_KEYS.filter(k => !sw[k] || (Array.isArray(sw[k]) && sw[k].length === 0));

    if (missingKeys.length === 0) {
      console.log('\n  ✓ Profile already has all enriched fields — nothing to add.');
      skippedCount++;
      continue;
    }

    console.log(`\nMissing enriched fields: ${missingKeys.join(', ')}`);

    // Collect user notes (interactive only).
    let userNotes = '';
    if (flags.interactive && rl && !useOffline) {
      console.log('');
      userNotes = await askFreeText(rl, 'Notes for LLM enricher (describe anything specific about how this artist sounds, production style, quirks — press Enter to skip):\n> ');
    }

    // Generate proposal.
    let proposal;
    try {
      if (useOffline) {
        proposal = enrichProfileProposal(profile);
        // Filter to only missing keys
        const filtered = {};
        for (const k of missingKeys) {
          if (proposal.songwriting[k] !== undefined) filtered[k] = proposal.songwriting[k];
        }
        proposal = { songwriting: filtered };
      } else {
        process.stdout.write('\nGenerating enrichment via LLM...');
        proposal = await enrichProfileWithLLM(profile, { userNotes });
        // Filter to only missing keys
        const filtered = {};
        for (const k of missingKeys) {
          if (proposal.songwriting[k] !== undefined) filtered[k] = proposal.songwriting[k];
        }
        proposal = { songwriting: filtered, costUsd: proposal.costUsd };
        process.stdout.write(` done${proposal.costUsd ? ` (~$${proposal.costUsd.toFixed(4)})` : ''}.\n`);
      }
    } catch (err) {
      console.error(`\n  ✗ Enrichment failed: ${err.message}`);
      if (!useOffline) {
        console.log('  Tip: use --offline for free deterministic templates.');
      }
      skippedCount++;
      continue;
    }

    const proposedKeys = Object.keys(proposal.songwriting);
    if (proposedKeys.length === 0) {
      console.log('  ✓ No new fields to propose.');
      skippedCount++;
      continue;
    }

    // Show proposal.
    console.log(`\nProposed: ${proposedKeys.join(', ')}`);
    displayProposal(proposal.songwriting);

    if (flags.dryRun) {
      console.log('\n  [DRY-RUN] No files written.');
      skippedCount++;
      continue;
    }

    // Prompt for action.
    let finalProposal = proposal;
    let approved = false;

    while (!approved) {
      const action = await askAction(rl, '\nAction: [a]pprove  [r]egenerate with new notes  [s]kip  [d]raft  [q]abort > ');

      if (action === 'q') {
        console.log('\nAborted.');
        if (rl) rl.close();
        return;
      }
      if (action === 's') {
        console.log('  Skipped.');
        skippedCount++;
        break;
      }
      if (action === 'r') {
        if (useOffline) {
          console.log('  --offline mode: cannot regenerate with LLM. Use [a] to approve or [s] to skip.');
          continue;
        }
        const newNotes = await askFreeText(rl, 'Updated notes for regeneration:\n> ');
        try {
          process.stdout.write('\nRegenerating via LLM...');
          finalProposal = await enrichProfileWithLLM(profile, { userNotes: newNotes });
          const filtered = {};
          for (const k of missingKeys) {
            if (finalProposal.songwriting[k] !== undefined) filtered[k] = finalProposal.songwriting[k];
          }
          finalProposal = { songwriting: filtered, costUsd: finalProposal.costUsd };
          process.stdout.write(` done${finalProposal.costUsd ? ` (~$${finalProposal.costUsd.toFixed(4)})` : ''}.\n`);
          displayProposal(finalProposal.songwriting);
        } catch (err) {
          console.error(`  ✗ Regeneration failed: ${err.message}`);
        }
        continue;
      }
      if (action === 'd' || flags.draft) {
        await writeDraft(profileMeta.id, profile, finalProposal);
        enrichedCount++;
        approved = true;
        break;
      }
      if (action === 'a') {
        await writeToProfile(profileMeta.id, profile, finalProposal, rl);
        enrichedCount++;
        approved = true;
        break;
      }
    }
  }

  if (rl) rl.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Enrichment complete. Applied: ${enrichedCount}, Skipped: ${skippedCount}`);
}

function displayProposal(songwriting) {
  for (const key of Object.keys(songwriting)) {
    console.log(`\n  [NEW] songwriting.${key}:`);
    const preview = JSON.stringify(songwriting[key], null, 4);
    const lines = preview.split('\n');
    const shown = lines.slice(0, 24);
    shown.forEach(l => console.log(`    ${l}`));
    if (lines.length > 24) console.log(`    ... (${lines.length - 24} more lines)`);
  }
}

async function runLint(flags) {
  const profiles = flags.profile
    ? [{ id: flags.profile, name: flags.profile }]
    : listBrandProfiles().filter(p => !p.isDefault);

  const results = [];

  for (const profileMeta of profiles) {
    let profile;
    try {
      profile = loadBrandProfileById(profileMeta.id);
    } catch (err) {
      results.push({ profileId: profileMeta.id, errors: [`Failed to load: ${err.message}`], warnings: [], score: 0, passed: false });
      continue;
    }
    results.push(lintProfile(profile, profileMeta.id));
  }

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    let hasErrors = false;
    for (const result of results) {
      console.log(`\n${result.profileId} — score: ${result.score}/100 ${result.passed ? '✓' : '✗'}`);
      if (result.errors.length > 0) {
        hasErrors = true;
        for (const e of result.errors) console.log(`  ✗ ${e}`);
      }
      if (result.warnings.length > 0) {
        for (const w of result.warnings) console.log(`  ⚠ ${w}`);
      }
      if (result.errors.length === 0 && result.warnings.length === 0) {
        console.log('  ✓ No issues found');
      }
    }
    if (hasErrors) process.exit(1);
  }
}

function askAction(rl, prompt) {
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      const a = String(answer || '').trim().toLowerCase();
      if (['a', 'r', 's', 'd', 'q'].includes(a)) resolve(a);
      else resolve('s');
    });
  });
}

function askFreeText(rl, prompt) {
  return new Promise(resolve => {
    rl.question(prompt, answer => resolve(String(answer || '').trim()));
  });
}

async function writeDraft(profileId, existingProfile, proposal) {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const draftPath = path.join(DRAFTS_DIR, `${profileId}.songwriting-draft.json`);

  const mergedSongwriting = {
    ...(existingProfile.songwriting || {}),
    ...proposal.songwriting,
  };

  const draft = {
    _draft_for_profile: profileId,
    _draft_created_at: new Date().toISOString(),
    _instruction: 'Review then apply via: pancakerobot profile enrich --profile <id> --interactive',
    existing_songwriting_keys: Object.keys(existingProfile.songwriting || {}),
    proposed_new_keys: Object.keys(proposal.songwriting),
    songwriting: mergedSongwriting,
  };

  fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');
  console.log(`  ✓ Draft saved to ${path.relative(ROOT_DIR, draftPath)}`);
}

async function writeToProfile(profileId, existingProfile, proposal, rl) {
  const updatedProfile = {
    ...existingProfile,
    songwriting: {
      ...(existingProfile.songwriting || {}),
      ...proposal.songwriting,
    },
  };

  try {
    validateBrandProfile(updatedProfile, profileId);
  } catch (err) {
    console.error(`  ✗ Validation failed after merge: ${err.message}`);
    console.log('  Saving as draft instead.');
    await writeDraft(profileId, existingProfile, proposal);
    return;
  }

  saveBrandProfileById(profileId, updatedProfile);
  console.log(`  ✓ Profile updated: config/brand-profiles/${profileId}.json`);
}

main().catch(err => {
  console.error(`Profile CLI error: ${err.message}`);
  process.exit(1);
});
