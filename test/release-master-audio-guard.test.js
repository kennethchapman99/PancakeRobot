import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  getSelectedReleaseAudio,
  listSongAudioCandidates,
} from '../src/shared/song-audio-selection.js';
import {
  generateMusic,
  acquireGenerationLock,
  releaseGenerationLock,
  quarantinePriorMasters,
  findExistingValidAudioFile,
} from '../src/agents/music-generator.js';
import { buildDistroKidPayloadFromCockpit } from '../src/shared/distrokid-payload.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outputSongsRoot = path.join(repoRoot, 'output', 'songs');
const createdSongDirs = new Set();

function makeSongDir(slug) {
  const songId = `TEST_MASTER_GUARD_${slug}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const audioDir = path.join(outputSongsRoot, songId, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  createdSongDirs.add(path.join(outputSongsRoot, songId));
  return { songId, audioDir };
}

function writeAudio(audioDir, name, bytes = 2048) {
  const filePath = path.join(audioDir, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
  return filePath;
}

test.after(() => {
  for (const dir of createdSongDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 2/4 — Asset scoping & duplicate detection
// ---------------------------------------------------------------------------

test('single audio file resolves to one canonical master (auto)', () => {
  const { songId, audioDir } = makeSongDir('single');
  writeAudio(audioDir, 'only-track.mp3');

  const state = getSelectedReleaseAudio(songId, { assets: [] });
  assert.equal(state.status, 'auto');
  assert.equal(state.duplicate, false);
  assert.equal(state.blocking, false);
  assert.equal(state.requiresSelection, false);
  assert.equal(state.candidates.length, 1);
});

test('two audio files for one track is a BLOCKING duplicate, not a normal picker', () => {
  const { songId, audioDir } = makeSongDir('dupe');
  writeAudio(audioDir, 'all-the-clocks-are-liars.mp3');
  writeAudio(audioDir, 'everything-borrowed.mp3');

  const state = getSelectedReleaseAudio(songId, { assets: [] });
  assert.equal(state.status, 'duplicate');
  assert.equal(state.duplicate, true);
  assert.equal(state.blocking, true);
  assert.equal(state.requiresSelection, true, 'recovery picker still offered');
  assert.equal(state.candidates.length, 2);
  assert.match(state.message, /Duplicate master audio detected/i);
});

test('an explicitly selected master resolves duplicates (recovery path, no delete)', () => {
  const { songId, audioDir } = makeSongDir('resolved');
  writeAudio(audioDir, 'take-one.mp3');
  const keep = writeAudio(audioDir, 'take-two.mp3');
  const relKeep = path.relative(repoRoot, keep).replace(/\\/g, '/');

  const state = getSelectedReleaseAudio(songId, {
    assets: [{ asset_type: 'release_audio', is_current: 1, file_path: relKeep }],
  });
  assert.equal(state.status, 'selected');
  assert.equal(state.duplicate, false);
  assert.equal(state.blocking, false);
  // Both files remain on disk — nothing destroyed.
  assert.equal(fs.existsSync(path.join(audioDir, 'take-one.mp3')), true);
  assert.equal(fs.existsSync(path.join(audioDir, 'take-two.mp3')), true);
});

test('candidates are strictly scoped to the song — track A never sees track B', () => {
  const a = makeSongDir('trackA');
  const b = makeSongDir('trackB');
  writeAudio(a.audioDir, 'song-a.mp3');
  writeAudio(b.audioDir, 'song-b.mp3');

  const candA = listSongAudioCandidates(a.songId, { assets: [] });
  const names = candA.map(c => c.name);
  assert.deepEqual(names, ['song-a.mp3']);
  assert.equal(names.includes('song-b.mp3'), false);
});

// ---------------------------------------------------------------------------
// Phase 3 — Paid-generation idempotency
// ---------------------------------------------------------------------------

test('generateMusic reuses an existing master and makes NO provider call', async () => {
  const { songId, audioDir } = makeSongDir('reuse');
  writeAudio(audioDir, 'existing-master.mp3');

  let fetchCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { fetchCalls += 1; return { ok: true, json: async () => ({}) }; };
  try {
    const result = await generateMusic({
      songId,
      title: 'Existing Track',
      lyricsText: 'la la la\nsinging now',
    });
    assert.equal(result.skipped_existing_audio, true);
    assert.equal(fetchCalls, 0, 'no MiniMax call when a master already exists');
  } finally {
    global.fetch = realFetch;
  }
});

test('forceRegenerate WITHOUT confirmPaidRerender reuses and does NOT bill', async () => {
  const { songId, audioDir } = makeSongDir('forcenoconfirm');
  writeAudio(audioDir, 'existing-master.mp3');

  let fetchCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { fetchCalls += 1; return { ok: true, json: async () => ({}) }; };
  try {
    const result = await generateMusic({
      songId,
      title: 'Existing Track',
      lyricsText: 'la la la\nsinging now',
      forceRegenerate: true,
      confirmPaidRerender: false,
    });
    assert.equal(result.skipped_existing_audio, true);
    assert.equal(fetchCalls, 0, 'force without confirmation must not bill MiniMax');
  } finally {
    global.fetch = realFetch;
  }
});

test('an in-progress lock blocks a second concurrent generation from billing', async () => {
  const { songId, audioDir } = makeSongDir('locked');
  // Hold the lock as if another render were in flight.
  const held = acquireGenerationLock(audioDir);
  assert.equal(held.acquired, true);

  let fetchCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { fetchCalls += 1; return { ok: true, json: async () => ({}) }; };
  process.env.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'test-key';
  try {
    const result = await generateMusic({
      songId,
      title: 'Concurrent Track',
      lyricsText: 'la la la\nsinging now',
    });
    assert.equal(result.blocked_concurrent, true);
    assert.equal(fetchCalls, 0, 'second concurrent call must not reach MiniMax');
  } finally {
    global.fetch = realFetch;
    releaseGenerationLock(held);
  }
});

test('acquireGenerationLock is exclusive', () => {
  const { audioDir } = makeSongDir('exclusive');
  const first = acquireGenerationLock(audioDir);
  const second = acquireGenerationLock(audioDir);
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  releaseGenerationLock(first);
  const third = acquireGenerationLock(audioDir);
  assert.equal(third.acquired, true, 'lock is re-acquirable after release');
  releaseGenerationLock(third);
});

test('confirmed paid re-render bills once, then quarantines the prior master (one canonical remains)', async () => {
  const { songId, audioDir } = makeSongDir('rerender');
  writeAudio(audioDir, 'old-take.mp3');

  let fetchCalls = 0;
  const realFetch = global.fetch;
  const prevKey = process.env.MINIMAX_API_KEY;
  const prevFree = process.env.MINIMAX_USE_FREE_MODEL;
  process.env.MINIMAX_API_KEY = 'test-key';
  process.env.MINIMAX_USE_FREE_MODEL = '';
  // Synchronous completion with a tiny hex payload.
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ data: { status: 2, audio: '00112233aabbccdd' } }) };
  };
  try {
    const result = await generateMusic({
      songId,
      title: 'Brand New Take',
      lyricsText: 'la la la\nsinging now\nholding on',
      forceRegenerate: true,
      confirmPaidRerender: true,
    });
    assert.equal(fetchCalls, 1, 'exactly one MiniMax render billed');
    assert.equal(result.audioFiles.length, 1);

    // Exactly one canonical master remains in the audio dir root.
    const rootAudio = fs.readdirSync(audioDir).filter(n => /\.(mp3|wav)$/i.test(n));
    assert.equal(rootAudio.length, 1, 'one canonical master after re-render');

    // The old take is quarantined, not deleted.
    const supersededRoot = path.join(audioDir, 'superseded');
    assert.equal(fs.existsSync(supersededRoot), true, 'prior master quarantined');
    const quarantined = fs.readdirSync(supersededRoot)
      .flatMap(d => fs.readdirSync(path.join(supersededRoot, d)));
    assert.ok(quarantined.includes('old-take.mp3'), 'old take preserved in superseded/');
  } finally {
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = prevKey;
    if (prevFree === undefined) delete process.env.MINIMAX_USE_FREE_MODEL; else process.env.MINIMAX_USE_FREE_MODEL = prevFree;
  }
});

test('quarantinePriorMasters keeps only the new canonical file', () => {
  const { audioDir } = makeSongDir('quarantine');
  writeAudio(audioDir, 'a.mp3');
  writeAudio(audioDir, 'b.mp3');
  const keep = writeAudio(audioDir, 'c.mp3');

  const moved = quarantinePriorMasters(audioDir, keep);
  assert.equal(moved.length, 2);
  const remaining = fs.readdirSync(audioDir).filter(n => /\.(mp3|wav)$/i.test(n));
  assert.deepEqual(remaining, ['c.mp3']);
  assert.equal(findExistingValidAudioFile(audioDir), keep);
});

// ---------------------------------------------------------------------------
// Phase 4 — DistroKid packaging must not silently pick a duplicate
// ---------------------------------------------------------------------------

test('DistroKid payload refuses to auto-pick audio when duplicates are unresolved', () => {
  const { songId, audioDir } = makeSongDir('dkdupe');
  const f1 = writeAudio(audioDir, 'first.mp3');
  const f2 = writeAudio(audioDir, 'second.mp3');

  const cockpit = {
    type: 'single',
    id: songId,
    title: 'Test Release',
    releaseDate: '2026-06-01',
    tracks: [{
      id: songId,
      song_id: songId,
      title: 'Dupe Track',
      releaseAudio: {
        duplicate: true,
        selected: null,
        candidates: [{ path: f1 }, { path: f2 }],
      },
      fsAssets: { audioFiles: [{ path: f1, name: 'first.mp3' }] },
    }],
  };

  const payload = buildDistroKidPayloadFromCockpit(cockpit);
  const track = (payload.tracks || [])[0];
  assert.ok(track, 'a track payload is produced');
  assert.equal(track.audioPath || track.audio_path || null, null,
    'no audio auto-selected while a duplicate master is unresolved');
});

test('DistroKid payload uses the explicitly selected master even if other files exist', () => {
  const { songId, audioDir } = makeSongDir('dkselected');
  const f1 = writeAudio(audioDir, 'first.mp3');
  const chosen = writeAudio(audioDir, 'chosen.mp3');

  const cockpit = {
    type: 'single',
    id: songId,
    title: 'Test Release',
    releaseDate: '2026-06-01',
    tracks: [{
      id: songId,
      song_id: songId,
      title: 'Selected Track',
      releaseAudio: {
        duplicate: false,
        selected: { path: chosen },
        candidates: [{ path: f1 }, { path: chosen }],
      },
      fsAssets: { audioFiles: [{ path: f1, name: 'first.mp3' }] },
    }],
  };

  const payload = buildDistroKidPayloadFromCockpit(cockpit);
  const track = (payload.tracks || [])[0];
  assert.ok(track);
  const resolved = track.audioPath || track.audio_path || null;
  assert.ok(resolved && resolved.endsWith('chosen.mp3'), `expected chosen.mp3, got ${resolved}`);
});
