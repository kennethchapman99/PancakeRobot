import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sqliteSkipReason = false;
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
} catch (err) {
  sqliteSkipReason = `better-sqlite3 could not load in this Node runtime: ${err.message.split('\n')[0]}`;
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const slug = `release-selection-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
process.env.PIPELINE_APP_SLUG = slug;

async function loadModules() {
  const cacheBust = Date.now() + Math.random();
  const dbModule = await import(`../src/shared/db.js?rs=${cacheBust}`);
  const agentModule = await import(`../src/agents/release-selection-agent.js?rs=${cacheBust}`);
  const scoreModule = await import(`../src/lib/release-selection/score-song.js?rs=${cacheBust}`);
  const treatmentModule = await import(`../src/lib/release-selection/release-treatment-mapper.js?rs=${cacheBust}`);
  const serverModule = await import(`../src/web/server.js?rs=${cacheBust}`);
  const brandModule = await import(`../src/shared/brand-profile.js?rs=${cacheBust}`);
  return { ...dbModule, ...agentModule, ...scoreModule, ...treatmentModule, ...serverModule, ...brandModule };
}

function ensureSongFiles(songId, { withAudio = true, lyrics = '[CHORUS]\nFlip flip flip\nFlip flip flip\n', audioSource = 'Pancake Robot (Flip Flip Flip).mp3' } = {}) {
  const songDir = path.join(repoRoot, 'output', 'songs', songId);
  const audioDir = path.join(songDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(songDir, 'lyrics.md'), lyrics);
  fs.writeFileSync(path.join(songDir, 'metadata.json'), JSON.stringify({ duration_seconds: 163 }, null, 2));
  if (withAudio) {
    fs.copyFileSync(path.join(repoRoot, audioSource), path.join(audioDir, `${songId}.mp3`));
  }
}

function cleanupSongFiles(songIds) {
  for (const songId of songIds) {
    fs.rmSync(path.join(repoRoot, 'output', 'songs', songId), { recursive: true, force: true });
  }
}

test('release selection agent writes recommendations, marketing handoff fields, and preserves draft status', { skip: sqliteSkipReason }, async t => {
  const {
    upsertSong,
    getSong,
    analyzeSongForReleaseSelection,
  } = await loadModules();
  const songId = `SONG_RS_${Date.now().toString(36).toUpperCase()}`;
  ensureSongFiles(songId);

  t.after(() => cleanupSongFiles([songId]));

  upsertSong({
    id: songId,
    title: 'Flip Flip Flip',
    topic: 'robot pancakes',
    status: 'draft',
  });

  const first = await analyzeSongForReleaseSelection(songId);
  const savedFirst = getSong(songId);
  await new Promise(resolve => setTimeout(resolve, 25));
  const second = await analyzeSongForReleaseSelection(songId);
  const savedSecond = getSong(songId);

  assert.ok(first.recommendation);
  assert.ok(first.marketing_inputs_from_ar);
  assert.equal(savedFirst.status, 'draft');
  assert.equal(savedFirst.release_recommendation.agent, 'ReleaseSelectionAgent');
  assert.equal(typeof savedFirst.release_recommendation.score, 'number');
  assert.equal(savedFirst.marketing_inputs_from_ar.recommended_release_treatment, savedFirst.release_recommendation.recommended_release_treatment);
  assert.ok(savedFirst.marketing_inputs_from_ar.suggested_asset_strategy);
  assert.ok(savedFirst.release_recommendation.updated_at);
  assert.ok(savedSecond.release_recommendation.updated_at >= savedFirst.release_recommendation.updated_at);
  assert.ok(Array.isArray(savedSecond.release_recommendation_history));
  assert.ok(savedSecond.release_recommendation_history.length >= 2);
  assert.equal(second.recommendation.threshold_version, 'release_selection_v1');
});

test('missing audio produces needs_manual_review and missing brand profile lowers confidence with flagged issue', { skip: sqliteSkipReason }, async t => {
  const { upsertSong, getSong, analyzeSongForReleaseSelection } = await loadModules();
  const missingAudioSongId = `SONG_RS_MISSING_AUDIO_${Date.now().toString(36).toUpperCase()}`;
  const missingBrandSongId = `SONG_RS_MISSING_BRAND_${Date.now().toString(36).toUpperCase()}`;
  ensureSongFiles(missingAudioSongId, { withAudio: false, lyrics: '[VERSE]\nThis song has no audio\n' });
  ensureSongFiles(missingBrandSongId, { withAudio: true, lyrics: '[CHORUS]\nMoon toast moon toast\nMoon toast moon toast\n' });

  t.after(() => cleanupSongFiles([missingAudioSongId, missingBrandSongId]));

  upsertSong({ id: missingAudioSongId, title: 'No Audio Yet', topic: 'missing audio', status: 'draft' });
  upsertSong({ id: missingBrandSongId, title: 'Moon Toast', topic: 'moon toast', status: 'draft', brand_profile_id: 'definitely-missing-profile' });

  await analyzeSongForReleaseSelection(missingAudioSongId);
  await analyzeSongForReleaseSelection(missingBrandSongId);

  const missingAudioSong = getSong(missingAudioSongId);
  const missingBrandSong = getSong(missingBrandSongId);

  assert.equal(missingAudioSong.release_recommendation.value, 'needs_manual_review');
  assert.equal(missingAudioSong.status, 'draft');
  assert.ok(missingAudioSong.release_recommendation.release_blockers.length >= 1);
  assert.ok(missingBrandSong.release_recommendation.detected_issues.includes('missing_brand_profile'));
  assert.notEqual(missingBrandSong.release_recommendation.confidence, 'high');
});

test('threshold and treatment mapping cover high, low, and asset-strategy branches', { skip: sqliteSkipReason }, async () => {
  const { determineRecommendationValue, mapRecommendationToTreatment, mapTreatmentToAssetStrategy } = await loadModules();

  const publish = determineRecommendationValue({
    totalScore: 92,
    releaseBlockers: [],
    issues: [],
    scoreBreakdown: {
      production_quality: 13,
      hook_replayability: 24,
      brand_fit: 13,
    },
  });
  const archive = determineRecommendationValue({
    totalScore: 22,
    releaseBlockers: [],
    issues: ['weak_repeated_hook'],
    scoreBreakdown: {
      production_quality: 4,
      hook_replayability: 6,
      brand_fit: 5,
    },
  });

  assert.equal(publish, 'recommend_to_publish');
  assert.equal(archive, 'recommend_to_archive');
  assert.equal(mapRecommendationToTreatment({
    recommendation: 'recommend_to_publish',
    score: 92,
    issues: [],
    releaseBlockers: [],
    clipStrength: 13,
    productionQuality: 13,
    hookReplayability: 24,
  }), 'full_push');
  assert.equal(mapRecommendationToTreatment({
    recommendation: 'recommend_to_archive',
    score: 22,
    issues: [],
    releaseBlockers: [],
    clipStrength: 0,
    productionQuality: 4,
    hookReplayability: 6,
  }), 'archive_candidate');
  assert.equal(mapTreatmentToAssetStrategy('full_push'), 'full_release_pack');
  assert.equal(mapTreatmentToAssetStrategy('edit_then_reassess'), 'edit_notes_only');
});

test('batch analysis continues and returns manual review for the broken song', { skip: sqliteSkipReason }, async t => {
  const { upsertSong, analyzeRecentDraftSongsForReleaseSelection } = await loadModules();
  const okSongId = `SONG_RS_BATCH_OK_${Date.now().toString(36).toUpperCase()}`;
  const badSongId = `SONG_RS_BATCH_BAD_${Date.now().toString(36).toUpperCase()}`;
  ensureSongFiles(okSongId);
  ensureSongFiles(badSongId, { withAudio: false, lyrics: '[VERSE]\nNo audio file\n' });

  t.after(() => cleanupSongFiles([okSongId, badSongId]));

  upsertSong({ id: okSongId, title: 'Batch OK', topic: 'robot dance', status: 'draft' });
  upsertSong({ id: badSongId, title: 'Batch Broken', topic: 'broken render', status: 'draft' });

  const batch = await analyzeRecentDraftSongsForReleaseSelection({ songIds: [okSongId, badSongId] });

  assert.equal(batch.songs_reviewed, 2);
  assert.ok(batch.results.some(item => item.song_id === okSongId));
  assert.ok(batch.needs_manual_review.includes(badSongId));
});

test('brand-specific values come from brand profile JSON and operator actions move internal pipeline without public status pollution', { skip: sqliteSkipReason }, async t => {
  const {
    upsertSong,
    getSong,
    analyzeSongForReleaseSelection,
    saveBrandProfileById,
    resolveBrandProfilePath,
    app,
  } = await loadModules();
  const profileId = `release-selection-profile-${Date.now().toString(36)}`;
  const songId = `SONG_RS_ACTION_${Date.now().toString(36).toUpperCase()}`;
  ensureSongFiles(songId, { lyrics: '[CHORUS]\nMoon toast moon toast\nMoon toast moon toast\n' });

  const profilePath = resolveBrandProfilePath(profileId);
  const customProfile = {
    brand_name: 'Moon Toast Factory',
    brand_type: 'music',
    brand_description: 'moon toast songs',
    audience: { age_range: 'all', description: 'all listeners', guardrail: 'keep it safe' },
    secondary_audience: { description: 'caregivers who do not want shrill songs' },
    character: {
      name: 'Moon Toast',
      core_concept: 'moon toast mascot',
      fallback_summary: 'moon toast mascot',
    },
    music: {
      default_style: 'bright pop',
      default_bpm: 120,
      default_prompt: 'bright pop song',
      target_length: '2:00-3:00',
      normal_word_range: '120-260',
      first_vocal_by_seconds: 5,
      max_instrumental_intro_seconds: 5,
    },
    lyrics: {
      title_examples: ['Moon Toast'],
      topic_variety: 'space breakfast',
      required_closing: 'say goodbye',
    },
    distribution: {
      default_distributor: 'DistroKid',
      legacy_distributor: 'DistroKid',
      research_default_service: 'DistroKid',
      research_default_url: 'https://example.com',
      default_artist: 'Moon Toast',
      default_album: 'Moon Toast Songs',
      primary_genre: 'Pop',
      spotify_genres: ['pop'],
      youtube_tags_seed: ['music'],
      apple_music_genres: ['Pop'],
      coppa_status: 'not directed to children under 13',
      content_advisory: 'safe',
    },
    ui: { sidebar_subtitle: 'Music Studio', logo_path: '/logo.png' },
    themes: ['moon toast'],
    brand_fit_keywords: ['moon toast'],
  };
  saveBrandProfileById(profileId, customProfile);

  t.after(() => {
    cleanupSongFiles([songId]);
    fs.rmSync(profilePath, { force: true });
  });

  upsertSong({ id: songId, title: 'Moon Toast Anthem', topic: 'moon toast', status: 'draft', brand_profile_id: profileId });
  await analyzeSongForReleaseSelection(songId);
  const analyzed = getSong(songId);

  assert.equal(analyzed.release_recommendation.brand_profile_id, profileId);
  assert.ok(analyzed.release_recommendation.scores.brand_fit >= 10);
  assert.ok(analyzed.marketing_inputs_from_ar.best_hook_phrase);
  assert.equal(analyzed.status, 'draft');

  const server = app.listen(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let response = await fetch(`${baseUrl}/api/songs/${songId}/release-selection/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish' }),
  });
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.song.status, 'draft');
  assert.equal(body.song.pipeline_stage, 'approved_for_release_packaging');

  response = await fetch(`${baseUrl}/api/songs/${songId}/release-selection/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'archive' }),
  });
  body = await response.json();
  assert.equal(body.song.status, 'archived');
});

