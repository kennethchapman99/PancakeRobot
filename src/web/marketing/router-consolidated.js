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

export function registerMarketingRouter(app) {
  const router = express.Router();

  router.get('/marketing', renderMarketingDashboard);
  router.post('/marketing/outreach-run', postOutreachRun);
  router.post('/marketing/agents/inbox-scan', postInboxScan);
  router.post('/marketing/inbox-scan', postInboxScan);
  router.post('/marketing/releases/:songId/base-image', postReleaseBaseImage);
  router.post('/marketing/releases/:songId/build-pack', postBuildReleaseMarketingPack);

  router.get('/marketing/outlets', renderOutletsPage);

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

  app.use(router);
}
