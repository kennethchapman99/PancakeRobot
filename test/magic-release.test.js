import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  cleanupTestOutputArtifacts,
  prepareTestDbSlug,
} from '../src/shared/test-db-artifacts.js';

process.env.PIPELINE_APP_SLUG = prepareTestDbSlug('test-magic-release').slug;

const repoRoot = path.resolve(import.meta.dirname, '..');
const songIds = new Set();
const albumIds = new Set();
const packageIds = new Set();

test.after(() => {
  cleanupTestOutputArtifacts({
    songIds: [...songIds],
    albumIds: [...albumIds],
    packageIds: [...packageIds],
  });
});

const {
  assignAlbumSingles,
  assignSongsToAlbum,
  createAlbum,
  getReleaseCampaignByRelease,
  getReleaseCampaignTaskByKey,
  getReleaseLinks,
  getSong,
  getSongsForAlbum,
  listReleaseCampaignTasks,
  upsertReleaseCampaignTask,
  upsertSong,
} = await import('../src/shared/db.js');
const {
  createMagicReleaseCampaign,
  getMagicReleaseState,
  ingestBrowsyResult,
  refreshMagicReleasePlan,
  runMagicReleaseTask,
  runMagicReleaseWorker,
} = await import('../src/shared/magic-release.js');
const {
  importVisualLibraryAsset,
  recommendVisualAssets,
  selectReusableAssetOrSuggestCustomVideo,
} = await import('../src/shared/visual-library.js');
const {
  buildReleaseCockpitViewModel,
} = await import('../src/shared/release-cockpit.js');

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function seedSong(id, overrides = {}) {
  songIds.add(id);
  upsertSong({
    id,
    title: overrides.title || `Song ${id}`,
    topic: overrides.topic || 'robots make pancakes',
    release_date: overrides.release_date || '2026-07-25',
    brand_profile_id: 'default',
    status: overrides.status || 'draft',
    marketing_links: overrides.marketing_links || {},
    marketing_assets: overrides.marketing_assets || {},
    keywords: overrides.keywords || ['pancake', 'robot'],
    mood_tags: overrides.mood_tags || ['happy'],
    is_test: true,
    ...overrides,
  });
  return id;
}

test('Magic Release creates a dated task plan for an album', () => {
  const trackA = seedSong(uniqueId('MAGIC_ALBUM_TRACK'));
  const trackB = seedSong(uniqueId('MAGIC_ALBUM_TRACK'));
  const albumId = createAlbum({
    id: uniqueId('MAGIC_ALBUM'),
    album_title: 'Breakfast Beats',
    release_date: '2026-08-01',
    number_of_songs: 2,
    status: 'assembled',
    is_test: true,
  });
  albumIds.add(albumId);
  packageIds.add(albumId);
  assignSongsToAlbum(albumId, [trackA, trackB]);
  assignAlbumSingles(albumId, [{ songId: trackB, priority: 1 }]);

  const state = createMagicReleaseCampaign({ releaseType: 'album', releaseId: albumId });

  assert.equal(state.release.type, 'album');
  assert.equal(state.tasks.length >= 20, true);
  assert.equal(getSongsForAlbum(albumId).find(track => track.id === trackB)?.album_role, 'single');
  assert.equal(getReleaseCampaignByRelease('album', albumId).release_date, '2026-08-01');
  assert.equal(state.tasks.find(task => task.task_key === 'distrokid_submit_dry_run')?.due_date, '2026-07-04');
});

test('task dependency readiness promotes later steps only when prerequisites complete', async () => {
  const songId = seedSong(uniqueId('MAGIC_SINGLE_READY'));
  packageIds.add(songId);
  createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });

  let state = getMagicReleaseState('single', songId);
  assert.equal(state.tasks.find(task => task.task_key === 'distrokid_submit_dry_run')?.status, 'ready');

  await runMagicReleaseTask({
    campaignId: state.campaign.id,
    taskKey: 'verify_release_metadata',
    dryRun: true,
  });
  await runMagicReleaseTask({
    campaignId: state.campaign.id,
    taskKey: 'distrokid_package_readiness',
    dryRun: true,
  });
  state = getMagicReleaseState('single', songId);
  assert.equal(state.tasks.find(task => task.task_key === 'distrokid_submit_dry_run')?.status, 'ready');
});

