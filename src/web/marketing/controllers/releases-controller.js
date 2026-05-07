import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import fs from 'fs';
import { getAllSongs, getSong, upsertSong, upsertReleaseLink, getReleaseLinks } from '../../../shared/db.js';
import { SONG_STATUSES, getSongStatusLabel } from '../../../shared/song-status.js';
import { getMarketingCampaigns, getMarketingCampaignById, updateMarketingCampaign, updateMarketingTarget } from '../../../shared/marketing-db.js';
import { getOrCreateReleaseMarketing, getReleaseMarketingById, getReleaseMarketingDashboard, updateReleaseMarketing, resolveSourceArtworkPath } from '../../../shared/marketing-releases.js';
import { createOutreachRun, getCanonicalEmailOutletsForSelection } from '../../../agents/marketing-outreach-run-agent.js';
import { createGmailDraftForOutreachItem } from '../../../agents/marketing-gmail-draft-agent.js';
import { runInboxScan } from '../../../agents/marketing-inbox-agent.js';
import { buildSongReleaseAssets } from '../../../shared/song-release-assets-service.js';
import { getInboxMessages } from '../../../shared/marketing-inbox-db.js';
import { getOutreachItem, getOutreachItems, updateOutreachItem } from '../../../shared/marketing-outreach-db.js';
import { canTransitionOutreachItem, transitionOutreachItem } from '../../../shared/marketing-outreach-state.js';
import { getSongMarketingKit } from '../../../shared/song-marketing-kit.js';
import { renderMarketingLayout } from '../views/layout.js';
import { esc, attr, redirect } from '../utils/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const multer = _require('multer');
const RELEASE_TABS = [
  ['audience', 'Audience'],
  ['drafts', 'Drafts'],
  ['results', 'Results'],
];
const LEGACY_TAB_MAP = {
  readiness: 'audience',
  distribution: 'audience',
  assets: 'audience',
  'gmail-inbox': 'audience',
  'outreach-drafts': 'drafts',
};
const DEFAULT_SUBJECT_TEMPLATE = '{{artistName}} - {{songTitle}} for {{outletName}}';
const DEFAULT_BODY_TEMPLATE = `Hi {{contactName}},

I’m reaching out with {{songTitle}} from {{artistName}} because it feels like a strong fit for {{outletName}}.

Why I thought of you: {{whyThisOutletFits}}

Quick release notes:
- Brand: {{brandName}}
- Release blurb: {{releaseBlurb}}
- Short description: {{shortDescription}}

Key links:
- Listen / release page: {{releaseLink}}
- Hyperfollow: {{hyperfollowLink}}
- Spotify: {{spotifyLink}}
- Apple Music: {{appleMusicLink}}
- YouTube: {{youtubeLink}}
- Instagram: {{instagramLink}}
- TikTok: {{tiktokLink}}
- Press kit: {{pressKitLink}}

Happy to send anything else that helps.

Best,
Kenneth
{{brandName}}`;

const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aiff', '.m4a']);

function buildAudioUpload(songId) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = join(__dirname, '../../../../../output/songs', songId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase() || '.mp3';
        cb(null, `audio${ext}`);
      },
    }),
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      cb(null, ALLOWED_AUDIO_EXTS.has(extname(file.originalname).toLowerCase()));
    },
  });
}

export function renderNewRelease(req, res) {
  const songs = getAllSongs().sort((a, b) => (a.title || a.topic || '').localeCompare(b.title || b.topic || ''));
  const error = req.query.error || null;

  const songOptions = songs.map(s =>
    `<option value="${attr(s.id)}">${esc(s.title || s.topic || s.id)} (${esc(getSongStatusLabel(s.status))})</option>`
  ).join('');

  const body = `<main class="p-8 max-w-2xl mx-auto space-y-6">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <h1 class="text-2xl font-extrabold mb-1">Add Release</h1>
      <p class="text-sm text-zinc-500 mb-6">Link a song to the marketing release list and fill in distribution details. <a href="/marketing" class="text-blue-600 hover:underline">← Marketing</a></p>
      ${error ? `<div class="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">${esc(error)}</div>` : ''}
      <form method="POST" action="/marketing/releases" enctype="multipart/form-data" class="space-y-5">

        <div>
          <label class="block text-sm font-semibold mb-1">Song <span class="text-red-500">*</span></label>
          <select name="song_id" required class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            <option value="">— select a song —</option>
            ${songOptions}
          </select>
          <p class="text-xs text-zinc-400 mt-1">Must be an existing song in the catalog. <a href="/songs" class="text-blue-600 hover:underline">Browse songs →</a></p>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-semibold mb-1">Release date</label>
            <input type="date" name="release_date" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-sm font-semibold mb-1">Distributor</label>
            <input type="text" name="distributor" placeholder="e.g. DistroKid" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
          </div>
        </div>

        <div>
          <label class="block text-sm font-semibold mb-1">Promote to status</label>
          <select name="status" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            <option value="">— keep current status —</option>
            <option value="${attr(SONG_STATUSES.DRAFT)}">Draft</option>
            <option value="${attr(SONG_STATUSES.EDITING)}">Editing</option>
            <option value="${attr(SONG_STATUSES.SUBMITTED_TO_DISTROKID)}">Submitted to DistroKid</option>
            <option value="${attr(SONG_STATUSES.OUTREACH_COMPLETE)}">Outreach Complete</option>
            <option value="${attr(SONG_STATUSES.ARCHIVED)}">Archived</option>
          </select>
          <p class="text-xs text-zinc-400 mt-1">Songs appear in the marketing release list when marked submitted to DistroKid or when they already have release metadata.</p>
        </div>

        <div>
          <label class="block text-sm font-semibold mb-2">Streaming links</label>
          <div id="links" class="space-y-2">
            <div class="flex gap-2">
              <input type="text" name="link_platform[]" placeholder="Platform (e.g. Spotify)" class="w-40 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
              <input type="url" name="link_url[]" placeholder="https://..." class="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            </div>
            <div class="flex gap-2">
              <input type="text" name="link_platform[]" placeholder="Platform (e.g. Apple Music)" class="w-40 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
              <input type="url" name="link_url[]" placeholder="https://..." class="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            </div>
            <div class="flex gap-2">
              <input type="text" name="link_platform[]" placeholder="Platform (e.g. YouTube)" class="w-40 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
              <input type="url" name="link_url[]" placeholder="https://..." class="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm">
            </div>
          </div>
        </div>

        <div>
          <label class="block text-sm font-semibold mb-1">Audio file <span class="text-zinc-400 font-normal">(optional — mp3/wav/flac)</span></label>
          <input type="file" name="audio_file" accept=".mp3,.wav,.flac,.aiff,.m4a" class="block w-full text-sm text-zinc-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-zinc-200 file:text-sm file:bg-zinc-50 hover:file:bg-zinc-100">
          <p class="text-xs text-zinc-400 mt-1">Saved as <code>audio.mp3</code> (or matching extension) in the song's output directory.</p>
        </div>

        <div>
          <label class="block text-sm font-semibold mb-1">Marketing notes</label>
          <textarea name="notes" rows="3" placeholder="Any notes for the marketing team…" class="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm resize-none"></textarea>
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <a href="/marketing" class="border border-zinc-200 rounded-lg px-4 py-2 text-sm hover:bg-zinc-50">Cancel</a>
          <button type="submit" class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Save release</button>
        </div>
      </form>
    </section>
  </main>`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout('Add Release', body));
}

