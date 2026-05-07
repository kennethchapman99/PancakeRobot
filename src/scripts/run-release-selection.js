#!/usr/bin/env node

import { analyzeRecentDraftSongsForReleaseSelection, analyzeSongForReleaseSelection } from '../agents/release-selection-agent.js';

const args = process.argv.slice(2);
const explicitSongIds = [];
let recent = false;
let limit = 10;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--song' && args[index + 1]) {
    explicitSongIds.push(args[index + 1]);
    index += 1;
    continue;
  }
  if (arg === '--recent') {
    recent = true;
    continue;
  }
  if (arg === '--limit' && args[index + 1]) {
    limit = Number(args[index + 1]) || limit;
    index += 1;
  }
}

if (explicitSongIds.length === 1 && !recent) {
  const result = await analyzeSongForReleaseSelection(explicitSongIds[0]);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const batch = await analyzeRecentDraftSongsForReleaseSelection({
  songIds: explicitSongIds.length ? explicitSongIds : null,
  limit,
});
console.log(JSON.stringify(batch, null, 2));

