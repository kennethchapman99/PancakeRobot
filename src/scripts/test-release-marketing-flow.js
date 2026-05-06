const dryRun = process.argv.includes('--dry-run');
const useMainDb = process.argv.includes('--use-main-db');
const explicitSlug = process.env.PIPELINE_APP_SLUG;

if (!useMainDb && !explicitSlug) {
  process.env.PIPELINE_APP_SLUG = `music-pipeline-test-release-flow-${Date.now()}`;
}

const dbSlug = process.env.PIPELINE_APP_SLUG || 'music-pipeline';
const runToken = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const suffix = runToken.toUpperCase();
const songId = `SONG_RELEASE_MARKETING_TEST_${suffix}`;
const validTargetId = `TARGET_VALID_RELEASE_TEST_${suffix}`;
const paidTargetId = `TARGET_PAID_RELEASE_TEST_${suffix}`;
const aiBannedTargetId = `TARGET_AI_BANNED_RELEASE_TEST_${suffix}`;

console.log(`[release-marketing-test] DB slug: ${dbSlug}`);
console.log(`[release-marketing-test] Mode: ${dryRun ? 'dry-run' : 'write'}`);
console.log(`[release-marketing-test] Scope: ${useMainDb ? 'main-db-compatible unique IDs' : 'isolated test DB'}`);

const summary = [];

const { upsertSong, getSong, getDb } = await import('../shared/db.js');
const { upsertMarketingTarget, getMarketingCampaigns } = await import('../shared/marketing-db.js');
const { getOrCreateReleaseMarketing, updateReleaseMarketing, getReleaseMarketingDashboard } = await import('../shared/marketing-releases.js');
const { createOutreachRun } = await import('../agents/marketing-outreach-run-agent.js');
const { generateDraftsForCampaign } = await import('../agents/marketing-outreach-draft-agent.js');
const { createGmailDraftsForCampaign } = await import('../agents/marketing-gmail-draft-agent.js');
const { getOutreachItems, getOutreachItem } = await import('../shared/marketing-outreach-db.js');
const { transitionOutreachItem } = await import('../shared/marketing-outreach-state.js');
const { classifyMessage } = await import('../marketing/gmail-reader.js');
const { processInboxMessages } = await import('../agents/marketing-inbox-agent.js');

ensureTestSong();
pushSummary('release created/opened', songId);

const release = getOrCreateReleaseMarketing(songId);
updateReleaseMarketing(release.id, {
  release_status: 'uploaded_to_distrokid',
  readiness: {
    audioFinal: true,
    artworkFinal: true,
    lyricsFinal: true,
    metadataFinal: true,
    cleanExplicitFlag: 'clean',
    aiDisclosureApproved: true,
    parentSafeQaStatus: 'passed',
    notes: 'Dry-run readiness populated by script.',
  },
  distribution: {
    distrokidUploaded: true,
    distrokidUploadDate: '2026-05-05',
    upc: `123456${suffix.slice(-6).padStart(6, '0').replace(/[^0-9]/g, '7').slice(0, 6)}`,
    isrc: `US-RMT-26-${suffix.replace(/[^A-Z0-9]/g, '').slice(0, 5).padEnd(5, '0')}`,
    hyperfollowUrl: `https://example.com/hyperfollow/${songId.toLowerCase()}`,
    spotifyUrl: `https://open.spotify.com/track/${songId.toLowerCase()}`,
    appleMusicUrl: `https://music.apple.com/us/song/${songId.toLowerCase()}`,
    youtubeMusicUrl: `https://music.youtube.com/watch?v=${songId.toLowerCase()}`,
    manualNotes: 'Manual DistroKid fields seeded by dry-run script.',
  },
  asset_pack: {
    sourceArtworkPath: `output/songs/${songId}/reference/base-image.png`,
    sourceArtworkLocked: true,
    generatedAt: new Date().toISOString(),
    assets: [
      { id: `square_${suffix}`, type: 'square_cover', pathOrUrl: `output/marketing-ready/${songId}/instagram/ig-square-post-1080x1080.png`, status: 'generated', promptUsed: 'dry-run manifest', sourceArtworkUsed: true },
      { id: `vertical_${suffix}`, type: 'vertical_video', pathOrUrl: `output/marketing-ready/${songId}/tiktok/tiktok-hook.mp4`, status: 'generated', promptUsed: 'dry-run manifest', sourceArtworkUsed: true },
      { id: `caption_${suffix}`, type: 'caption_set', pathOrUrl: `output/marketing-ready/${songId}/captions.md`, status: 'generated', promptUsed: 'dry-run manifest', sourceArtworkUsed: false },
    ],
  },
});

const targets = seedTargets();
pushSummary('targets seeded', targets.map(target => target.id).join(', '));

const run = createOutreachRun({
  song_ids: [songId],
  outlet_ids: targets.map(target => target.id),
  dry_run: dryRun,
  release_marketing_id: release.id,
});
const campaignId = run.campaigns[0].campaign_id;
const campaign = getMarketingCampaigns(500).find(entry => entry.id === campaignId);

const excludedIds = new Set(campaign.excluded_target_ids || []);
assert(excludedIds.has(paidTargetId), 'Expected paid-only target to be excluded');
pushSummary('excluded paid-only target', paidTargetId);
assert(excludedIds.has(aiBannedTargetId), 'Expected AI-banned target to be excluded');
pushSummary('excluded AI-banned target', aiBannedTargetId);

assert(campaign.approved_target_ids.length === 1, `Expected 1 valid target after exclusions, got ${campaign.approved_target_ids.length}`);
assert(campaign.approved_target_ids[0] === validTargetId, `Expected valid target ${validTargetId} to be selected`);
pushSummary('valid target selected', validTargetId);
pushSummary('campaign created', campaignId);