export function postNewRelease(req, res) {
  const songId = (req.body?.song_id || '').trim();
  if (!songId) {
    return redirect(res, `/marketing/releases/new?error=${encodeURIComponent('Please select a song.')}`);
  }

  const song = getSong(songId);
  if (!song) {
    return redirect(res, `/marketing/releases/new?error=${encodeURIComponent('Song not found.')}`);
  }

  const fields = {};
  if (req.body.release_date) fields.release_date = req.body.release_date;
  if (req.body.distributor?.trim()) fields.distributor = req.body.distributor.trim();
  if (req.body.status) fields.status = req.body.status;
  if (req.body.notes?.trim()) fields.notes = req.body.notes.trim();

  if (req.file) {
    fields.audio_prompt_path = req.file.path;
  }

  if (Object.keys(fields).length) {
    upsertSong({ id: songId, ...fields });
  }

  // Save streaming links
  const platforms = [].concat(req.body['link_platform[]'] || []);
  const urls = [].concat(req.body['link_url[]'] || []);
  for (let i = 0; i < platforms.length; i++) {
    const platform = (platforms[i] || '').trim();
    const url = (urls[i] || '').trim();
    if (platform && url) {
      upsertReleaseLink(songId, platform, url);
    }
  }

  redirect(res, `/songs/${songId}?message=${encodeURIComponent('Release info saved.')}`);
}

// Multer middleware that resolves the song ID from req.body first (multipart)
export function handleNewReleaseUpload(req, res, next) {
  // We need to parse multipart to get song_id, then handle the file.
  // Use a temporary memoryStorage pass to get body fields first.
  const tmpUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }).single('audio_file');
  tmpUpload(req, res, (err) => {
    if (err && err.code !== 'LIMIT_UNEXPECTED_FILE') return next(err);

    const songId = (req.body?.song_id || '').trim();
    if (!songId || !req.file) return next(); // no file or no songId — skip disk write

    // Write the in-memory buffer to the correct output directory
    const dir = join(__dirname, '../../../../../output/songs', songId);
    fs.mkdirSync(dir, { recursive: true });
    const ext = extname(req.file.originalname).toLowerCase() || '.mp3';
    const dest = join(dir, `audio${ext}`);
    try {
      fs.writeFileSync(dest, req.file.buffer);
      req.file.path = dest;
    } catch (writeErr) {
      console.error('[releases] audio write failed', writeErr.message);
      req.file = null;
    }
    next();
  });
}

export function postPromoteRelease(req, res) {
  try {
    const song = getSong(req.params.songId);
    if (!song) throw new Error('Song not found');
    const release = getOrCreateReleaseMarketing(song.id);
    redirect(res, `/marketing/releases/${release.id}?tab=audience`);
  } catch (error) {
    redirect(res, `/songs/${encodeURIComponent(req.params.songId)}?error=${encodeURIComponent(error.message)}`);
  }
}

export function renderReleaseMarketing(req, res) {
  const dashboard = getReleaseMarketingDashboard(req.params.releaseMarketingId);
  if (!dashboard) {
    res.statusCode = 404;
    res.end(renderMarketingLayout('Release not found', '<main class="p-8">Release marketing record not found.</main>'));
    return;
  }

  const requestedTab = String(req.query.tab || '').toLowerCase();
  const tab = normalizeReleaseTab(requestedTab);
  if (requestedTab !== tab) {
    return redirect(res, buildReleasePageUrl(dashboard.release.id, tab, req.query));
  }
  const campaign = dashboard.latestCampaign;
  dashboard.queryItemId = String(req.query.item || '');
  const outletRows = getCanonicalEmailOutletsForSelection();
  const notices = [
    req.query.message ? `<div class="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">${esc(req.query.message)}</div>` : '',
    req.query.error ? `<div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">${esc(req.query.error)}</div>` : '',
  ].join('');
  const body = `<main class="p-8 space-y-6">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <a href="/songs/${attr(dashboard.song.id)}" class="text-sm text-blue-600 hover:underline">← Back to song</a>
          <h1 class="text-3xl font-extrabold mt-2">${esc(dashboard.release.title)}</h1>
          <div class="text-sm text-zinc-500 mt-2">${esc(dashboard.release.artistName || 'Pancake Robot')} · ${esc(dashboard.release.releaseStatus)} · ${esc(dashboard.release.releaseDate || 'No date set')}</div>
        </div>
        <div class="text-right text-sm text-zinc-500">
          <div>${dashboard.selectedTargetsCount} selected · ${dashboard.draftsReadyCount} previews ready</div>
          <div>${dashboard.latestCampaignItems.filter(item => item.gmail_draft_id).length} Gmail drafts · ${dashboard.latestCampaignItems.filter(item => item.last_error).length} need attention</div>
          <div>${dashboard.results.replies} replies · ${dashboard.results.opportunities} opportunities</div>
        </div>
      </div>
    </section>
    ${notices}
    ${renderReleaseTabs(dashboard.release.id, tab)}
    ${renderTabBody(tab, dashboard, campaign, outletRows)}
  </main>`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout(`Release Marketing - ${dashboard.release.title}`, body));
}

export function postUpdateReleaseReadiness(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  if (!release) return redirect(res, '/marketing?error=Release%20not%20found');
  const readiness = {
    audioFinal: req.body.audioFinal === 'on',
    artworkFinal: req.body.artworkFinal === 'on',
    lyricsFinal: req.body.lyricsFinal === 'on',
    metadataFinal: req.body.metadataFinal === 'on',
    cleanExplicitFlag: req.body.cleanExplicitFlag || null,
    aiDisclosureApproved: req.body.aiDisclosureApproved === 'on',
    parentSafeQaStatus: req.body.parentSafeQaStatus || null,
    notes: req.body.notes || '',
  };
  const releaseStatus = req.body.release_status || release.releaseStatus;
  updateReleaseMarketing(release.id, { readiness, release_status: releaseStatus });
  redirect(res, `/marketing/releases/${release.id}?tab=readiness`);
}

export function postUpdateReleaseDistribution(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  if (!release) return redirect(res, '/marketing?error=Release%20not%20found');
  updateReleaseMarketing(release.id, {
    distribution: {
      distrokidUploaded: req.body.distrokidUploaded === 'on',
      distrokidUploadDate: req.body.distrokidUploadDate || null,
      upc: req.body.upc || '',
      isrc: req.body.isrc || '',
      hyperfollowUrl: req.body.hyperfollowUrl || '',
      spotifyUri: req.body.spotifyUri || '',
      spotifyUrl: req.body.spotifyUrl || '',
      appleMusicUrl: req.body.appleMusicUrl || '',
      youtubeMusicUrl: req.body.youtubeMusicUrl || '',
      otherLinks: splitLines(req.body.otherLinks).map(url => ({ url })),
      manualNotes: req.body.manualNotes || '',
    },
    release_status: req.body.release_status || release.releaseStatus,
    release_date: req.body.release_date || release.releaseDate,
  });
  redirect(res, `/marketing/releases/${release.id}?tab=distribution`);
}

