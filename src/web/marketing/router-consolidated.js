import express from 'express';
import { renderMarketingDashboard, postOutreachRun, postInboxScan, postReleaseBaseImage, postBuildReleaseMarketingPack } from './controllers/dashboard-controller.js';
import { renderOutletsPage } from './controllers/outlets-controller.js';
import {
  renderNewRelease,
  postNewRelease,
  handleNewReleaseUpload,
  postPromoteRelease,
  renderReleaseMarketing,
  postUpdateReleaseReadiness,
  postUpdateReleaseDistribution,
  postBuildReleaseAssets,
  postSelectReleaseAudience,
  postGenerateReleaseDrafts,
  postCreateReleaseGmailDrafts,
  postUpdateReleaseDraftTemplate,
  postUpdateReleaseDraftItem,
  postResetReleaseDraftItem,
  postMarkReleaseDraftSent,
  postScanReleaseInbox,
  postReleaseInboxAction,
  postUpdateReleaseResults,
} from './controllers/releases-controller.js';
import {
  renderCampaignDetail,
  postGenerateCampaignDrafts,
  postCreateCampaignGmailDrafts,
  postUpdateCampaignItem,
  postGenerateCampaignItemDraft,
  postCreateCampaignItemGmailDraft,
  postMarkCampaignItemManualSubmitted,
} from './controllers/campaign-controller.js';
import {
  getOutletsApi,
  getOutletsSummaryApi,
  getOutreachItemsApi,
  getOutreachEventsApi,
  getOutreachSummaryApi,
  postCreateOutreachRunApi,
  postGenerateOutreachDraftsApi,
  postCreateCampaignGmailDraftsApi,
  postCreateItemGmailDraftApi,
  postInboxScanApi,
} from './controllers/api-controller.js';
import {
  renderDailySocialPage,
  postRunDailySocialDryRun,
  postApproveDailySocialCampaign,
  postPublishDailySocialCampaign,
  postRegenerateSocialCopy,
  postSkipSocialPost,
  startYoutubeAuth,
  handleYoutubeAuthCallback,
} from './controllers/social-controller.js';
import { getSong } from '../../shared/db.js';
import { removeSongsFromAlbum } from '../../shared/album-track-membership.js';
import { buildReleaseCockpitViewModel } from '../../shared/release-cockpit.js';
import { selectReleaseAudio } from '../../shared/song-audio-selection.js';
import { markReleaseAssetsStale } from '../../shared/song-release-assets-service.js';

export function registerMarketingRouter(app) {
  const router = express.Router();

  router.get('/api/releases/:type/:id/state', getReleaseCockpitStateApi);
  router.get('/api/releases/:type/:id/assets/state', getReleaseCockpitAssetsStateApi);
  router.get('/api/releases/:type/:id/distribution/state', getReleaseCockpitDistributionStateApi);
  router.post('/albums/:id/tracks/remove', postRemoveAlbumTrack);
  router.post('/songs/:id/release-audio', postSelectReleaseAudio);

  router.get('/marketing', renderMarketingDashboard);
  router.post('/marketing/outreach-run', postOutreachRun);
  router.post('/marketing/agents/inbox-scan', postInboxScan);
  router.post('/marketing/inbox-scan', postInboxScan);
  router.post('/marketing/releases/:songId/base-image', postReleaseBaseImage);
  router.post('/marketing/releases/:songId/build-pack', postBuildReleaseMarketingPack);

  router.get('/marketing/outlets', renderOutletsPage);
  router.get('/marketing/social', renderDailySocialPage);
  router.get('/api/auth/youtube/start', startYoutubeAuth);
  router.get('/api/auth/youtube/callback', handleYoutubeAuthCallback);

  router.get('/marketing/releases/new', renderNewRelease);
  router.post('/marketing/releases', handleNewReleaseUpload, postNewRelease);
  router.post('/songs/:songId/promote-release', postPromoteRelease);
  router.get('/marketing/releases/:releaseMarketingId', renderReleaseMarketing);
  router.post('/marketing/releases/:releaseMarketingId/readiness', postUpdateReleaseReadiness);
  router.post('/marketing/releases/:releaseMarketingId/distribution', postUpdateReleaseDistribution);
  router.post('/marketing/releases/:releaseMarketingId/assets/build', postBuildReleaseAssets);
  router.post('/marketing/releases/:releaseMarketingId/audience', postSelectReleaseAudience);
  router.post('/marketing/releases/:releaseMarketingId/outreach-drafts/generate', postGenerateReleaseDrafts);
  router.post('/marketing/releases/:releaseMarketingId/outreach-drafts/gmail', postCreateReleaseGmailDrafts);
  router.post('/marketing/releases/:releaseMarketingId/drafts/template', postUpdateReleaseDraftTemplate);
  router.post('/marketing/releases/:releaseMarketingId/drafts/:itemId', postUpdateReleaseDraftItem);
  router.post('/marketing/releases/:releaseMarketingId/drafts/:itemId/reset', postResetReleaseDraftItem);
  router.post('/marketing/releases/:releaseMarketingId/drafts/:itemId/mark-sent', postMarkReleaseDraftSent);
  router.post('/marketing/releases/:releaseMarketingId/gmail-inbox/scan', postScanReleaseInbox);
  router.post('/marketing/releases/:releaseMarketingId/gmail-inbox/:messageId/:action', postReleaseInboxAction);
  router.post('/marketing/releases/:releaseMarketingId/results', postUpdateReleaseResults);

  router.get('/marketing/campaigns/:campaignId', renderCampaignDetail);
  router.post('/marketing/campaigns/:campaignId/generate-drafts', postGenerateCampaignDrafts);
  router.post('/marketing/campaigns/:campaignId/gmail-drafts', postCreateCampaignGmailDrafts);
  router.post('/marketing/campaigns/:campaignId/items/:itemId/update', postUpdateCampaignItem);
  router.post('/marketing/campaigns/:campaignId/items/:itemId/generate-draft', postGenerateCampaignItemDraft);
  router.post('/marketing/campaigns/:campaignId/items/:itemId/gmail-draft', postCreateCampaignItemGmailDraft);
  router.post('/marketing/campaigns/:campaignId/items/:itemId/manual-submitted', postMarkCampaignItemManualSubmitted);

  router.get('/api/marketing/outlets', getOutletsApi);
  router.get('/api/marketing/outlets/summary', getOutletsSummaryApi);
  router.get('/api/marketing/outreach-items', getOutreachItemsApi);
  router.get('/api/marketing/outreach-events', getOutreachEventsApi);
  router.get('/api/marketing/outreach-summary', getOutreachSummaryApi);
  router.post('/api/marketing/outreach-run', postCreateOutreachRunApi);
  router.post('/api/marketing/outreach-drafts/generate', postGenerateOutreachDraftsApi);
  router.post('/api/marketing/gmail-drafts/campaign', postCreateCampaignGmailDraftsApi);
  router.post('/api/marketing/gmail-drafts/item/:itemId', postCreateItemGmailDraftApi);
  router.post('/api/marketing/agents/inbox-scan', postInboxScanApi);
  router.post('/api/marketing/inbox-scan', postInboxScanApi);
  router.post('/api/social/daily/run-dry-run', postRunDailySocialDryRun);
  router.post('/api/social/daily/:campaignId/approve', postApproveDailySocialCampaign);
  router.post('/api/social/daily/:campaignId/publish', postPublishDailySocialCampaign);
  router.post('/api/social/posts/:postId/regenerate-copy', postRegenerateSocialCopy);
  router.post('/api/social/posts/:postId/skip', postSkipSocialPost);

  app.use(router);
}