test('Browsy package generation and stub run stay on the generic contract', async () => {
  const songId = seedSong(uniqueId('MAGIC_BROWSY_SINGLE'));
  packageIds.add(songId);
  const songDir = path.join(repoRoot, 'output', 'songs', songId);
  fs.mkdirSync(path.join(songDir, 'reference'), { recursive: true });
  fs.writeFileSync(path.join(songDir, 'audio.mp3'), 'fake-audio');
  fs.writeFileSync(path.join(songDir, 'reference', 'base-image.png'), 'fake-artwork');
  fs.writeFileSync(path.join(songDir, 'lyrics.md'), 'Payload lyrics');
  fs.writeFileSync(path.join(songDir, 'metadata.json'), JSON.stringify({
    artist: 'Pancake Robot',
    title: 'Browsy Payload Song',
    primary_genre: "Children's Music",
    language: 'English',
    songwriter: 'Kenneth Chapman',
  }));
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'verify_release_metadata', dryRun: true });
  await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'distrokid_package_readiness', dryRun: true });

  const result = await runMagicReleaseTask({
    campaignId: created.campaign.id,
    taskKey: 'distrokid_submit_dry_run',
    dryRun: true,
  });
  const task = getReleaseCampaignTaskByKey(created.campaign.id, 'distrokid_submit_dry_run');
  const packagePath = path.join(repoRoot, 'output', 'release-workflows', created.campaign.id, 'distrokid_submit_dry_run', 'workflow-package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(pkg.workflow_id, 'distrokid-single-submit');
  assert.equal(pkg.source_system, 'pancake_robot');
  assert.equal(pkg.return_contract_version, 'automation-result-v1');
  assert.equal(Object.hasOwn(pkg, 'selectors'), false);
  assert.equal(pkg.canonical_payload.releaseId, songId);
  assert.equal(pkg.canonical_payload.trackCount, 1);
  assert.equal(path.isAbsolute(pkg.canonical_payload.artworkPath), true);
  assert.equal(path.isAbsolute(pkg.canonical_payload.tracks[0].audioPath), true);
  assert.equal(task.status, 'complete');
});

test('Browsy result ingestion maps smart links and client_action_requests into needs-Ken tasks', async () => {
  const songId = seedSong(uniqueId('MAGIC_RESULT_SINGLE'));
  packageIds.add(songId);
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  const resultDir = path.join(repoRoot, 'output', 'release-workflows', created.campaign.id, 'manual-result');
  fs.mkdirSync(resultDir, { recursive: true });
  const resultPath = path.join(resultDir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true,
    workflow_id: 'distrokid-hyperfollow-capture',
    run_id: 'run_hyperfollow_test',
    source_system: 'pancake_robot',
    entity_type: 'single',
    entity_id: songId,
    status: 'blocked',
    captured_outputs: {
      smart_link_url: 'https://distrokid.com/hyperfollow/pancake/breakfast',
    },
    filled_fields: [],
    skipped_fields: [],
    errors: [],
    screenshots: [],
    artifact_paths: [],
    manual_checkpoints: [],
    client_action_requests: [
      {
        type: 'human_decision_required',
        severity: 'blocking',
        reason: 'Multiple candidate audio files were detected.',
        suggested_action: 'Select release master audio',
        related_field: 'track.audio_file',
        related_item_id: 'TRACK_01',
      },
    ],
    next_required_action: null,
  }, null, 2));

  const ingestion = await ingestBrowsyResult({ resultPath, campaignId: created.campaign.id, taskKey: 'hyperfollow_capture' });
  const tasks = listReleaseCampaignTasks(created.campaign.id);

  assert.equal(ingestion.ok, true);
  assert.ok(getReleaseLinks(songId).some(link => link.url === 'https://distrokid.com/hyperfollow/pancake/breakfast'));
  assert.ok(tasks.some(task => task.task_key === 'select_release_master_audio' && task.status === 'needs_ken'));
});