export async function postBuildReleaseAssets(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  if (!release) return redirect(res, '/marketing?error=Release%20not%20found');
  const sourceArtworkPath = req.body.sourceArtworkPath || release.assetPack?.sourceArtworkPath || resolveSourceArtworkPath(release.songId);
  updateReleaseMarketing(release.id, {
    asset_pack: {
      ...release.assetPack,
      sourceArtworkPath,
      sourceArtworkLocked: req.body.sourceArtworkLocked !== 'off',
    },
  });
  try {
    await buildSongReleaseAssets(release.songId, { sourceArtworkPath, mode: 'render_from_existing_visuals' });
    redirect(res, `/marketing/releases/${release.id}?tab=assets`);
  } catch (error) {
    redirect(res, `/marketing/releases/${release.id}?tab=assets&error=${encodeURIComponent(error.message)}`);
  }
}

export async function postSelectReleaseAudience(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  if (!release) return redirect(res, '/marketing?error=Release%20not%20found');
  try {
    const dryRun = false;
    const result = createOutreachRun({
      song_ids: [release.songId],
      outlet_ids: toArray(req.body.outlet_ids),
      mode: 'single_release',
      allow_same_release: booleanFromForm(req.body.allow_same_release, false),
      dry_run: dryRun,
      release_marketing_id: release.id,
    });
    const campaignId = result.campaigns?.[0]?.campaign_id;
    if (!campaignId) throw new Error('Outreach run did not create a campaign.');
    ensureCampaignTemplates(campaignId);
    const previewResult = generateReleaseDraftPreviews(campaignId);
    const summary = `Outreach run created for ${previewResult.previewed} target(s). Review drafts before creating Gmail drafts.`;
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { message: summary }));
  } catch (error) {
    redirect(res, buildReleasePageUrl(release.id, 'audience', { error: error.message }));
  }
}

export function postGenerateReleaseDrafts(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const campaign = findLatestCampaign(release?.id);
  if (!release || !campaign) return redirect(res, buildReleasePageUrl(req.params.releaseMarketingId, 'drafts', { error: 'Create an audience selection first.' }));
  try {
    const dryRun = false;
    updateMarketingCampaign(campaign.id, { dry_run: dryRun });
    const result = generateReleaseDraftPreviews(campaign.id);
    const message = `Refreshed ${result.previewed} draft preview(s).`;
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { message, item: req.body.item || '' }));
  } catch (error) {
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { error: error.message, item: req.body.item || '' }));
  }
}

export async function postCreateReleaseGmailDrafts(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const campaign = findLatestCampaign(release?.id);
  if (!release || !campaign) return redirect(res, buildReleasePageUrl(req.params.releaseMarketingId, 'drafts', { error: 'Create an audience selection first.' }));
  try {
    const dryRun = false;
    const forceRecreate = true;
    updateMarketingCampaign(campaign.id, { dry_run: dryRun });
    const previewResult = generateReleaseDraftPreviews(campaign.id);

    const items = getOutreachItems({ campaign_id: campaign.id });
    let created = 0;
    let recreated = 0;
    let failures = 0;
    let missingEmail = 0;

    for (const item of items) {
      const email = getPreferredOutletEmail(item);
      if (!email) {
        missingEmail += 1;
        updateOutreachItem(item.id, {
          last_error: 'Missing email address',
          safety_status: 'missing_email',
          requires_ken: true,
        });
        continue;
      }
      try {
        const hadExistingDraft = Boolean(item.gmail_draft_id);
        const result = await createGmailDraftForOutreachItem(item.id, { dryRun: false, forceRecreate });
        if (result.ok && result.gmail_draft_id) {
          if (hadExistingDraft) recreated += 1;
          else created += 1;
        }
      } catch (error) {
        failures += 1;
        updateOutreachItem(item.id, {
          last_error: error.message,
          safety_status: 'gmail_draft_error',
          requires_ken: true,
        });
      }
    }

    const messageParts = [`${items.length} selected targets`, `${created} Gmail drafts created`];
    if (recreated) messageParts.push(`${recreated} Gmail drafts re-created`);
    if (missingEmail) messageParts.push(`${missingEmail} missing email`);
    if (failures) messageParts.push(`${failures} failed`);
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { message: messageParts.join(' · '), item: req.body.item || '' }));
  } catch (error) {
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { error: error.message, item: req.body.item || '' }));
  }
}

export function postUpdateReleaseDraftTemplate(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const campaign = findLatestCampaign(release?.id);
  if (!release || !campaign) return redirect(res, buildReleasePageUrl(req.params.releaseMarketingId, 'drafts', { error: 'Create an audience selection first.' }));
  try {
    const dryRun = false;
    const subjectTemplate = String(req.body.subject_template || '').trim() || DEFAULT_SUBJECT_TEMPLATE;
    const bodyTemplate = String(req.body.body_template || '').trim() || DEFAULT_BODY_TEMPLATE;

    updateMarketingCampaign(campaign.id, {
      dry_run: dryRun,
      subject_template: subjectTemplate,
      body_template: bodyTemplate,
    });
    updateReleaseMarketing(release.id, {
      results: {
        ...(release.results || {}),
        sharedDraftTemplate: {
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
        },
      },
    });
    const result = generateReleaseDraftPreviews(campaign.id);
    redirect(res, buildReleasePageUrl(release.id, 'drafts', {
      message: `Template saved. ${result.previewed} non-customized draft(s) refreshed.`,
      item: req.body.item || '',
    }));
  } catch (error) {
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { error: error.message, item: req.body.item || '' }));
  }
}

export function postUpdateReleaseDraftItem(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const item = getOutreachItem(req.params.itemId);
  if (!release || !item) return redirect(res, buildReleasePageUrl(req.params.releaseMarketingId, 'drafts', { error: 'Draft item not found.' }));
  try {
    const subject = String(req.body.subject || '').trim();
    const body = String(req.body.body || '').trim();
    const isCustomized = subject !== String(item.generated_subject || '').trim() || body !== String(item.generated_body || '').trim();
    updateOutreachItem(item.id, {
      subject,
      body,
      subject_override: isCustomized ? subject : null,
      body_override: isCustomized ? body : null,
      is_customized: isCustomized,
      last_error: null,
      safety_status: isCustomized ? 'customized' : 'ready_for_review',
      requires_ken: true,
    });
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { message: isCustomized ? 'Draft changes saved and marked customized.' : 'Draft saved.', item: item.id }));
  } catch (error) {
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { error: error.message, item: item.id }));
  }
}

