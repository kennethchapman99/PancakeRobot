import {
  getDueSocialPosts,
  getSocialPostsByCampaignId,
  updateDailySocialCampaign,
  updateSocialPost,
} from '../shared/social-publishing-db.js';
import { executeSocialPublish } from '../shared/social/social-publisher.js';
import { getSocialEnv } from '../shared/social/social-env.js';

function statusFromResult(result) {
  if (result.ok) return result.dryRun ? 'ready' : 'published';
  const errorText = (result.errors || []).join(' ').toLowerCase();
  if (!result.config?.ok && getSocialEnv().socialPublishMode === 'live') return 'needs_auth';
  if (errorText.includes('public https') || errorText.includes('policy')) return 'blocked_by_policy';
  return 'failed';
}

function buildValidationWarnings(result) {
  const warnings = [...(result.warnings || [])];
  if (result.youtubeAsset?.ok) {
    const action = result.youtubeAsset.reused ? 'reused' : 'generated';
    warnings.push(`YouTube MP4 ${action}: ${result.youtubeAsset.videoPath}`);
    if (result.youtubeAsset.sourceAudioPath) warnings.push(`YouTube source audio: ${result.youtubeAsset.sourceAudioPath}`);
    if (result.youtubeAsset.sourceImagePath) warnings.push(`YouTube source image: ${result.youtubeAsset.sourceImagePath}`);
  }
  return warnings;
}

export async function processSocialPost(post, options = {}) {
  const result = await executeSocialPublish(post, options.overrides || {});
  const nextStatus = statusFromResult(result);
  const assetPatch = result.assetPatch || {};
  const patch = {
    ...assetPatch,
    status: nextStatus,
    validation_warnings: buildValidationWarnings(result),
    error_code: result.ok ? null : (result.errorCode || nextStatus),
    error_message: result.ok ? null : (result.errors || []).join(' '),
  };

  if (nextStatus === 'published') {
    patch.published_at = new Date().toISOString();
    patch.platform_post_id = result.platformPostId || `todo_${post.platform}_${Date.now().toString(36)}`;
    patch.platform_post_url = result.platformPostUrl || post.platform_post_url || '';
  }

  return updateSocialPost(post.id, patch);
}

export async function runSocialPublishWorker({ nowIso = new Date().toISOString(), campaignId = null, postIds = null, force = false, overrides = {} } = {}) {
  const env = getSocialEnv();
  const candidates = campaignId
    ? getSocialPostsByCampaignId(campaignId)
    : getDueSocialPosts(nowIso);
  const filtered = candidates.filter(post => {
    if (Array.isArray(postIds) && postIds.length) return postIds.includes(post.id);
    if (force) return ['draft', 'approved', 'ready', 'failed', 'needs_auth', 'blocked_by_policy'].includes(post.status);
    return ['draft', 'approved', 'ready', 'failed'].includes(post.status);
  });

  const processed = [];
  for (const post of filtered) {
    processed.push(await processSocialPost(post, { overrides }));
  }

  if (campaignId) {
    const posts = getSocialPostsByCampaignId(campaignId);
    const hasFailure = posts.some(post => ['failed', 'needs_auth', 'blocked_by_policy'].includes(post.status));
    const allPublished = posts.length > 0 && posts.every(post => post.status === 'published' || post.status === 'skipped');
    updateDailySocialCampaign(campaignId, {
      status: allPublished ? 'published' : hasFailure ? 'attention_required' : (env.dailySocialRequireApproval ? 'ready_for_review' : 'queued'),
    });
  }

  return { processed };
}
