import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import fs from 'fs';
import { getAllSongs, getSong, upsertSong, upsertReleaseLink, getReleaseLinks } from '../../../shared/db.js';
import { SONG_STATUSES, getSongStatusLabel } from '../../../shared/song-status.js';
import { getMarketingTargets, getMarketingCampaigns, getMarketingCampaignById, updateMarketingTarget } from '../../../shared/marketing-db.js';
import { getOrCreateReleaseMarketing, getReleaseMarketingById, getReleaseMarketingDashboard, updateReleaseMarketing, resolveSourceArtworkPath } from '../../../shared/marketing-releases.js';
import { hydrateOutletsWithHistory } from '../../../shared/marketing-outlets.js';
import { createOutreachRun, getAllOutletsForSelection } from '../../../agents/marketing-outreach-run-agent.js';
import { generateDraftsForCampaign } from '../../../agents/marketing-outreach-draft-agent.js';
import { createGmailDraftsForCampaign } from '../../../agents/marketing-gmail-draft-agent.js';
import { runInboxScan } from '../../../agents/marketing-inbox-agent.js';
import { buildMarketingReleasePack } from '../../../marketing/release-agent.js';
import { getInboxMessages } from '../../../shared/marketing-inbox-db.js';
import { getOutreachItem, updateOutreachItem } from '../../../shared/marketing-outreach-db.js';
import { transitionOutreachItem } from '../../../shared/marketing-outreach-state.js';
import { renderMarketingLayout } from '../views/layout.js';
import { esc, attr, redirect } from '../utils/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const multer = _require('multer');

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
    redirect(res, `/marketing/releases/${release.id}`);
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

  const tab = String(req.query.tab || 'readiness').toLowerCase();
  const campaign = dashboard.latestCampaign;
  const outletRows = hydrateOutletsWithHistory(getMarketingTargets({}));
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
          <div>Readiness ${dashboard.readinessPct}%</div>
          <div>${dashboard.assetCount} assets · ${dashboard.selectedTargetsCount} targets · ${dashboard.draftsReadyCount} drafts</div>
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
    await buildMarketingReleasePack(release.songId, { sourceArtworkPath });
    redirect(res, `/marketing/releases/${release.id}?tab=assets`);
  } catch (error) {
    redirect(res, `/marketing/releases/${release.id}?tab=assets&error=${encodeURIComponent(error.message)}`);
  }
}

export function postSelectReleaseAudience(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  if (!release) return redirect(res, '/marketing?error=Release%20not%20found');
  try {
    createOutreachRun({
      song_ids: [release.songId],
      outlet_ids: toArray(req.body.outlet_ids),
      mode: 'single_release',
      allow_same_release: req.body.allow_same_release === 'on',
      dry_run: req.body.dry_run !== 'off',
      release_marketing_id: release.id,
    });
    redirect(res, `/marketing/releases/${release.id}?tab=audience`);
  } catch (error) {
    redirect(res, `/marketing/releases/${release.id}?tab=audience&error=${encodeURIComponent(error.message)}`);
  }
}

export async function postGenerateReleaseDrafts(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const campaign = findLatestCampaign(release?.id);
  if (!release || !campaign) return redirect(res, `/marketing/releases/${req.params.releaseMarketingId}?tab=outreach-drafts&error=${encodeURIComponent('Create an audience selection first.')}`);
  await generateDraftsForCampaign(campaign.id, { deterministic: req.body.deterministic === 'on' });
  redirect(res, `/marketing/releases/${release.id}?tab=outreach-drafts`);
}

export async function postCreateReleaseGmailDrafts(req, res) {
  const release = getReleaseMarketingById(req.params.releaseMarketingId);
  const campaign = findLatestCampaign(release?.id);
  if (!release || !campaign) return redirect(res, `/marketing/releases/${req.params.releaseMarketingId}?tab=outreach-drafts&error=${encodeURIComponent('Create an audience selection first.')}`);
  await createGmailDraftsForCampaign(campaign.id, { dryRun: campaign.dry_run || req.body.dry_run === 'on' });
  redirect(res, `/marketing/releases/${release.id}?tab=outreach-drafts`);
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
  const tabs = [
    ['readiness', 'Readiness'],
    ['distribution', 'Distribution'],
    ['assets', 'Assets'],
    ['audience', 'Audience'],
    ['outreach-drafts', 'Outreach Drafts'],
    ['gmail-inbox', 'Gmail Inbox'],
    ['results', 'Results'],
  ];
  return `<nav class="flex flex-wrap gap-2">${tabs.map(([key, label]) => `<a href="/marketing/releases/${attr(releaseId)}?tab=${attr(key)}" class="rounded-lg px-3 py-2 text-sm ${activeTab === key ? 'bg-zinc-900 text-white' : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'}">${esc(label)}</a>`).join('')}</nav>`;
}