export function postResetReleaseDraftItem(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const item = getOutreachItem(req.params.itemId);
  if (!release || !item) return redirect(res, buildReleasePageUrl(req.params.releaseMarketingId, 'drafts', { error: 'Draft item not found.' }));
  try {
    updateOutreachItem(item.id, {
      subject: item.generated_subject || '',
      body: item.generated_body || '',
      subject_override: null,
      body_override: null,
      is_customized: false,
      last_error: null,
      safety_status: 'reset_to_template',
      requires_ken: true,
    });
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { message: 'Draft reset to shared template.', item: item.id }));
  } catch (error) {
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { error: error.message, item: item.id }));
  }
}

export function postMarkReleaseDraftSent(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const item = getOutreachItem(req.params.itemId);
  if (!release || !item) return redirect(res, buildReleasePageUrl(req.params.releaseMarketingId, 'drafts', { error: 'Draft item not found.' }));
  try {
    transitionOutreachItem(item.id, 'mark_sent', {
      actor: 'ken',
      fields: {
        last_error: null,
        safety_status: 'sent',
        requires_ken: false,
      },
      message: 'Marked email as sent manually from the release drafts view',
    });
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { message: 'Email marked sent.', item: item.id }));
  } catch (error) {
    redirect(res, buildReleasePageUrl(release.id, 'drafts', { error: error.message, item: item.id }));
  }
}

export async function postScanReleaseInbox(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  if (!release) return redirect(res, '/marketing?error=Release%20not%20found');
  await runInboxScan({ dryRun: false, maxResults: 50 });
  redirect(res, `/marketing/releases/${release.id}?tab=gmail-inbox`);
}

export function postReleaseInboxAction(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const message = getInboxMessages(500).find(entry => entry.id === req.params.messageId || entry.gmail_message_id === req.params.messageId);
  if (!release || !message) return redirect(res, `/marketing/releases/${req.params.releaseMarketingId}?tab=gmail-inbox&error=${encodeURIComponent('Inbox message not found.')}`);
  const action = req.params.action;
  if (message.target_id) {
    if (action === 'do_not_contact') updateMarketingTarget(message.target_id, { suppression_status: 'do_not_contact', suppression_reason: 'Marked from inbox', suppression_source: 'release_dashboard' });
    if (action === 'paid_only') updateMarketingTarget(message.target_id, { suppression_status: 'paid_only', suppression_reason: 'Marked from inbox', suppression_source: 'release_dashboard' });
    if (action === 'bounced') updateMarketingTarget(message.target_id, { suppression_status: 'bounced', suppression_reason: 'Marked from inbox', suppression_source: 'release_dashboard' });
  }
  if (message.outreach_item_id) {
    const item = getOutreachItem(message.outreach_item_id);
    if (item && action === 'bounced') updateOutreachItem(item.id, { status: 'bounced' });
    if (item && action === 'opportunity' && item.status !== 'replied') {
      transitionOutreachItem(item.id, 'mark_replied', { actor: 'ken', message: 'Marked opportunity from inbox' });
    }
  }
  redirect(res, `/marketing/releases/${release.id}?tab=gmail-inbox`);
}

export function postUpdateReleaseResults(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  if (!release) return redirect(res, '/marketing?error=Release%20not%20found');
  updateReleaseMarketing(release.id, {
    results: {
      ...release.results,
      lessons: req.body.lessons || '',
    },
  });
  redirect(res, `/marketing/releases/${release.id}?tab=results`);
}

function renderReleaseTabs(releaseId, activeTab) {
  return `<nav class="flex flex-wrap gap-2">${RELEASE_TABS.map(([key, label]) => `<a href="/marketing/releases/${attr(releaseId)}?tab=${attr(key)}" class="rounded-lg px-3 py-2 text-sm ${activeTab === key ? 'bg-zinc-900 text-white' : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'}">${esc(label)}</a>`).join('')}</nav>`;
}

function renderTabBody(tab, dashboard, campaign, outlets) {
  if (tab === 'audience') return renderAudienceTab(dashboard, campaign, outlets);
  if (tab === 'drafts') return renderDraftsTab(dashboard, campaign);
  if (tab === 'results') return renderResultsTab(dashboard);
  return renderAudienceTab(dashboard, campaign, outlets);
}

function renderReadinessTab(release) {
  const r = release.readiness || {};
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    <form method="POST" action="/marketing/releases/${attr(release.id)}/readiness" class="space-y-4">
      <div class="grid md:grid-cols-2 gap-4">
        ${renderCheckbox('audioFinal', 'Audio final', r.audioFinal)}
        ${renderCheckbox('artworkFinal', 'Artwork final', r.artworkFinal)}
        ${renderCheckbox('lyricsFinal', 'Lyrics final', r.lyricsFinal)}
        ${renderCheckbox('metadataFinal', 'Metadata final', r.metadataFinal)}
        ${renderCheckbox('aiDisclosureApproved', 'AI disclosure approved', r.aiDisclosureApproved)}
        <label class="text-sm">Clean/explicit flag<select name="cleanExplicitFlag" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2"><option value=""></option><option value="clean" ${r.cleanExplicitFlag === 'clean' ? 'selected' : ''}>clean</option><option value="explicit" ${r.cleanExplicitFlag === 'explicit' ? 'selected' : ''}>explicit</option></select></label>
      </div>
      <label class="block text-sm">Parent-safe QA status<input name="parentSafeQaStatus" value="${attr(r.parentSafeQaStatus || '')}" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2"></label>
      <label class="block text-sm">Release status<select name="release_status" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2">${releaseStatusOptions(release.releaseStatus)}</select></label>
      <label class="block text-sm">Notes<textarea name="notes" rows="4" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2">${esc(r.notes || '')}</textarea></label>
      <button class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Save readiness</button>
    </form>
  </section>`;
}

function renderDistributionTab(release) {
  const d = release.distribution || {};
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    <form method="POST" action="/marketing/releases/${attr(release.id)}/distribution" class="space-y-4">
      <div class="grid md:grid-cols-2 gap-4">
        ${renderCheckbox('distrokidUploaded', 'Mark uploaded to DistroKid', d.distrokidUploaded)}
        <label class="text-sm">DistroKid upload date<input type="date" name="distrokidUploadDate" value="${attr(d.distrokidUploadDate || '')}" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2"></label>
        <label class="text-sm">Release date<input type="date" name="release_date" value="${attr(release.releaseDate || '')}" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2"></label>
        <label class="text-sm">Release status<select name="release_status" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2">${releaseStatusOptions(release.releaseStatus)}</select></label>
      </div>
      <div class="grid md:grid-cols-2 gap-4">
        ${renderInput('upc', 'UPC', d.upc)}
        ${renderInput('isrc', 'ISRC', d.isrc)}
        ${renderInput('hyperfollowUrl', 'HyperFollow URL', d.hyperfollowUrl, 'url')}
        ${renderInput('spotifyUri', 'Spotify URI', d.spotifyUri)}
        ${renderInput('spotifyUrl', 'Spotify URL', d.spotifyUrl, 'url')}
        ${renderInput('appleMusicUrl', 'Apple Music URL', d.appleMusicUrl, 'url')}
        ${renderInput('youtubeMusicUrl', 'YouTube Music URL', d.youtubeMusicUrl, 'url')}
      </div>
      <label class="block text-sm">Other links<textarea name="otherLinks" rows="3" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2">${esc((d.otherLinks || []).map(link => link.url || '').join('\n'))}</textarea></label>
      <label class="block text-sm">Manual notes<textarea name="manualNotes" rows="4" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2">${esc(d.manualNotes || '')}</textarea></label>
      <button class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Save distribution</button>
    </form>
  </section>`;
}

