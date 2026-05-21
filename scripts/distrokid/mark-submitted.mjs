#!/usr/bin/env node

import { markSongSubmittedToDistroKid } from '../../src/shared/distrokid-release.js';
import { parseArgs } from './lib.mjs';

const { values } = parseArgs({
  'song-id': { type: 'string' },
  'distrokid-url': { type: 'string' },
  notes: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

if (values.help || !values['song-id'] || !values['distrokid-url']) {
  console.error('Usage:');
  console.error('  bash scripts/pancake.sh distrokid:mark-submitted --song-id SONG_ID --distrokid-url URL');
  console.error('  bash scripts/pancake.sh distrokid:mark-submitted --song-id SONG_ID --distrokid-url URL --notes "..."');
  process.exit(values.help ? 0 : 1);
}

try {
  const result = markSongSubmittedToDistroKid(values['song-id'].trim(), {
    distrokid_url: values['distrokid-url'].trim(),
    notes: values.notes || '',
  });

  console.log('PASS: song marked submitted to DistroKid.');
  console.log(`Song ID: ${result.song_id}`);
  console.log(`Status: ${result.status}`);
  console.log(`DistroKid URL: ${result.distrokid_url}`);
  console.log(`Log: output/release-packages/${result.song_id}/distrokid-submission.json`);
  console.log('Next: continue with marketing/outreach once store links and release timing are confirmed.');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
}