await generateDraftsForCampaign(campaignId, { deterministic: true });
await createGmailDraftsForCampaign(campaignId, { dryRun: true });
pushSummary('outreach draft simulated', campaignId);

const validItem = getOutreachItems({ campaign_id: campaignId })[0];
transitionOutreachItem(validItem.id, 'mark_sent', {
  actor: 'test-release-marketing-flow',
  message: 'Dry-run send simulated',
});

const refreshedItem = getOutreachItem(validItem.id);
const replySeed = {
  gmail_message_id: `dryrun-reply-${runToken}`,
  gmail_thread_id: refreshedItem.gmail_thread_id,
  from_email: 'editor@familyplaylist.example',
  subject: `Re: ${refreshedItem.subject}`,
  snippet: 'Please send the link over.',
  body_text: 'This sounds like a fit. Please send it over.',
  received_at: new Date().toISOString(),
  labels: ['INBOX'],
};
const classifiedReply = { ...replySeed, ...classifyMessage(replySeed) };
processInboxMessages([classifiedReply]);
pushSummary('inbox reply simulated/classified', `${classifiedReply.classification}`);

const dashboard = getReleaseMarketingDashboard(release.id);
const validTargetRow = getDb().prepare(`
  SELECT id, name, suppression_status, last_contact_at, last_contact_release_title, last_contact_subject, last_outcome
  FROM marketing_targets
  WHERE id = ?
`).get(validTargetId);
assert(validTargetRow?.last_contact_at, 'Expected valid target last_contact_at to be updated');
assert(validTargetRow?.last_contact_release_title === 'Release Marketing Dry Run', 'Expected valid target last contact release title to be updated');
assert(validTargetRow?.last_outcome === 'replied', 'Expected valid target last outcome to be replied');
pushSummary('target last-contact updated', `${validTargetRow.last_contact_at} / ${validTargetRow.last_outcome}`);

const targetRows = getDb().prepare(`
  SELECT id, name, suppression_status, last_contact_at, last_contact_release_title, last_contact_subject, last_outcome
  FROM marketing_targets
  WHERE id IN (${targets.map(() => '?').join(',')})
  ORDER BY name
`).all(...targets.map(target => target.id));

console.log('\nRelease marketing dry-run summary\n');
console.table([{
  dbSlug,
  releaseMarketingId: release.id,
  selectedTargets: campaign.approved_target_ids.length,
  excludedTargets: campaign.excluded_target_ids.length,
  drafts: dashboard.outreachItems.length,
  replies: dashboard.results.replies,
  opportunities: dashboard.results.opportunities,
  dryRun,
}]);
console.table(targetRows);

console.log('\nChecklist\n');
for (const item of summary) {
  console.log(`- ${item.step}: ${item.value}`);
}

function ensureTestSong() {
  const existing = getSong(songId);
  if (existing) return existing;
  upsertSong({
    id: songId,
    title: 'Release Marketing Dry Run',
    topic: 'Test release flow',
    status: 'submitted to DistroKid',
    is_test: true,
    release_date: '2026-05-16',
    distributor: 'DistroKid',
    notes: `Created by test-release-marketing-flow.js (${runToken})`,
  });
  return getSong(songId);
}

function seedTargets() {
  const rows = [
    {
      id: validTargetId,
      name: `Family Playlist Test ${suffix}`,
      type: 'playlist',
      platform: 'email',
      source_url: `https://familyplaylist.example/${runToken}`,
      contact_email: 'editor@familyplaylist.example',
      public_email: 'editor@familyplaylist.example',
      status: 'approved',
      ai_policy: 'allowed',
      fit_score: 90,
      contactability: { status: 'contactable', free_contact_method_found: true, best_channel: 'email', contact_methods: [{ type: 'email', value: 'editor@familyplaylist.example' }] },
      cost_policy: { requires_payment: false, cost_type: 'free' },
      outreach_eligibility: { eligible: true, reason_codes: [] },
    },
    {
      id: paidTargetId,
      name: `Paid Submission Test ${suffix}`,
      type: 'blog',
      platform: 'email',
      source_url: `https://paidsubmit.example/${runToken}`,
      contact_email: 'paid@paidsubmit.example',
      public_email: 'paid@paidsubmit.example',
      status: 'approved',
      ai_policy: 'allowed',
      suppression_status: 'paid_only',
      fit_score: 70,
      contactability: { status: 'contactable', free_contact_method_found: true, best_channel: 'email', contact_methods: [{ type: 'email', value: 'paid@paidsubmit.example' }] },
      cost_policy: { requires_payment: true, cost_type: 'paid_submission' },
      outreach_eligibility: { eligible: false, reason_codes: ['paid_submission_only'] },
    },
    {
      id: aiBannedTargetId,
      name: `AI Banned Test ${suffix}`,
      type: 'blog',
      platform: 'email',
      source_url: `https://aibanned.example/${runToken}`,
      contact_email: 'editor@aibanned.example',
      public_email: 'editor@aibanned.example',
      status: 'approved',
      ai_policy: 'banned',
      suppression_status: 'ai_banned',
      fit_score: 80,
      contactability: { status: 'contactable', free_contact_method_found: true, best_channel: 'email', contact_methods: [{ type: 'email', value: 'editor@aibanned.example' }] },
      cost_policy: { requires_payment: false, cost_type: 'free' },
      outreach_eligibility: { eligible: false, reason_codes: ['ai_music_banned'] },
    },
  ];
  rows.forEach(upsertMarketingTarget);
  return rows;
}

function pushSummary(step, value) {
  summary.push({ step, value });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
