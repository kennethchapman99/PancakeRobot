#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env'), override: true });

import {
  repairAlbumBatch,
  resumeAlbumBatch,
} from '../services/album-batch-service.js';

const albumId = process.argv.find(arg => arg.startsWith('ALBUM_'));
const resume = process.argv.includes('--resume');

if (!albumId) {
  console.error('Usage: ./bin/pancakerobot album:repair ALBUM_ID');
  console.error('       ./bin/pancakerobot album:resume ALBUM_ID');
  process.exit(1);
}

try {
  const result = resume ? await resumeAlbumBatch({
    albumId,
    onEvent: (event) => {
      const label = event.line || event.message || event.type;
      if (label) console.log(`[album:${albumId}] ${label}`);
    },
  }) : await repairAlbumBatch({
    albumId,
    onEvent: (event) => {
      const label = event.line || event.message || event.type;
      if (label) console.log(`[album:${albumId}] ${label}`);
    },
  });

  if (resume) {
    const completed = result.ensured.filter(song => song.pipeline_stage === 'album_track_generated').length;
    const failed = result.ensured.filter(song => song.pipeline_stage === 'album_track_failed').length;
    const pending = result.ensured.length - completed - failed;
    console.log(JSON.stringify({
      ok: true,
      command: 'album:resume',
      albumId: result.albumId,
      status: result.status,
      totalTracks: result.plan.tracks.length,
      completed,
      failed,
      pending,
      nextTrackNumber: result.nextTrack?.track_number || null,
      nextTrackTitle: result.nextTrack?.title || null,
      generationStarted: result.generationStarted,
      authOrConfigError: result.latestError || null,
    }, null, 2));
  } else {
    console.log(JSON.stringify({
      ok: true,
      command: 'album:repair',
      albumId: result.albumId,
      totalPlannedTracks: result.plan.tracks.length,
      existingTracks: result.existingTracks,
      createdTracks: result.createdTracks,
      financeSharedCostUsd: result.financeSummary.shared_thinking_cost_usd,
      currentAlbumStatus: result.currentAlbumStatus,
      latestError: result.latestError || null,
    }, null, 2));
  }
} catch (error) {
  console.error(`[album:${albumId}] ${resume ? 'resume' : 'repair'} failed: ${error.message}`);
  process.exit(1);
}
