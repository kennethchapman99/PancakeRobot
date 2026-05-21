#!/usr/bin/env node

import {
  clearDistroKidQueue,
  listQueuedDistroKidJobs,
  queueSongForDistroKid,
} from '../../src/shared/distrokid-jobs.js';
import { parseArgs, splitCsv } from './lib.mjs';

const { values } = parseArgs({
  'song-id': { type: 'string' },
  'song-ids': { type: 'string' },
  clear: { type: 'string' },
  list: { type: 'boolean' },
  limit: { type: 'string', default: '50' },
  force: { type: 'boolean' },
  notes: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

if (values.help) {
  printUsage();
  process.exit(0);
}

try {
  if (values.list) {
    const jobs = listQueuedDistroKidJobs(Number(values.limit) || 50);
    if (!jobs.length) {
      console.log('No active DistroKid jobs.');
      process.exit(0);
    }
    for (const job of jobs) {
      console.log(`${job.song_id}\t${job.status}\tpriority=${job.priority}\t${job.package_path || ''}`);
    }
    process.exit(0);
  }

  if (values.clear) {
    const job = clearDistroKidQueue(values.clear.trim(), values.notes || null);
    console.log(`Cleared DistroKid queue: ${job.song_id} -> ${job.status}`);
    console.log('Next: npm run distrokid:queue -- --list');
    process.exit(0);
  }

  const songIds = values['song-ids'] ? splitCsv(values['song-ids']) : splitCsv(values['song-id']);
  if (!songIds.length) {
    printUsage();
    process.exit(1);
  }

  for (const songId of songIds) {
    const job = queueSongForDistroKid(songId, {
      force: values.force === true,
      notes: values.notes || null,
    });
    console.log(`Queued ${songId}: ${job.status}`);
  }

  console.log('');
  console.log('Next commands:');
  console.log('  npm run distrokid:queue -- --list');
  console.log('  npm run distrokid:run-queued -- --limit 5 --dry-run');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
}

function printUsage() {
  console.error('Usage:');
  console.error('  npm run distrokid:queue -- --song-id SONG_ID');
  console.error('  npm run distrokid:queue -- --song-ids SONG_1,SONG_2');
  console.error('  npm run distrokid:queue -- --list');
  console.error('  npm run distrokid:queue -- --clear SONG_ID');
}
