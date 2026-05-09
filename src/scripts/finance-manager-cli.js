#!/usr/bin/env node

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
  console.log(`Total incurred cost: $${Number(summary.total_cost_usd || 0).toFixed(4)}`);
  console.log(`Final asset cost:     $${Number(summary.total_final_asset_cost_usd || 0).toFixed(4)}`);
  console.log(`Retry/waste/unknown:  $${Number(summary.total_failed_retry_cost_usd || 0).toFixed(4)}`);
  console.log(`Events:               ${summary.event_count || 0}`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'summary';

  if (command === 'summary') {
    if (args.song) {
      syncSongFinanceArtifacts(args.song);
      if (args.since) await syncSongFinanceFromRuns({ songId: args.song, sinceIso: args.since });
      const summary = getSongFinanceSummary(args.song);
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
      syncSongFinanceArtifacts(args.song);
      return printJson(getMissingPricingEntries(readCostEventsForSong(args.song)));
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
    syncSongFinanceArtifacts(args.song);
    const summary = writeSongFinanceSummary(args.song);
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