function renderAssetsTab(dashboard) {
  const assetPack = dashboard.release.assetPack || {};
  const sourcePath = assetPack.sourceArtworkPath || '';
  const warningHtml = dashboard.assetWarnings.length
    ? `<div class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Some assets were generated without the locked source artwork.</div>`
    : '';
  const assets = (assetPack.assets || []).map(asset => `<tr class="border-t border-zinc-100"><td class="py-2 pr-3 text-sm">${esc(asset.type || asset.name || asset.id)}</td><td class="py-2 pr-3 text-sm">${esc(asset.status || 'generated')}</td><td class="py-2 pr-3 text-xs">${asset.sourceArtworkUsed ? 'yes' : 'no'}</td><td class="py-2 text-xs text-zinc-500 break-all">${esc(asset.pathOrUrl || asset.path || '')}</td></tr>`).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
    ${warningHtml}
    <form method="POST" action="/marketing/releases/${attr(dashboard.release.id)}/assets/build" class="space-y-4">
      ${renderInput('sourceArtworkPath', 'Source artwork path', sourcePath)}
      ${renderCheckbox('sourceArtworkLocked', 'Lock generated assets to this source artwork', assetPack.sourceArtworkLocked !== false)}
      <button class="bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm font-semibold">Generate or refresh asset pack</button>
    </form>
    <div class="overflow-x-auto"><table class="w-full text-left"><thead><tr class="text-xs uppercase text-zinc-400"><th class="pb-2">Asset</th><th class="pb-2">Status</th><th class="pb-2">Source art used</th><th class="pb-2">Path</th></tr></thead><tbody>${assets || '<tr><td colspan="4" class="py-4 text-sm text-zinc-400">No asset manifest yet.</td></tr>'}</tbody></table></div>
  </section>`;
}

function renderAudienceTab(dashboard, campaign, outlets) {
  const selectedIds = new Set(campaign?.approved_target_ids || []);
  const selectedDefaultCount = selectedIds.size || outlets.length;
  const statusCopy = campaign
    ? renderDraftStatusCopy(campaign, dashboard.latestCampaignItems)
    : `${selectedDefaultCount} selected targets · Ready to create Gmail drafts`;
  const rows = outlets.map(outlet => {
    const hardExcludeReason = outlet.ai_policy === 'banned'
      ? 'AI banned'
      : outlet.cost_policy?.requires_payment === true
        ? 'paid-only'
        : ['do_not_contact', 'paid_only', 'bounced', 'no_contact_method', 'ai_banned'].includes(outlet.suppression_status)
          ? outlet.suppression_status.replace(/_/g, ' ')
          : !(outlet.contactability?.free_contact_method_found)
            ? 'no usable contact method'
            : '';
    const warning = [
      outlet.ai_policy === 'unclear' ? 'unclear AI policy' : '',
      outlet.last_contact_at ? `contacted ${outlet.last_contact_at.slice(0, 10)}` : '',
      (outlet.fit_score || 0) < 50 ? 'low fit' : '',
      !outlet.instagram_url && !outlet.tiktok_url && !outlet.youtube_url ? 'missing social links' : '',
    ].filter(Boolean).join(' · ');
    const checked = selectedIds.size ? selectedIds.has(outlet.id) : true;
    const testBadge = isTestOutlet(outlet) ? `<span class="ml-2 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">TEST</span>` : '';
    return `<tr class="border-t border-zinc-100 align-top">
      <td class="py-2 pr-3">${hardExcludeReason ? '' : `<input type="checkbox" name="outlet_ids" value="${attr(outlet.id)}" ${checked ? 'checked' : ''}>`}</td>
      <td class="py-2 pr-3 text-sm font-medium">${esc(outlet.name)}${testBadge}</td>
      <td class="py-2 pr-3 text-xs">${esc(outlet.priority || outlet.type || '')}</td>
      <td class="py-2 pr-3 text-xs">${esc(outlet.contact?.email || outlet.public_email || outlet.best_free_contact_method || '')}</td>
      <td class="py-2 pr-3 text-xs ${hardExcludeReason ? 'text-red-600' : 'text-zinc-500'}">${esc(hardExcludeReason || warning || 'OK')}</td>
      <td class="py-2 text-xs text-zinc-500">${esc(outlet.last_contact_release_title || '—')}</td>
    </tr>`;
  }).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
    <div class="grid gap-3 md:grid-cols-4">
      <div class="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Selected targets</div><div id="audience-selected-count" class="mt-1 text-xl font-bold text-zinc-900">${selectedDefaultCount}</div></div>
      <div class="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Valid emails</div><div id="audience-email-count" class="mt-1 text-xl font-bold text-zinc-900">${outlets.filter(outlet => checkedByDefault(selectedIds, outlet.id) && getPreferredOutletEmail(outlet)).length}</div></div>
      <div class="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Previews ready</div><div class="mt-1 text-xl font-bold text-zinc-900">${dashboard.latestCampaignItems.filter(item => item.generated_subject && item.generated_body).length}</div></div>
      <div class="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Gmail drafts</div><div class="mt-1 text-xl font-bold text-zinc-900">${dashboard.latestCampaignItems.filter(item => item.gmail_draft_id).length}</div></div>
    </div>
    <form method="POST" action="/marketing/releases/${attr(dashboard.release.id)}/audience" class="space-y-4" data-release-audience-form>
      <input type="hidden" name="allow_same_release" value="off">
      ${renderCheckbox('allow_same_release', 'Allow re-contacting recent targets', false)}
      <div id="audience-status-copy" class="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">${esc(statusCopy)}</div>
      <div class="text-sm text-zinc-500">Audience is sourced from the canonical outlet database. All eligible outlets are selected by default, including the Kenneth D2L test outlet.</div>
      <div class="overflow-x-auto"><table class="w-full text-left"><thead><tr class="text-xs uppercase text-zinc-400"><th class="pb-2">Select</th><th class="pb-2">Target</th><th class="pb-2">Priority</th><th class="pb-2">Contact</th><th class="pb-2">Exclusion / warning</th><th class="pb-2">Last release</th></tr></thead><tbody>${rows}</tbody></table></div>
      <button class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold" type="submit" data-submit-button data-default-label="Create outreach run">Create outreach run</button>
    </form>
    <script>
      (() => {
        const form = document.querySelector('[data-release-audience-form]');
        if (!form) return;
        const checkboxes = [...form.querySelectorAll('input[name="outlet_ids"]')];
        const selectedEl = document.getElementById('audience-selected-count');
        const emailEl = document.getElementById('audience-email-count');
        const statusEl = document.getElementById('audience-status-copy');
        const submit = form.querySelector('[data-submit-button]');
        const emailById = new Map(${JSON.stringify(outlets.map(outlet => [outlet.id, getPreferredOutletEmail(outlet)]))});
        const update = () => {
          const selected = checkboxes.filter(box => box.checked);
          const selectedCount = selected.length;
          const emailCount = selected.filter(box => emailById.get(box.value)).length;
          selectedEl.textContent = String(selectedCount);
          emailEl.textContent = String(emailCount);
          statusEl.textContent = selectedCount + ' selected targets · Ready to create Gmail drafts';
        };
        update();
        checkboxes.forEach(box => box.addEventListener('change', update));
        form.addEventListener('submit', () => {
          const selectedCount = checkboxes.filter(box => box.checked).length;
          submit.disabled = true;
          submit.textContent = 'Creating outreach run for ' + selectedCount + ' targets...';
        });
      })();
    </script>
  </section>`;
}