async function getReleaseCockpitStateApi(req, res) {
  try {
    const cockpit = await withTimeout('Release cockpit state', () => buildReleaseCockpitViewModel(req.params.type, req.params.id));
    if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
    res.json({ ok: true, cockpit });
  } catch (error) {
    res.status(504).json({ ok: false, error: error.message });
  }
}

async function getReleaseCockpitAssetsStateApi(req, res) {
  try {
    const cockpit = await withTimeout('Release assets state', () => buildReleaseCockpitViewModel(req.params.type, req.params.id));
    if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
    res.json({
      ok: true,
      releaseType: cockpit.type,
      releaseId: cockpit.id,
      canonicalMediaOwner: cockpit.canonicalMediaOwner,
      releaseAssetState: cockpit.releaseAssetState,
      stages: cockpit.stages.filter(stage => stage.key === 'media'),
    });
  } catch (error) {
    res.status(504).json({ ok: false, error: error.message });
  }
}

async function getReleaseCockpitDistributionStateApi(req, res) {
  try {
    const cockpit = await withTimeout('Release distribution state', () => buildReleaseCockpitViewModel(req.params.type, req.params.id));
    if (!cockpit) return res.status(404).json({ ok: false, error: 'Release not found' });
    const distStageKeys = new Set(['package', 'distrokid_preview', 'distrokid_live_submit', 'hyperfollow', 'platform_links']);
    res.json({
      ok: true,
      releaseType: cockpit.type,
      releaseId: cockpit.id,
      lifecycle: cockpit.lifecycle,
      packageState: cockpit.packageState,
      hyperfollow: cockpit.hyperfollow,
      stages: cockpit.stages.filter(stage => distStageKeys.has(stage.key)),
    });
  } catch (error) {
    res.status(504).json({ ok: false, error: error.message });
  }
}

function postRemoveAlbumTrack(req, res) {
  try {
    const songIds = normalizeSongIdList(req.body?.song_id || req.body?.songId || req.body?.song_ids || req.body?.songIds);
    removeSongsFromAlbum(req.params.id, songIds);
    markReleaseAssetsStale('album', req.params.id);
    res.redirect(303, `/albums/${encodeURIComponent(req.params.id)}`);
  } catch (error) {
    res.status(/not found/i.test(error.message) ? 404 : 400).send(error.message);
  }
}

function postSelectReleaseAudio(req, res) {
  try {
    const song = getSong(req.params.id);
    if (!song) return res.status(404).send('Song not found');
    const filePath = String(req.body?.file_path || req.body?.filePath || '').trim();
    if (!filePath) return res.status(400).send('file_path is required');

    selectReleaseAudio(song.id, filePath);
    markReleaseAssetsStale('song', song.id);
    if (song.album_id) markReleaseAssetsStale('album', song.album_id);

    const back = String(req.body?.return_to || '').trim();
    res.redirect(303, back || `/songs/${encodeURIComponent(song.id)}`);
  } catch (error) {
    res.status(400).send(error.message);
  }
}

function normalizeSongIdList(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(raw.map(id => String(id || '').trim()).filter(Boolean))];
}

async function withTimeout(label, work, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
