import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
let sqliteSkipReason = false;
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
} catch (err) {
  sqliteSkipReason = `better-sqlite3 could not load in this Node runtime: ${err.message.split('\n')[0]}`;
}

const TEST_SLUG = `social-publish-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
process.env.PIPELINE_APP_SLUG = TEST_SLUG;

function resetSocialEnv() {
  process.env.SOCIAL_PUBLISH_MODE = 'dry_run';
  process.env.SOCIAL_REQUIRE_APPROVAL = 'true';
  process.env.PUBLIC_BASE_URL = 'https://example.com';
  process.env.DAILY_SOCIAL_ENABLED = 'false';
  process.env.DAILY_SOCIAL_TIMEZONE = 'America/Toronto';
  process.env.DAILY_SOCIAL_REQUIRE_APPROVAL = 'true';
  process.env.DAILY_SOCIAL_PLATFORMS = 'instagram,facebook,youtube';
  process.env.DAILY_SOCIAL_INSTAGRAM_TIME = '08:30';
  process.env.DAILY_SOCIAL_FACEBOOK_TIME = '09:00';
  process.env.DAILY_SOCIAL_YOUTUBE_TIME = '16:00';
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
  delete process.env.YOUTUBE_REDIRECT_URI;
  delete process.env.YOUTUBE_REFRESH_TOKEN;
  delete process.env.YOUTUBE_CHANNEL_ID;
  delete process.env.YOUTUBE_TOKEN_PATH;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_PAGE_ID;
  delete process.env.META_PAGE_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_IG_USER_ID;
  delete process.env.FACEBOOK_PAGE_ID;
  delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
}

async function loadModules() {
  const cacheBust = `${Date.now()}_${Math.random()}`;
  const db = await import(`../src/shared/db.js?sp=${cacheBust}`);
  const socialDb = await import(`../src/shared/social-publishing-db.js?sp=${cacheBust}`);
  const planner = await import(`../src/agents/daily-social-planner-agent.js?sp=${cacheBust}`);
  const worker = await import(`../src/agents/social-publish-worker.js?sp=${cacheBust}`);
  const marketingDb = await import(`../src/shared/marketing-db.js?sp=${cacheBust}`);
  const outreachDb = await import(`../src/shared/marketing-outreach-db.js?sp=${cacheBust}`);
  const instagram = await import(`../src/shared/social/connectors/instagram-connector.js?sp=${cacheBust}`);
  const youtube = await import(`../src/shared/social/connectors/youtube-connector.js?sp=${cacheBust}`);
  return { ...db, ...socialDb, ...planner, ...worker, ...marketingDb, ...outreachDb, ...instagram, ...youtube };
}

function seedSong(upsertSong, id, overrides = {}) {
  upsertSong({
    id,
    title: overrides.title || 'Butter Flip',
    topic: overrides.topic || 'robot pancakes for breakfast',
    status: overrides.status || 'submitted to DistroKid',
    marketing_links: {
      smart_link: 'https://example.com/listen/butter-flip',
      release_kit_url: 'https://example.com/release-kit/butter-flip',
      youtube_video_url: 'https://example.com/youtube/butter-flip',
      instagram_url: 'https://instagram.com/pancakerobotmusic',
    },
    marketing_assets: {
      square_post_url: overrides.square_post_url || 'https://example.com/assets/butter-square.png',
      vertical_post_url: overrides.vertical_post_url || 'https://example.com/assets/butter-vertical.png',
      portrait_post_url: overrides.portrait_post_url || 'https://example.com/assets/butter-portrait.png',
      cover_safe_promo_url: overrides.cover_safe_promo_url || 'https://example.com/assets/butter-cover-safe.png',
      no_text_variation_url: overrides.no_text_variation_url || 'https://example.com/assets/butter-no-text.png',
      generated_at: '2026-05-07T10:00:00.000Z',
    },
    marketing_inputs_from_ar: overrides.marketing_inputs_from_ar || {
      use_in_daily_social_push: true,
      prioritize_next_daily_campaign: true,
    },
    release_recommendation: { score: 88, updated_at: '2026-05-07T09:00:00.000Z' },
  });
}

test('dry-run creates a campaign and platform posts without publishing', { skip: sqliteSkipReason }, async () => {
  resetSocialEnv();
  const { upsertSong, createOrRefreshDailySocialCampaign, runSocialPublishWorker, getSocialPostsByCampaignId } = await loadModules();
  seedSong(upsertSong, 'SONG_SOCIAL_DRYRUN_A');

  const { campaign } = createOrRefreshDailySocialCampaign({ date: '2026-05-07' });
  await runSocialPublishWorker({ campaignId: campaign.id, force: true });
  const posts = getSocialPostsByCampaignId(campaign.id);

  assert.equal(posts.length, 3);
  assert.ok(posts.every(post => !post.published_at));
  assert.ok(posts.some(post => post.platform === 'instagram'));
  assert.ok(posts.some(post => post.platform === 'facebook'));
  assert.ok(posts.some(post => post.platform === 'youtube'));
});

test('duplicate dry-run for the same date does not create duplicate posts', { skip: sqliteSkipReason }, async () => {
  resetSocialEnv();
  const { upsertSong, createOrRefreshDailySocialCampaign, getSocialPostsByCampaignId } = await loadModules();
  seedSong(upsertSong, 'SONG_SOCIAL_DRYRUN_B');

  const first = createOrRefreshDailySocialCampaign({ date: '2026-05-07' });
  const second = createOrRefreshDailySocialCampaign({ date: '2026-05-07' });

  assert.equal(first.campaign.id, second.campaign.id);
  assert.equal(getSocialPostsByCampaignId(first.campaign.id).length, 3);
});

test('Instagram live validation rejects localhost/private media URLs', { skip: sqliteSkipReason }, async () => {
  resetSocialEnv();
  process.env.SOCIAL_PUBLISH_MODE = 'live';
  process.env.META_APP_ID = 'meta-app';
  process.env.META_APP_SECRET = 'meta-secret';
  process.env.META_PAGE_ID = 'meta-page';
  process.env.META_PAGE_ACCESS_TOKEN = 'meta-token';
  process.env.INSTAGRAM_IG_USER_ID = 'ig-user';
  const { instagramConnector } = await import(`../src/shared/social/connectors/instagram-connector.js?sp=${Date.now()}_${Math.random()}`);

  const result = instagramConnector.dryRun({
    platform: 'instagram',
    assetType: 'image',
    caption: 'Hello families',
    publicAssetUrl: 'http://localhost:3737/media/test.png',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /public HTTPS media URL/i);
});

test('YouTube validation fails when madeForKids is not explicit', { skip: sqliteSkipReason }, async () => {
  resetSocialEnv();
  const { youtubeConnector } = await import(`../src/shared/social/connectors/youtube-connector.js?sp=${Date.now()}_${Math.random()}`);
  const result = youtubeConnector.dryRun({
    platform: 'youtube',
    assetType: 'video',
    title: 'Short title',
    description: 'Short description',
    assetUrl: 'https://example.com/assets/clip.mp4',
    publicAssetUrl: 'https://example.com/assets/clip.mp4',
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /madeForKids must be explicit/i);
});

test('missing env vars produce needs_auth style results, not crashes', { skip: sqliteSkipReason }, async () => {
  resetSocialEnv();
  process.env.DAILY_SOCIAL_PLATFORMS = 'instagram';
  const { upsertSong, createOrRefreshDailySocialCampaign, runSocialPublishWorker, getSocialPostsByCampaignId } = await loadModules();
  seedSong(upsertSong, 'SONG_SOCIAL_NEEDS_AUTH');

  const { campaign } = createOrRefreshDailySocialCampaign({ date: '2026-05-07', platforms: ['instagram'] });
  await runSocialPublishWorker({ campaignId: campaign.id, force: true });
  const [post] = getSocialPostsByCampaignId(campaign.id);

  assert.equal(post.status, 'needs_auth');
  assert.match(post.error_message, /Missing config/i);
});

test('social posting does not create or mutate reviewer outreach campaigns/items', { skip: sqliteSkipReason }, async () => {
  resetSocialEnv();
  const {
    upsertSong,
    createOrRefreshDailySocialCampaign,
    runSocialPublishWorker,
    getMarketingCampaigns,
    getOutreachItems,
  } = await loadModules();
  seedSong(upsertSong, 'SONG_SOCIAL_SEPARATION');

  const beforeCampaigns = getMarketingCampaigns(100).length;
  const beforeItems = getOutreachItems({}).length;
  const { campaign } = createOrRefreshDailySocialCampaign({ date: '2026-05-07' });
  await runSocialPublishWorker({ campaignId: campaign.id, force: true });

  assert.equal(getMarketingCampaigns(100).length, beforeCampaigns);
  assert.equal(getOutreachItems({}).length, beforeItems);
});

test('social post idempotency key prevents duplicate posts', { skip: sqliteSkipReason }, async () => {
  resetSocialEnv();
  const {
    upsertSong,
    createDailySocialCampaign,
    upsertSocialPost,
    getSocialPostsByCampaignId,
  } = await loadModules();
  seedSong(upsertSong, 'SONG_SOCIAL_IDEMPOTENT');

  const campaign = createDailySocialCampaign({
    date: '2026-05-07',
    timezone: 'America/Toronto',
    selected_song_id: 'SONG_SOCIAL_IDEMPOTENT',
    campaign_type: 'catalog_discovery',
  });
  upsertSocialPost({
    campaign_id: campaign.id,
    song_id: 'SONG_SOCIAL_IDEMPOTENT',
    platform: 'instagram',
    asset_type: 'image',
    asset_url: 'https://example.com/assets/idempotent.png',
    caption: 'One',
    idempotency_key: '2026-05-07:instagram:SONG_SOCIAL_IDEMPOTENT:catalog_discovery',
  });
  upsertSocialPost({
    campaign_id: campaign.id,
    song_id: 'SONG_SOCIAL_IDEMPOTENT',
    platform: 'instagram',
    asset_type: 'image',
    asset_url: 'https://example.com/assets/idempotent.png',
    caption: 'Two',
    idempotency_key: '2026-05-07:instagram:SONG_SOCIAL_IDEMPOTENT:catalog_discovery',
  });

  const posts = getSocialPostsByCampaignId(campaign.id);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].caption, 'Two');
});

test('social DB helpers work with isolated PIPELINE_APP_SLUG test databases', { skip: sqliteSkipReason }, async () => {
  resetSocialEnv();
  const {
    upsertSong,
    createDailySocialCampaign,
    getDailySocialCampaignForDate,
    getDailySocialCampaigns,
    updateDailySocialCampaign,
    upsertSocialPost,
    getSocialPostsBySongId,
    updateSocialPost,
    getSocialPublishingSummary,
  } = await loadModules();
  seedSong(upsertSong, 'SONG_SOCIAL_HELPERS');

  const campaign = createDailySocialCampaign({
    date: '2026-05-07',
    timezone: 'America/Toronto',
    selected_song_id: 'SONG_SOCIAL_HELPERS',
    campaign_type: 'catalog_discovery',
  });
  updateDailySocialCampaign(campaign.id, { status: 'approved' });
  const post = upsertSocialPost({
    campaign_id: campaign.id,
    song_id: 'SONG_SOCIAL_HELPERS',
    platform: 'facebook',
    asset_type: 'image',
    asset_url: 'https://example.com/assets/helper.png',
    caption: 'Helpers',
    hashtags: ['#PancakeRobot'],
    idempotency_key: '2026-05-07:facebook:SONG_SOCIAL_HELPERS:catalog_discovery',
  });
  updateSocialPost(post.id, { status: 'ready', validation_warnings: ['Missing config: FACEBOOK_PAGE_ID'] });

  assert.equal(getDailySocialCampaignForDate('2026-05-07')?.id, campaign.id);
  assert.ok(getDailySocialCampaigns({ limit: 20 }).some(item => item.id === campaign.id));
  assert.equal(getSocialPostsBySongId('SONG_SOCIAL_HELPERS').length, 1);
  assert.ok(getSocialPublishingSummary().totals.total_posts >= 1);
});

test('YouTube env falls back to saved token file and live validation allows local media paths', { skip: sqliteSkipReason }, async (t) => {
  resetSocialEnv();
  process.env.SOCIAL_PUBLISH_MODE = 'live';
  process.env.YOUTUBE_CLIENT_ID = 'client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'client-secret';
  process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:3737/api/auth/youtube/callback';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-auth-'));
  const tokenPath = path.join(tempDir, 'youtube_token.json');
  const mediaPath = path.join(tempDir, 'clip.mp4');
  fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: 'refresh-token', channel_id: 'UC123', channel_title: 'Pancake Robot' }, null, 2));
  fs.writeFileSync(mediaPath, 'fake-video');
  process.env.YOUTUBE_TOKEN_PATH = tokenPath;
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { getSocialEnv } = await import(`../src/shared/social/social-env.js?sp=${Date.now()}_${Math.random()}`);
  const { youtubeConnector } = await import(`../src/shared/social/connectors/youtube-connector.js?sp=${Date.now()}_${Math.random()}`);
  const env = getSocialEnv();
  assert.equal(env.youtube.refreshToken, 'refresh-token');
  assert.equal(env.youtube.channelId, 'UC123');

  const result = youtubeConnector.dryRun({
    platform: 'youtube',
    assetType: 'video',
    title: 'Clip',
    description: 'Desc',
    assetUrl: mediaPath,
    publicAssetUrl: 'http://localhost:3737/media/private.mp4',
    madeForKids: false,
  });
  assert.equal(result.ok, true);
});

test('YouTube live publish uses injected uploader and returns a watch URL', { skip: sqliteSkipReason }, async (t) => {
  resetSocialEnv();
  process.env.SOCIAL_PUBLISH_MODE = 'live';
  process.env.YOUTUBE_CLIENT_ID = 'client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'client-secret';
  process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:3737/api/auth/youtube/callback';
  process.env.YOUTUBE_REFRESH_TOKEN = 'refresh-token';
  process.env.YOUTUBE_CHANNEL_ID = 'UC123';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-publish-'));
  const mediaPath = path.join(tempDir, 'clip.mp4');
  fs.writeFileSync(mediaPath, 'fake-video');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { youtubeConnector } = await import(`../src/shared/social/connectors/youtube-connector.js?sp=${Date.now()}_${Math.random()}`);
  const result = await youtubeConnector.publish({
    platform: 'youtube',
    assetType: 'video',
    title: 'Clip',
    description: 'Desc',
    assetUrl: mediaPath,
    madeForKids: false,
    containsSyntheticMedia: true,
    tags: ['PancakeRobot'],
  }, {
    authClient: {},
    media: {
      mediaPath: mediaPath,
      body: Readable.from(['fake-video']),
      cleanup: async () => {},
    },
    uploadFn: async () => ({
      data: {
        id: 'abc123',
        snippet: { channelId: 'UC123' },
        status: { privacyStatus: 'private' },
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.platformPostId, 'abc123');
  assert.equal(result.platformPostUrl, 'https://www.youtube.com/watch?v=abc123');
});
