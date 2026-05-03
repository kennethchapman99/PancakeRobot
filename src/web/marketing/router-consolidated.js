import express from 'express';
import { renderMarketingDashboard, postOutreachRun, postInboxScan } from './controllers/dashboard-controller.js';
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
  router.get('/api/marketing/outreach-summary', getOutreachSummaryApi);
  router.post('/api/marketing/outreach-run', postCreateOutreachRunApi);
  router.post('/api/marketing/outreach-drafts/generate', postGenerateOutreachDraftsApi);
  router.post('/api/marketing/gmail-drafts/campaign', postCreateCampaignGmailDraftsApi);
  router.post('/api/marketing/gmail-drafts/item/:itemId', postCreateItemGmailDraftApi);
  router.post('/api/marketing/agents/inbox-scan', postInboxScanApi);
  router.post('/api/marketing/inbox-scan', postInboxScanApi);

  app.use(router);
}