function renderTabBody(tab, dashboard, campaign, outlets) {
  if (tab === 'distribution') return renderDistributionTab(dashboard.release);
  if (tab === 'assets') return renderAssetsTab(dashboard);
  if (tab === 'audience') return renderAudienceTab(dashboard, campaign, outlets);
  if (tab === 'outreach-drafts') return renderDraftsTab(dashboard, campaign);
  if (tab === 'gmail-inbox') return renderInboxTab(dashboard);
  if (tab === 'results') return renderResultsTab(dashboard);
  return renderReadinessTab(dashboard.release);
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
    return `<tr class="border-t border-zinc-100 align-top">
      <td class="py-2 pr-3">${hardExcludeReason ? '' : `<input type="checkbox" name="outlet_ids" value="${attr(outlet.id)}" ${selectedIds.has(outlet.id) ? 'checked' : ''}>`}</td>
      <td class="py-2 pr-3 text-sm font-medium">${esc(outlet.name)}</td>
      <td class="py-2 pr-3 text-xs">${esc(outlet.priority || outlet.type || '')}</td>
      <td class="py-2 pr-3 text-xs">${esc(outlet.contact?.email || outlet.public_email || outlet.best_free_contact_method || '')}</td>
      <td class="py-2 pr-3 text-xs ${hardExcludeReason ? 'text-red-600' : 'text-zinc-500'}">${esc(hardExcludeReason || warning || 'OK')}</td>
      <td class="py-2 text-xs text-zinc-500">${esc(outlet.last_contact_release_title || '—')}</td>
    </tr>`;
  }).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    <form method="POST" action="/marketing/releases/${attr(dashboard.release.id)}/audience" class="space-y-4">
      ${renderCheckbox('dry_run', 'Dry-run mode', campaign ? campaign.dry_run : true)}
      ${renderCheckbox('allow_same_release', 'Allow re-contacting recent targets', false)}
      <div class="overflow-x-auto"><table class="w-full text-left"><thead><tr class="text-xs uppercase text-zinc-400"><th class="pb-2">Select</th><th class="pb-2">Target</th><th class="pb-2">Priority</th><th class="pb-2">Contact</th><th class="pb-2">Exclusion / warning</th><th class="pb-2">Last release</th></tr></thead><tbody>${rows}</tbody></table></div>
      <button class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Save audience and create campaign</button>
    </form>
  </section>`;
}

function renderDraftsTab(dashboard, campaign) {
  const items = dashboard.outreachItems.map(item => `<article class="border border-zinc-200 rounded-xl p-4"><div class="flex items-center justify-between gap-3"><div><div class="font-semibold text-sm">${esc(item.outlet_name || item.target_id)}</div><div class="text-xs text-zinc-500">${esc(item.status)}</div></div></div><div class="mt-3 text-xs text-zinc-500">Subject</div><div class="text-sm font-medium">${esc(item.subject || 'Not generated')}</div><pre class="mt-2 whitespace-pre-wrap text-xs text-zinc-700 bg-zinc-50 rounded-lg p-3">${esc(item.body || '')}</pre></article>`).join('');
  return `<section class="space-y-4">
    <div class="bg-white border border-zinc-200 rounded-2xl p-6 flex flex-wrap gap-3">
      <form method="POST" action="/marketing/releases/${attr(dashboard.release.id)}/outreach-drafts/generate"><button class="bg-zinc-900 text-white rounded-lg px-4 py-2 text-sm font-semibold" ${campaign ? '' : 'disabled'}>Generate drafts</button></form>
      <form method="POST" action="/marketing/releases/${attr(dashboard.release.id)}/outreach-drafts/gmail"><button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold" ${campaign ? '' : 'disabled'}>Create Gmail drafts</button></form>
      <div class="text-sm text-zinc-500 self-center">${campaign ? `${campaign.approved_target_ids.length} selected targets` : 'Create an audience selection first.'}</div>
    </div>
    <div class="space-y-3">${items || '<div class="bg-white border border-zinc-200 rounded-2xl p-6 text-sm text-zinc-400">No outreach items yet.</div>'}</div>
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
  return getMarketingCampaigns(500).find(c => c.release_marketing_id === releaseMarketingId) || null;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function splitLines(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
