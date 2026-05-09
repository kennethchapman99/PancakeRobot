#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getMissingPricingEntries,
  getRecentFinanceOverview,
  getRunFinanceSummary,
  getSongFinanceSummary,
  readCostEventsForSong,
  syncSongFinanceArtifacts,
  syncSongFinanceFromRuns,
  writeSongFinanceSummary,
} from '../shared/finance-manager.js';
import { getSong } from '../shared/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SONGS_DIR = path.resolve(__dirname, '../../output/songs');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else args[key] = argv[++i];
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printSummary(summary) {
  if (summary.requested_song_id && summary.requested_song_id !== summary.song_id) {
    console.log(`Resolved song: ${summary.requested_song_id} → ${summary.song_id}`);
  }
  console.log(`Total incurred cost: $${Number(summary.total_cost_usd || 0).toFixed(4)}`);
  console.log(`Final asset cost:     $${Number(summary.total_final_asset_cost_usd || 0).toFixed(4)}`);
  console.log(`Retry/waste/unknown:  $${Number(summary.total_failed_retry_cost_usd || 0).toFixed(4)}`);
  console.log(`Events:               ${summary.event_count || 0}`);
  if (summary.backfilled_from_runs_since) {
    console.log(`Backfilled runs since: ${summary.backfilled_from_runs_since}`);
  }
  if (summary.warnings?.length) {
    console.log('\nWarnings:');
    for (const warning of summary.warnings) console.log(`- ${warning}`);
  }
  const stepRows = Object.entries(summary.by_pipeline_step || {})
    .sort((a, b) => Number(b[1].cost_usd || 0) - Number(a[1].cost_usd || 0));
  if (stepRows.length) {
    console.log('\nBy pipeline step:');
    for (const [step, value] of stepRows) {
      console.log(`- ${step}: $${Number(value.cost_usd || 0).toFixed(4)} (${value.count} event${value.count === 1 ? '' : 's'})`);
    }
  }
}

function resolveSongId(input) {
  const requested = String(input || '').trim();
  if (!requested) return { songId: requested, song: null };

  const directSong = safeGetSong(requested);
  if (directSong) return { songId: requested, song: directSong };

  const prefixed = requested.startsWith('SONG_') ? requested : `SONG_${requested}`;
  const prefixedSong = safeGetSong(prefixed);
  if (prefixedSong) return { songId: prefixed, song: prefixedSong };

  const folderMatch = findSongFolder(requested);
  if (folderMatch) return { songId: folderMatch, song: safeGetSong(folderMatch) };

  return { songId: prefixed, song: null };
}

function safeGetSong(songId) {
  try { return getSong(songId); } catch { return null; }
}

function findSongFolder(input) {
  if (!fs.existsSync(SONGS_DIR)) return null;
  const folders = fs.readdirSync(SONGS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  return folders.find(folder => folder === input)
    || folders.find(folder => folder === `SONG_${input}`)
    || folders.find(folder => folder.endsWith(input))
    || null;
}

async function syncForSong(inputSongId, { since } = {}) {
  const resolved = resolveSongId(inputSongId);
  const sinceIso = since || resolved.song?.created_at || null;

  syncSongFinanceArtifacts(resolved.songId);
  if (sinceIso) await syncSongFinanceFromRuns({ songId: resolved.songId, sinceIso });

  const summary = getSongFinanceSummary(resolved.songId);
  summary.requested_song_id = inputSongId;
  if (sinceIso) summary.backfilled_from_runs_since = sinceIso;
  if (!resolved.song) {
    summary.warnings = [
      ...(summary.warnings || []),
      `Song was not found in the DB. Resolved to ${resolved.songId}; only filesystem artifact costs can be synced unless you pass --since.`,
    ];
  }
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'summary';

  if (command === 'summary') {
    if (args.song) {
      const summary = await syncForSong(args.song, { since: args.since });
      return args.json ? printJson(summary) : printSummary(summary);
    }
    if (args.run) {
      const summary = getRunFinanceSummary(args.run);
      return args.json ? printJson(summary) : printSummary(summary);
    }
    console.error('Usage: npm run finance:summary -- --song SONG_ID [--since ISO] [--json]');
    console.error('   or: npm run finance:summary -- --run RUN_ID [--json]');
    process.exitCode = 1;
    return;
  }

  if (command === 'audit') {
    const overview = getRecentFinanceOverview({ limit: Number(args.limit) || 50 });
    return printJson(overview);
  }

  if (command === 'missing-prices') {
    if (args.song) {
      const summary = await syncForSong(args.song, { since: args.since });
      return printJson(getMissingPricingEntries(summary.events || readCostEventsForSong(summary.song_id)));
    }
    const overview = getRecentFinanceOverview({ limit: Number(args.limit) || 500 });
    const allEvents = overview.rows.flatMap(row => row.events || []);
    return printJson(getMissingPricingEntries(allEvents));
  }

  if (command === 'reprice') {
    if (!args.song) {
      console.error('Usage: npm run finance:reprice -- --song SONG_ID');
      process.exitCode = 1;
      return;
    }
    const resolved = resolveSongId(args.song);
    syncSongFinanceArtifacts(resolved.songId);
    const summary = writeSongFinanceSummary(resolved.songId);
    summary.requested_song_id = args.song;
    return args.json ? printJson(summary) : printSummary(summary);
  }

  console.error(`Unknown finance command: ${command}`);
  console.error('Commands: summary, audit, missing-prices, reprice');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