function renderDraftsTab(dashboard, campaign) {
  if (!campaign) {
    return '<section class="bg-white border border-zinc-200 rounded-2xl p-6 text-sm text-zinc-500">Create an audience selection first.</section>';
  }
  const items = dashboard.latestCampaignItems;
  const activeItem = items.find(item => item.id === (dashboard.queryItemId || '')) || items[0] || null;
  const counts = summarizeDraftCounts(campaign, items);
  const listHtml = items.map(item => renderDraftListItem(dashboard.release.id, campaign, item, activeItem?.id)).join('');
  const editorHtml = activeItem ? renderDraftEditor(dashboard.release.id, campaign, activeItem) : '<div class="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">No selected targets yet.</div>';
  return `<section class="space-y-4">
    <div class="grid gap-3 md:grid-cols-5">
      <div class="rounded-xl border border-zinc-200 bg-white px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Selected targets</div><div class="mt-1 text-xl font-bold text-zinc-900">${counts.selected}</div></div>
      <div class="rounded-xl border border-zinc-200 bg-white px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Valid emails</div><div class="mt-1 text-xl font-bold text-zinc-900">${counts.validEmails}</div></div>
      <div class="rounded-xl border border-zinc-200 bg-white px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Local previews ready</div><div class="mt-1 text-xl font-bold text-zinc-900">${counts.previewsReady}</div></div>
      <div class="rounded-xl border border-zinc-200 bg-white px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Gmail drafts created</div><div class="mt-1 text-xl font-bold text-zinc-900">${counts.gmailCreated}</div></div>
      <div class="rounded-xl border border-zinc-200 bg-white px-4 py-3"><div class="text-[11px] uppercase tracking-wide text-zinc-400">Need attention</div><div class="mt-1 text-xl font-bold text-zinc-900">${counts.failures}</div></div>
    </div>
    <div class="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
      <form method="POST" action="/marketing/releases/${attr(dashboard.release.id)}/drafts/template" class="space-y-4" data-drafts-actions-form>
        <input type="hidden" name="item" value="${attr(activeItem?.id || '')}">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-zinc-900">Shared template</div>
            <div class="text-xs text-zinc-500">Updating the shared template refreshes all non-customized drafts. Customized drafts stay locked until you reset them.</div>
          </div>
          <div class="text-sm text-zinc-500">Previews are local until you click Create Gmail Drafts.</div>
        </div>
        <div class="grid gap-4 lg:grid-cols-2">
          <label class="block text-sm">Subject template<textarea name="subject_template" rows="4" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2 font-mono text-sm">${esc(campaign.subject_template || DEFAULT_SUBJECT_TEMPLATE)}</textarea></label>
          <label class="block text-sm">Body template<textarea name="body_template" rows="10" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2 font-mono text-sm">${esc(campaign.body_template || DEFAULT_BODY_TEMPLATE)}</textarea></label>
        </div>
        <div class="flex flex-wrap gap-3">
          <button formaction="/marketing/releases/${attr(dashboard.release.id)}/drafts/template" class="bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm font-semibold" data-submit-label="Saving template...">Save template</button>
          <button formaction="/marketing/releases/${attr(dashboard.release.id)}/outreach-drafts/generate" class="border border-zinc-300 rounded-lg px-4 py-2 text-sm font-semibold hover:bg-zinc-50" data-submit-label="Generating previews...">Generate / Refresh Previews</button>
          <button formaction="/marketing/releases/${attr(dashboard.release.id)}/outreach-drafts/gmail" class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold" data-submit-label="Creating Gmail drafts...">Create Gmail Drafts</button>
          <div class="self-center text-sm text-zinc-500" data-drafts-status>${esc(renderDraftStatusCopy(campaign, items))}</div>
        </div>
      </form>
    </div>
    <div class="grid gap-4 xl:grid-cols-[320px,minmax(0,1fr)]">
      <div class="rounded-2xl border border-zinc-200 bg-white p-4">
        <div class="mb-3 text-sm font-semibold text-zinc-900">Selected targets</div>
        <div class="space-y-2">${listHtml || '<div class="text-sm text-zinc-400">No outreach items yet.</div>'}</div>
      </div>
      ${editorHtml}
    </div>
    <script>
      (() => {
        const form = document.querySelector('[data-drafts-actions-form]');
        if (!form) return;
        form.addEventListener('submit', (event) => {
          const submitter = event.submitter;
          if (!submitter) return;
          const label = submitter.getAttribute('data-submit-label') || 'Working...';
          const buttons = [...form.querySelectorAll('button')];
          buttons.forEach(button => { button.disabled = true; });
          submitter.textContent = label;
          const status = form.querySelector('[data-drafts-status]');
          if (status) status.textContent = label;
        });
      })();
    </script>
  </section>`;
}

function renderInboxTab(dashboard) {
  const messages = dashboard.inboxMessages.map(message => `<article class="border border-zinc-200 rounded-xl p-4"><div class="flex flex-wrap items-center justify-between gap-3"><div><div class="font-semibold text-sm">${esc(message.subject || '(no subject)')}</div><div class="text-xs text-zinc-500">${esc(message.from_email || '')} · ${esc(message.classification || '')}</div></div><div class="flex flex-wrap gap-2">
    ${renderInboxAction(dashboard.release.id, message.id, 'opportunity', 'Mark opportunity')}
    ${renderInboxAction(dashboard.release.id, message.id, 'paid_only', 'Mark paid-only')}
    ${renderInboxAction(dashboard.release.id, message.id, 'do_not_contact', 'Mark do-not-contact')}
    ${renderInboxAction(dashboard.release.id, message.id, 'bounced', 'Mark bounced')}
  </div></div><div class="mt-3 text-sm text-zinc-600">${esc(message.snippet || '')}</div></article>`).join('');
  return `<section class="space-y-4">
    <div class="bg-white border border-zinc-200 rounded-2xl p-6"><form method="POST" action="/marketing/releases/${attr(dashboard.release.id)}/gmail-inbox/scan"><button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Run inbox scan</button></form></div>
    <div class="space-y-3">${messages || '<div class="bg-white border border-zinc-200 rounded-2xl p-6 text-sm text-zinc-400">No inbox messages linked to this release yet.</div>'}</div>
  </section>`;
}