test('visual library import and recommendation prefer reusable assets before custom generation', () => {
  const songId = seedSong(uniqueId('MAGIC_VISUAL_SINGLE'), {
    title: 'Robot Pancake Parade',
    keywords: ['robot', 'pancake', 'parade'],
    mood_tags: ['happy', 'party'],
  });
  const tmpFile = path.join(os.tmpdir(), `${uniqueId('visual')}.png`);
  fs.writeFileSync(tmpFile, 'fake-image');
  const asset = importVisualLibraryAsset({
    sourcePath: tmpFile,
    tags: 'robot,pancake,happy',
    aspectRatio: '1x1',
    source: 'manual',
  });

  const recommended = recommendVisualAssets({ releaseType: 'single', releaseId: songId });
  const selection = selectReusableAssetOrSuggestCustomVideo({ releaseType: 'single', releaseId: songId });

  assert.equal(asset.asset_type, 'image');
  assert.ok(recommended.some(item => item.id === asset.id));
  assert.equal(selection.mode, 'reusable_asset');
});

test('scheduled worker does not cross human gates', async () => {
  const songId = seedSong(uniqueId('MAGIC_WORKER_SINGLE'));
  packageIds.add(songId);
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });
  await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'verify_release_metadata', dryRun: true });
  await runMagicReleaseTask({ campaignId: created.campaign.id, taskKey: 'distrokid_package_readiness', dryRun: true });

  const workerResult = await runMagicReleaseWorker({ dryRun: true });
  const state = getMagicReleaseState('single', songId);

  assert.ok(workerResult.processed.some(item => item.campaignId === created.campaign.id));
  assert.equal(state.tasks.find(task => task.task_key === 'distrokid_final_submit_approval')?.status, 'ready');
  assert.notEqual(state.tasks.find(task => task.task_key === 'youtube_teaser_schedule')?.status, 'complete');
});

test('skipped optional tasks persist and do not block downstream readiness', () => {
  const songId = seedSong(uniqueId('MAGIC_SKIP_SINGLE'));
  packageIds.add(songId);
  const created = createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });

  upsertReleaseCampaignTask({
    campaign_id: created.campaign.id,
    task_key: 'select_visual_assets',
    status: 'complete',
    completed_at: new Date().toISOString(),
  });
  upsertReleaseCampaignTask({
    campaign_id: created.campaign.id,
    task_key: 'youtube_teaser_schedule',
    status: 'skipped',
    reason: 'Skipping optional YouTube teaser for this release.',
    completed_at: new Date().toISOString(),
  });

  const state = getMagicReleaseState('single', songId);
  const skippedTask = state.tasks.find(task => task.task_key === 'youtube_teaser_schedule');
  const dependentTask = state.tasks.find(task => task.task_key === 'short_form_schedule');

  assert.equal(skippedTask?.status, 'skipped');
  assert.ok(['ready', 'pending', 'complete', 'skipped'].includes(dependentTask?.status));
  assert.equal(state.blockedTasks.some(task => task.task_key === 'youtube_teaser_schedule'), false);
});

test('Release Cockpit view model exposes Magic Release state', () => {
  const songId = seedSong(uniqueId('MAGIC_COCKPIT_SINGLE'));
  packageIds.add(songId);
  createMagicReleaseCampaign({ releaseType: 'single', releaseId: songId });

  const cockpit = buildReleaseCockpitViewModel('single', songId);

  assert.ok(cockpit.magicRelease);
  assert.equal(cockpit.magicRelease.campaignId.length > 0, true);
});

test('CLI commands create and refresh Magic Release state', () => {
  const songId = seedSong(uniqueId('MAGIC_CLI_SINGLE'));
  packageIds.add(songId);
  const scriptPath = path.join(repoRoot, 'src/scripts/magic-release-cli.js');

  const createOutput = execFileSync(process.execPath, [scriptPath, 'create', '--type', 'single', '--id', songId], { cwd: repoRoot, encoding: 'utf8' });
  const planOutput = execFileSync(process.execPath, [scriptPath, 'plan', '--type', 'single', '--id', songId], { cwd: repoRoot, encoding: 'utf8' });

  assert.match(createOutput, /"campaign"/);
  assert.match(planOutput, /"tasks"/);
});
