import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

if (!process.env.PIPELINE_APP_SLUG) {
  process.env.PIPELINE_APP_SLUG = `music-pipeline-smoke-release-happy-path-${Date.now()}`;
}

const dbSlug = process.env.PIPELINE_APP_SLUG;
const runToken = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const suffix = runToken.toUpperCase();
const songId = `SONG_SMOKE_RELEASE_${suffix}`;
const outletId = `TARGET_SMOKE_RELEASE_${suffix}`;
const summary = [];

const {
  upsertSong,
  getSong,
  upsertReleaseLink,
} = await import('../shared/db.js');
const {
  getSongMarketingKit,
  saveSongMarketingKit,
  buildReleaseKitViewModel,
} = await import('../shared/song-marketing-kit.js');
const { buildMarketingReleasePack } = await import('../marketing/release-agent.js');
const { getSongNextAction } = await import('../shared/song-workflow.js');
const { upsertMarketingTarget, getMarketingCampaigns } = await import('../shared/marketing-db.js');
const { createOutreachRun } = await import('../agents/marketing-outreach-run-agent.js');
const { generateDraftsForCampaign } = await import('../agents/marketing-outreach-draft-agent.js');
const { getOutreachItems } = await import('../shared/marketing-outreach-db.js');

console.log(`[release-happy-path-smoke] DB slug: ${dbSlug}`);
console.log(`[release-happy-path-smoke] Song: ${songId}`);

seedSong();
seedSongFiles();
seedOutlet();
push('seed song', songId);

let kit = getSongMarketingKit(songId);
assert.match(kit.marketing_assets.fallback_image_url || '', /^\/base-images\//);
push('fallback base image', kit.marketing_assets.fallback_image_url);

kit = saveSongMarketingKit(songId, {
  marketing_links: {
    smart_link: `https://distrokid.com/hyperfollow/${songId.toLowerCase()}`,
    spotify_url: `https://open.spotify.com/track/${songId.toLowerCase()}`,
    release_kit_url: '',
    audio_download_url: '',
    promo_assets_folder_url: `https://drive.google.com/${songId.toLowerCase()}`,
    cover_art_url: '',
    lyrics_url: `https://example.com/lyrics/${songId.toLowerCase()}`,
    instagram_url: 'https://instagram.com/pancakerobotmusic',
    tiktok_url: '',
    contact_email: 'ken@example.com',
  },
});
upsertReleaseLink(songId, 'HyperFollow', kit.marketing_links.smart_link);
upsertReleaseLink(songId, 'Spotify', kit.marketing_links.spotify_url);
push('save marketing links', 'HyperFollow + Spotify + promo assets + lyrics');

let nextAction = getSongNextAction(getSong(songId), kit);
assert.equal(nextAction.nextActionKey, 'GENERATE_MARKETING_PACK');
push('next action after links', nextAction.label);

const pack = await buildMarketingReleasePack(songId, { renderVideos: false });
assert.ok(pack.outputDir);
assert.ok(fs.existsSync(path.join(pack.outputDir, 'metadata.json')));
assert.ok(fs.existsSync(path.join(pack.outputDir, 'index.html')));
assert.ok(fs.existsSync(path.join(pack.outputDir, 'instagram', 'ig-square-post-1080x1080.png')));
assert.ok(fs.existsSync(path.join(pack.outputDir, 'instagram', 'ig-feed-announcement-1080x1350.png')));
assert.ok(fs.existsSync(path.join(pack.outputDir, 'instagram', 'ig-reel-cover.jpg')));
assert.ok(fs.existsSync(path.join(pack.outputDir, 'tiktok', 'tiktok-cover.jpg')));
push('build marketing pack', pack.outputDir);

kit = getSongMarketingKit(songId);
nextAction = getSongNextAction(getSong(songId), kit);
assert.equal(nextAction.nextActionKey, 'START_OUTREACH');
push('next action after pack', nextAction.label);

let releaseKitVm = buildReleaseKitViewModel(songId);
assert.ok(releaseKitVm);
assert.equal(Boolean(releaseKitVm.kit.marketing_assets.release_kit_published), false);
push('release kit view model', 'available without publishing');

const run = createOutreachRun({
  song_ids: [songId],
  outlet_ids: [outletId],
  dry_run: true,
});
const campaignId = run.campaigns[0]?.campaign_id;
assert.ok(campaignId);
push('create outreach campaign', campaignId);

const drafts = await generateDraftsForCampaign(campaignId, { deterministic: true });
assert.equal(drafts.failed, 0);
assert.equal(drafts.generated, 1);

const item = getOutreachItems({ campaign_id: campaignId })[0];
assert.ok(item?.body);
assert.match(item.body, /Listen \/ stream:/);
assert.match(item.body, /Spotify:/);
assert.match(item.body, /Instagram:/);
assert.match(item.body, /Contact:/);
assert.doesNotMatch(item.body, /Download audio:/);
assert.doesNotMatch(item.body, /Release kit:/);
assert.doesNotMatch(item.body, /Promo assets:/);
assert.doesNotMatch(item.body, /\[Add public streaming \/ preview links before sending\]/);
push('draft body link block', 'phase-1 outreach links only');

const campaign = getMarketingCampaigns(100).find(entry => entry.id === campaignId);
assert.ok(campaign);
assert.equal(campaign.approved_target_ids.length, 1);
push('campaign target selection', campaign.approved_target_ids.join(', '));

console.log('\nRelease happy-path smoke summary\n');
for (const item of summary) {
  console.log(`- ${item.step}: ${item.value}`);
}

function seedSong() {
  upsertSong({
    id: songId,
    title: 'Smoke Test Parade',
    topic: 'Manual release workflow smoke test',
    status: 'submitted to DistroKid',
    is_test: true,
    release_date: '2026-05-20',
    distributor: 'DistroKid',
    notes: `Created by smoke-song-release-happy-path.js (${runToken})`,
  });
}

function seedSongFiles() {
  const songDir = path.join(REPO_ROOT, 'output', 'songs', songId);
  fs.mkdirSync(songDir, { recursive: true });
  fs.writeFileSync(path.join(songDir, 'lyrics.md'), '# Verse\nSmoke test parade\n\n# Chorus\nEverybody sing along\n');
  fs.writeFileSync(path.join(songDir, 'metadata.json'), JSON.stringify({
    title: 'Smoke Test Parade',
    artist: 'Pancake Robot',
    youtube_title: 'Smoke Test Parade',
    hyperfollow_url: `https://distrokid.com/hyperfollow/${songId.toLowerCase()}`,
  }, null, 2));
}

function seedOutlet() {
  upsertMarketingTarget({
    id: outletId,
    name: `Smoke Playlist ${suffix}`,
    type: 'playlist',
    platform: 'email',
    source_url: `https://smoke-playlist.example/${runToken}`,
    contact_email: 'editor@smoke-playlist.example',
    public_email: 'editor@smoke-playlist.example',
    status: 'approved',
    ai_policy: 'allowed',
    fit_score: 95,
    contactability: {
      status: 'contactable',
      free_contact_method_found: true,
      best_channel: 'email',
      contact_methods: [{ type: 'email', value: 'editor@smoke-playlist.example' }],
    },
    cost_policy: { requires_payment: false, cost_type: 'free' },
    outreach_eligibility: { eligible: true, reason_codes: [] },
    outreach_angle: 'Family-friendly singalong playlists and upbeat novelty releases.',
  });
}

function push(step, value) {
  summary.push({ step, value });
}