function renderResultsTab(dashboard) {
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
    <div class="grid md:grid-cols-3 gap-4 text-sm">
      <div>Replies: <span class="font-semibold">${dashboard.results.replies}</span></div>
      <div>Opportunities: <span class="font-semibold">${dashboard.results.opportunities}</span></div>
      <div>Bounced: <span class="font-semibold">${dashboard.results.bounced}</span></div>
      <div>Suppressed: <span class="font-semibold">${dashboard.results.suppressed}</span></div>
      <div>No response: <span class="font-semibold">${dashboard.results.noResponse}</span></div>
      <div>Placements: <span class="font-semibold">${dashboard.results.placements}</span></div>
    </div>
    <form method="POST" action="/marketing/releases/${attr(dashboard.release.id)}/results" class="space-y-3">
      <label class="block text-sm">Lessons for next release<textarea name="lessons" rows="5" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2">${esc(dashboard.release.results?.lessons || '')}</textarea></label>
      <button class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Save results notes</button>
    </form>
  </section>`;
}

function renderCheckbox(name, label, checked) {
  return `<label class="flex items-center gap-2 text-sm"><input type="checkbox" name="${attr(name)}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;
}

function renderInput(name, label, value, type = 'text') {
  return `<label class="text-sm">${esc(label)}<input type="${attr(type)}" name="${attr(name)}" value="${attr(value || '')}" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2"></label>`;
}

function releaseStatusOptions(selected) {
  return ['draft', 'ready_for_distribution', 'uploaded_to_distrokid', 'pre_release', 'released', 'archived']
    .map(status => `<option value="${attr(status)}" ${status === selected ? 'selected' : ''}>${esc(status)}</option>`)
    .join('');
}

function renderInboxAction(releaseId, messageId, action, label) {
  return `<form method="POST" action="/marketing/releases/${attr(releaseId)}/gmail-inbox/${attr(messageId)}/${attr(action)}"><button class="border border-zinc-300 rounded-lg px-3 py-1.5 text-xs hover:bg-zinc-50">${esc(label)}</button></form>`;
}

function findLatestCampaign(releaseMarketingId) {
  return getMarketingCampaigns(500)
    .filter(c => c.release_marketing_id === releaseMarketingId)
    .sort((a, b) => new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime())[0] || null;
}

function normalizeReleaseTab(tab) {
  if (!tab) return 'audience';
  const normalized = LEGACY_TAB_MAP[String(tab).toLowerCase()] || String(tab).toLowerCase();
  return RELEASE_TABS.some(([key]) => key === normalized) ? normalized : 'audience';
}

function buildReleasePageUrl(releaseId, tab, params = {}) {
  const search = new URLSearchParams();
  search.set('tab', normalizeReleaseTab(tab));
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return `/marketing/releases/${encodeURIComponent(releaseId)}?${search.toString()}`;
}

function booleanFromForm(value, defaultValue = false) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map(entry => String(entry || '').toLowerCase());
  if (!normalized.some(Boolean)) return defaultValue;
  return normalized.some(entry => ['on', 'true', '1', 'yes'].includes(entry));
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function splitLines(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function ensureCampaignTemplates(campaignId) {
  const campaign = getMarketingCampaignById(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.subject_template && campaign.body_template) return campaign;
  return updateMarketingCampaign(campaign.id, {
    subject_template: campaign.subject_template || DEFAULT_SUBJECT_TEMPLATE,
    body_template: campaign.body_template || DEFAULT_BODY_TEMPLATE,
  });
}

function generateReleaseDraftPreviews(campaignId) {
  const campaign = ensureCampaignTemplates(campaignId);
  const release = getReleaseMarketingById(campaign.release_marketing_id);
  if (!release) throw new Error('Release not found');
  const song = getSong(release.song_id || release.songId);
  if (!song) throw new Error('Song not found');
  const marketingKit = getSongMarketingKit(song);
  const items = getOutreachItems({ campaign_id: campaign.id });
  let previewed = 0;

  for (const item of items) {
    const rendered = renderDraftFromTemplate({ campaign, item, release, song, marketingKit });
    updateOutreachItem(item.id, {
      generated_subject: rendered.generatedSubject,
      generated_body: rendered.generatedBody,
      subject: rendered.subject,
      body: rendered.body,
      is_customized: rendered.isCustomized,
      subject_override: rendered.subjectOverride,
      body_override: rendered.bodyOverride,
      last_error: rendered.lastError,
      safety_status: rendered.lastError ? 'needs_attention' : (campaign.dry_run ? 'preview_generated' : 'ready_for_gmail'),
      requires_ken: true,
      status: item.gmail_draft_id
        ? 'gmail_draft_created'
        : rendered.lastError
          ? 'needs_ken'
          : campaign.dry_run
            ? 'draft_generated'
            : 'ready_for_gmail_draft',
    });
    previewed += 1;
  }

  return { previewed };
}

function renderDraftFromTemplate({ campaign, item, release, song, marketingKit }) {
  const templateVars = buildTemplateVariables({ item, release, song, marketingKit });
  const generatedSubject = renderTemplateString(campaign.subject_template || DEFAULT_SUBJECT_TEMPLATE, templateVars);
  const generatedBody = renderTemplateString(campaign.body_template || DEFAULT_BODY_TEMPLATE, templateVars);
  const subjectOverride = item.subject_override || null;
  const bodyOverride = item.body_override || null;
  const isCustomized = Boolean(item.is_customized || subjectOverride || bodyOverride);
  const subject = isCustomized && subjectOverride !== null ? subjectOverride : generatedSubject;
  const body = isCustomized && bodyOverride !== null ? bodyOverride : generatedBody;
  const missing = collectDraftWarnings({
    subjectTemplate: campaign.subject_template || DEFAULT_SUBJECT_TEMPLATE,
    bodyTemplate: campaign.body_template || DEFAULT_BODY_TEMPLATE,
    vars: templateVars,
    email: getPreferredOutletEmail(item),
    subject,
    body,
  });
  return {
    generatedSubject,
    generatedBody,
    subject,
    body,
    isCustomized,
    subjectOverride,
    bodyOverride,
    lastError: missing.length ? missing.join(' | ') : null,
  };
}

function buildTemplateVariables({ item, release, song, marketingKit }) {
  const links = marketingKit.marketing_links || {};
  const outlet = item.outlet_context || {};
  return {
    outletName: outlet.name || item.outlet_name || '',
    contactName: outlet.contact?.name || outlet.contact_name || 'there',
    songTitle: song.title || song.topic || song.id,
    artistName: release.artistName || 'Pancake Robot',
    brandName: 'Pancake Robot',
    releaseLink: links.smart_link || release.distribution?.hyperfollowUrl || '',
    hyperfollowLink: release.distribution?.hyperfollowUrl || links.smart_link || '',
    spotifyLink: links.spotify_url || release.distribution?.spotifyUrl || '',
    appleMusicLink: links.apple_music_url || release.distribution?.appleMusicUrl || '',
    youtubeLink: links.youtube_video_url || links.youtube_music_url || release.distribution?.youtubeMusicUrl || '',
    instagramLink: links.instagram_url || '',
    tiktokLink: links.tiktok_url || '',
    pressKitLink: links.release_kit_url || links.promo_assets_folder_url || '',
    shortDescription: song.topic || song.concept || '',
    releaseBlurb: song.notes || song.description || song.concept || '',
    whyThisOutletFits: outlet.outreach_angle || outlet.research_summary || `Your audience looks aligned with ${song.title || song.topic || 'this release'}.`,
  };
}

function renderTemplateString(template, vars) {
  return String(template || '')
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => String(vars[key] || '').trim())
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectDraftWarnings({ subjectTemplate, bodyTemplate, vars, email, subject, body }) {
  const warnings = [];
  if (!email) warnings.push('Missing email');
  if (!subject) warnings.push('Missing subject');
  if (!body) warnings.push('Missing body');
  const usedTokens = new Set([
    ...extractTemplateTokens(subjectTemplate),
    ...extractTemplateTokens(bodyTemplate),
  ]);
  for (const token of usedTokens) {
    if (!String(vars[token] || '').trim()) warnings.push(`Missing ${token}`);
  }
  return [...new Set(warnings)];
}

function extractTemplateTokens(template) {
  return [...String(template || '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(match => match[1]);
}

function renderDraftStatusCopy(campaign, items) {
  const counts = summarizeDraftCounts(campaign, items);
  if (counts.gmailCreated > 0 && counts.failures > 0) return `${counts.selected} selected targets · ${counts.gmailCreated} Gmail drafts created · ${counts.failures} need attention`;
  if (counts.gmailCreated > 0) return `${counts.selected} selected targets · ${counts.gmailCreated} Gmail drafts created`;
  return `${counts.selected} selected targets · Ready to create Gmail drafts`;
}

function summarizeDraftCounts(campaign, items) {
  return {
    selected: campaign?.approved_target_ids?.length || items.length,
    validEmails: items.filter(item => getPreferredOutletEmail(item)).length,
    previewsReady: items.filter(item => item.generated_subject && item.generated_body).length,
    gmailCreated: items.filter(item => item.gmail_draft_id).length,
    failures: items.filter(item => item.last_error).length,
  };
}

function renderDraftListItem(releaseId, campaign, item, activeItemId) {
  const email = getPreferredOutletEmail(item);
  const status = deriveDraftStatusLabel(campaign, item);
  const isActive = activeItemId === item.id;
  return `<a href="${attr(buildReleasePageUrl(releaseId, 'drafts', { item: item.id }))}" class="block rounded-xl border px-3 py-3 ${isActive ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 hover:bg-zinc-50'}">
    <div class="flex items-center justify-between gap-2">
      <div class="text-sm font-semibold text-zinc-900">${esc(item.outlet_name || item.target_id)}</div>
      ${renderStatusPill(status.label, status.tone)}
    </div>
    <div class="mt-1 text-xs text-zinc-500">${esc(email || 'No email')}</div>
    ${isTestOutlet(item.outlet_context || {}) ? '<div class="mt-2 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">TEST</div>' : ''}
  </a>`;
}

function renderDraftEditor(releaseId, campaign, item) {
  const status = deriveDraftStatusLabel(campaign, item);
  const canMarkSent = canTransitionOutreachItem(item, 'mark_sent');
  const gmailLink = item.gmail_draft_url
    ? `<a href="${attr(item.gmail_draft_url)}" target="_blank" rel="noopener noreferrer" class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Open Gmail Draft</a>`
    : '';
  const markSentButton = canMarkSent
    ? `<form method="POST" action="/marketing/releases/${attr(releaseId)}/drafts/${attr(item.id)}/mark-sent">
        <button class="border border-emerald-300 bg-emerald-50 text-emerald-700 rounded-lg px-4 py-2 text-sm font-semibold hover:bg-emerald-100">Mark email sent</button>
      </form>`
    : '';
  return `<div class="space-y-4">
    <div class="rounded-2xl border border-zinc-200 bg-white p-6">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2"><h2 class="text-lg font-bold text-zinc-900">${esc(item.outlet_name || item.target_id)}</h2>${renderStatusPill(status.label, status.tone)}</div>
          <div class="mt-1 text-sm text-zinc-500">${esc(getPreferredOutletEmail(item) || 'No email')}</div>
          ${item.sent_at ? `<div class="mt-2 text-xs text-zinc-500">Marked sent ${esc(new Date(item.sent_at).toLocaleString('en-US'))}</div>` : ''}
          ${item.last_error ? `<div class="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">${esc(item.last_error)}</div>` : ''}
        </div>
        <div class="flex flex-wrap gap-2">${gmailLink}${markSentButton}</div>
      </div>
      <form method="POST" action="/marketing/releases/${attr(releaseId)}/drafts/${attr(item.id)}" class="mt-5 space-y-4">
        <label class="block text-sm">Subject<input name="subject" value="${attr(item.subject || item.generated_subject || '')}" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm"></label>
        <label class="block text-sm">Body<textarea name="body" rows="18" class="mt-1 w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm font-mono">${esc(item.body || item.generated_body || '')}</textarea></label>
        <div class="flex flex-wrap gap-3">
          <button class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Save Changes</button>
          <button formaction="/marketing/releases/${attr(releaseId)}/drafts/${attr(item.id)}/reset" class="border border-zinc-300 rounded-lg px-4 py-2 text-sm font-semibold hover:bg-zinc-50">Reset selected draft to template</button>
        </div>
      </form>
    </div>
  </div>`;
}

function deriveDraftStatusLabel(campaign, item) {
  if (item.status === 'sent') return { label: 'Sent', tone: 'green' };
  if (item.status === 'replied') return { label: 'Replied', tone: 'green' };
  if (item.status === 'manual_submitted') return { label: 'Manually submitted', tone: 'green' };
  if (item.gmail_draft_id) return { label: 'Gmail draft created', tone: 'green' };
  if (!getPreferredOutletEmail(item)) return { label: 'Missing email', tone: 'amber' };
  if (item.last_error) return { label: 'Failed', tone: 'red' };
  if (!item.generated_subject || !item.generated_body) return { label: 'Not generated', tone: 'zinc' };
  if (item.is_customized) return { label: 'Customized', tone: 'blue' };
  return { label: 'Ready for Gmail', tone: 'blue' };
}

function renderStatusPill(label, tone = 'zinc') {
  const classes = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-700',
    zinc: 'border-zinc-200 bg-zinc-50 text-zinc-700',
  };
  return `<span class="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${classes[tone] || classes.zinc}">${esc(label)}</span>`;
}

function getPreferredOutletEmail(item) {
  return item?.outlet_context?.contact_email
    || item?.outlet_context?.public_email
    || item?.outlet_context?.contact?.email
    || item?.public_email
    || item?.contact_email
    || '';
}

function isTestOutlet(outlet) {
  return outlet?.internal_test === true || outlet?.raw_json?.isTestOutlet === true || outlet?.raw_json?.internal_test === true || outlet?.isTestOutlet === true;
}

function checkedByDefault(selectedIds, outletId) {
  return selectedIds.size ? selectedIds.has(outletId) : true;
}
