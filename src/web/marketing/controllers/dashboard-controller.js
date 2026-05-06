import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import fs from 'fs';
import { getMarketingCampaigns } from '../../../shared/marketing-db.js';
import { getOutreachEvents, getOutreachItems, getOutreachSummary } from '../../../shared/marketing-outreach-db.js';
import { getInboxMessages, getInboxSummary } from '../../../shared/marketing-inbox-db.js';
import { getEligibleOutlets } from '../../../agents/marketing-outreach-run-agent.js';
import { outletContactedForRelease } from '../../../shared/marketing-outlets.js';
import { getMarketingReleaseEntries } from '../../../shared/marketing-releases.js';
import { getSong } from '../../../shared/db.js';
import { loadBrandProfile } from '../../../shared/brand-profile.js';
import { buildMarketingReleasePack } from '../../../marketing/release-agent.js';
import { getSongMarketingKit } from '../../../shared/song-marketing-kit.js';
import { formatMarketingMissingFieldLabel, getSongNextAction } from '../../../shared/song-workflow.js';
import { renderMarketingLayout } from '../views/layout.js';
import { banner, emptyBox, pill } from '../views/helpers.js';
import { esc, attr, redirect, readBody, campaignUrl } from '../utils/http.js';
import { createAndMaybeGenerate } from './api-controller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const multer = require('multer');
const ALLOWED_IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ACTIVE_BRAND_NAME = loadBrandProfile().brand_name || 'Active brand';

export function renderMarketingDashboard(req, res) {
  const releases = releaseReadySongs();
  const outlets = getEligibleOutlets();
  const campaigns = getMarketingCampaigns(50).filter(c => c.focus_song_id);
  const outreachSummary = getOutreachSummary();
  const inbox = safeInbox();

  const body = `<main class="p-8 space-y-8">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-start justify-between gap-4">
        <div><h1 class="text-3xl font-extrabold">Marketing Mission Control</h1><p class="text-sm text-zinc-500 mt-2">Release outreach, Gmail draft queue, and inbound triage.</p></div>
        <form method="POST" action="/marketing/agents/inbox-scan"><button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Scan Gmail inbox</button></form>
      </div>
    </section>
    ${banner(req.query.message)}${banner(req.query.error, 'error')}
    ${renderMarketingReadinessBoard(releases)}
    ${renderReleaseOutreach(releases, outlets, outreachSummary)}
    ${renderCampaignList(campaigns)}
    ${renderInboxTriage(inbox)}
  </main>${renderMarketingDashboardScript()}`;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout('Marketing', body));
}

export async function postOutreachRun(req, res) {
  try {
    const body = await readBody(req);
    const result = await createAndMaybeGenerate(body, { awaitDraftGeneration: true });
    const draftNote = typeof result.generated_drafts === 'number' ? `; ${result.generated_drafts} draft(s) generated` : '';
    const msg = `Outreach run created: ${result.campaign_count} campaign(s), ${result.item_count} item(s)${draftNote}`;
    const firstCampaignId = result.campaigns?.[0]?.campaign_id;
    if (firstCampaignId) return redirect(res, campaignUrl(firstCampaignId, msg));
    redirect(res, `/marketing?message=${encodeURIComponent(msg)}`);
  } catch (error) {
    redirect(res, `/marketing?error=${encodeURIComponent(error.message)}`);
  }
}

export async function postInboxScan(req, res) {
  try {
    const { runInboxScan } = await import('../../../agents/marketing-inbox-agent.js');
    const result = await runInboxScan({ dryRun: false });
    redirect(res, `/marketing?message=${encodeURIComponent(`Inbox scan done: fetched ${result.fetched}, ${result.saved} new, ${result.updated || 0} existing`)}`);
  } catch (error) {
    redirect(res, `/marketing?error=${encodeURIComponent(error.message)}`);
  }
}

function releaseDashboardUrl(songId, text = null, key = 'message') {
  const query = text ? `?${key}=${encodeURIComponent(text)}` : '';
  return `/marketing${query}#release-${encodeURIComponent(songId)}`;
}

function buildBaseImageUpload(songId) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const refDir = join(__dirname, '../../../../../output/songs', songId, 'reference');
        fs.mkdirSync(refDir, { recursive: true });
        cb(null, refDir);
      },
      filename: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase() || '.png';
        cb(null, `base-image${ext}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      cb(null, ALLOWED_IMG_EXTS.has(extname(file.originalname).toLowerCase()));
    },
  });
}

export function postReleaseBaseImage(req, res) {
  const song = getSong(req.params.songId);
  if (!song) return redirect(res, releaseDashboardUrl(req.params.songId, 'Song not found.', 'error'));

  const upload = buildBaseImageUpload(song.id).single('base_image');
  upload(req, res, (err) => {
    if (err) return redirect(res, releaseDashboardUrl(song.id, err.message, 'error'));
    if (!req.file) return redirect(res, releaseDashboardUrl(song.id, 'Please choose a png, jpg, jpeg, or webp base image.', 'error'));
    redirect(res, releaseDashboardUrl(song.id, 'Base image uploaded.'));
  });
}

export async function postBuildReleaseMarketingPack(req, res) {
  const song = getSong(req.params.songId);
  if (!song) return redirect(res, releaseDashboardUrl(req.params.songId, 'Song not found.', 'error'));

  try {
    const result = await buildMarketingReleasePack(song.id, {});
    const qaLabel = result.metadata?.qa_status ? `; QA ${result.metadata.qa_status}` : '';
    redirect(res, releaseDashboardUrl(song.id, `Marketing pack built${qaLabel}.`));
  } catch (error) {
    redirect(res, releaseDashboardUrl(song.id, error.message, 'error'));
  }
}

function renderReleaseOutreach(releases, outlets, summary) {
  const cards = releases.map(({ song, links, hasMarketingImage, marketingSummary }) => renderReleaseCard(song, links, outlets, hasMarketingImage, marketingSummary)).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    <div class="flex items-start justify-between gap-4 mb-5">
      <div>
        <h2 class="font-bold text-lg">Release Outreach</h2>
        <p class="text-sm text-zinc-500 mt-1">Only eligible outlets with email addresses appear here. Outlets already contacted for the same release are hidden unless you override.</p>
      </div>
      <div class="text-right text-xs text-zinc-500">
        <div>${summary.total || 0} outreach item(s)</div>
        <div>${summary.sent || 0} sent · ${summary.requires_ken || 0} need Ken</div>
      </div>
    </div>
    <div class="space-y-4">${cards || emptyBox('No release-ready songs.')}</div>
  </section>`;
}

function renderMarketingReadinessBoard(releases) {
  const rows = releases.map(({ song }) => {
    const kit = getSongMarketingKit(song);
    const readiness = kit.marketing_readiness || {};
    const nextAction = getSongNextAction(song, kit);
    const events = getOutreachEvents({ song_id: song.id });
    const contactedCount = new Set(events.map(event => event.target_id).filter(Boolean)).size;
    const missing = [
      ...(readiness.missing_required_fields || []),
      ...(readiness.missing_recommended_fields || []),
    ]
      .slice(0, 4)
      .map(formatMarketingMissingFieldLabel)
      .join(', ') || 'No major gaps';
    const socialReady = Boolean(
      kit.marketing_assets.square_post_url
      || kit.marketing_assets.vertical_post_url
      || kit.marketing_assets.portrait_post_url
      || kit.marketing_assets.outreach_banner_url
      || kit.marketing_assets.cover_safe_promo_url
      || kit.marketing_assets.no_text_variation_url
    );
    const primaryActionHref = nextAction.href || `/songs/${attr(song.id)}?tab=marketing`;
    const primaryActionTone = nextAction.nextActionKey === 'START_OUTREACH' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-zinc-900 hover:bg-zinc-700';
    const primaryAction = `<a href="${attr(primaryActionHref)}" class="inline-flex rounded-lg ${primaryActionTone} px-3 py-2 text-xs font-semibold text-white">${esc(nextAction.label || 'Open song')}</a>`;

    return `<tr class="border-b border-zinc-100 align-top">
      <td class="py-3 pr-4">
        <a href="/songs/${attr(song.id)}?tab=marketing" class="font-semibold text-blue-700 hover:underline">${esc(song.title || song.topic || song.id)}</a>
        <div class="mt-1 text-xs text-zinc-500">${esc(ACTIVE_BRAND_NAME)}</div>
      </td>
      <td class="py-3 pr-4 text-xs">${pill(song.status, 'zinc')}</td>
      <td class="py-3 pr-4 text-xs">${statusChip(kit.marketing_links.smart_link)}</td>
      <td class="py-3 pr-4 text-xs">${statusChip(kit.marketing_links.release_kit_url, 'recommended')}</td>
      <td class="py-3 pr-4 text-xs">${statusChip(kit.marketing_links.audio_download_url, 'recommended')}</td>
      <td class="py-3 pr-4 text-xs">${statusChip(kit.marketing_links.promo_assets_folder_url, 'recommended')}</td>
      <td class="py-3 pr-4 text-xs">${statusChip(socialReady, 'recommended')}</td>
      <td class="py-3 pr-4 text-xs">
        <div class="font-semibold ${readiness.score >= 80 ? 'text-emerald-700' : 'text-amber-700'}">${readiness.score || 0}</div>
        <div class="text-zinc-400">outreach readiness</div>
      </td>
      <td class="py-3 pr-4 text-xs text-zinc-500">${esc(formatDateTime(kit.last_outreach.datetime))}</td>
      <td class="py-3 pr-4 text-xs text-zinc-500">${contactedCount || kit.last_outreach.recipient_count || 0}</td>
      <td class="py-3 pr-4 text-xs text-zinc-600 max-w-64">${esc(missing)}</td>
      <td class="py-3 pr-4 text-xs text-zinc-600">${esc(nextAction.label || 'No action needed')}</td>
      <td class="py-3 text-xs">${primaryAction}</td>
    </tr>`;
  }).join('');

  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    <div class="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 class="font-bold text-lg">Release Marketing Readiness</h2>
        <p class="text-sm text-zinc-500 mt-1">Warnings only: missing fields never block the release pipeline, but they do reduce outreach readiness.</p>
      </div>
    </div>
    <div class="overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead class="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-400">
          <tr>
            <th class="py-2 pr-4">Release</th>
            <th class="py-2 pr-4">Status</th>
            <th class="py-2 pr-4">Smart link</th>
            <th class="py-2 pr-4">Release kit</th>
            <th class="py-2 pr-4">Audio</th>
            <th class="py-2 pr-4">Promo assets</th>
            <th class="py-2 pr-4">Social assets</th>
            <th class="py-2 pr-4">Score</th>
            <th class="py-2 pr-4">Last outreach</th>
            <th class="py-2 pr-4">Outlet count</th>
            <th class="py-2 pr-4">Missing summary</th>
            <th class="py-2 pr-4">Next action</th>
            <th class="py-2">Action</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="13">${emptyBox('No release-ready songs.')}</td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

function renderReleaseCard(song, links, outlets, hasMarketingImage = false, marketingSummary = null) {
  const marketingKit = getSongMarketingKit(song, { releaseLinks: links });
  const available = outlets.filter(outlet => !outletContactedForRelease(outlet, song.id));
  const contacted = outlets.filter(outlet => outletContactedForRelease(outlet, song.id));
  const defaultRows = available.slice(0, 10);
  const linkHtml = links.length
    ? links.map(link => `<a href="${attr(link.url)}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">${esc(link.platform)}</a>`).join(' · ')
    : '<span class="text-xs text-zinc-400">No public links captured yet</span>';
  const marketingHtml = renderMarketingSummary(marketingSummary, marketingKit);
  const outletRows = defaultRows.map(outlet => {
    const meta = [
      pill(outlet.priority || '—'),
      pill(outlet.type || 'outlet', 'blue'),
      pill(outlet.contactability.best_channel || 'unknown', 'green'),
    ].join(' ');
    const lastContact = outlet.last_contact
      ? `<div class="text-[11px] text-zinc-500 mt-1">Last contacted ${esc(formatDateTime(outlet.last_contact.contacted_at))} about ${esc(outlet.last_contact.release_title || outlet.last_contact.release_id || '')}</div>`
      : '';
    return `<label class="flex items-start gap-3 border border-zinc-200 rounded-lg p-3 hover:bg-zinc-50">
      <input type="checkbox" name="outlet_ids" value="${attr(outlet.id)}" ${outlet.priority === 'P0' ? 'checked' : ''} class="mt-1">
      <span class="flex-1 min-w-0">
        <span class="block font-semibold text-sm">${esc(outlet.name)}</span>
        <span class="mt-1 flex flex-wrap gap-1">${meta}</span>
        <span class="block text-xs text-zinc-500 mt-1">${esc(outlet.outreach_angle || outlet.sample_pitch_hook || outlet.outreach_eligibility.reason_summary || '')}</span>
        ${lastContact}
      </span>
    </label>`;
  }).join('');
  const previouslyContactedRows = contacted.slice(0, 8).map(outlet => `<label class="flex items-start gap-3 border border-amber-200 rounded-lg p-3 bg-amber-50">
      <input type="checkbox" name="outlet_ids" value="${attr(outlet.id)}" class="mt-1">
      <span class="flex-1 min-w-0">
        <span class="block font-semibold text-sm text-amber-900">${esc(outlet.name)}</span>
        <span class="block text-xs text-amber-700 mt-1">Previously contacted for this release on ${esc(formatDateTime(outlet.last_contact?.contacted_at))}</span>
        <span class="block text-xs text-amber-700 mt-1">${esc(outlet.last_contact?.message_preview || '')}</span>
      </span>
    </label>`).join('');

  return `<article id="release-${attr(song.id)}" class="border border-zinc-200 rounded-xl p-4">
    <div>
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="font-bold text-lg">${esc(song.title || song.topic || song.id)}</h3>
        ${pill(song.status, 'zinc')}
        ${hasMarketingImage ? '<span title="Marketing image available" class="text-xs">🖼️</span>' : ''}
        ${pill(`Readiness ${marketingKit.marketing_readiness.score}`, marketingKit.marketing_readiness.score >= 80 ? 'green' : 'amber')}
      </div>
      <div class="mt-1">${linkHtml}</div>
      <div class="mt-2 text-xs text-zinc-500">${available.length} eligible now · ${contacted.length} already contacted for this release · ${marketingKit.last_outreach.datetime ? `last outreach ${esc(formatDateTime(marketingKit.last_outreach.datetime))}` : 'no outreach yet'}</div>
    </div>
    <div class="mt-4 grid grid-cols-1 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)] gap-4 items-start">
      <form method="POST" action="/marketing/outreach-run" class="space-y-4 min-w-0">
        <input type="hidden" name="song_id" value="${attr(song.id)}">
        <input type="hidden" name="mode" value="single_release">
        <input type="hidden" name="generate_drafts" value="true">
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-semibold text-zinc-700">Release Items</div>
            <div class="text-xs text-zinc-500">Clickable outlet targets for customized drafts</div>
          </div>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 max-h-96 overflow-y-auto pr-1">
            ${outletRows || emptyBox('No eligible outlets left for this release.')}
          </div>
          ${previouslyContactedRows ? `<details class="rounded-lg border border-zinc-200 p-3"><summary class="cursor-pointer text-sm text-zinc-700">Show previously contacted outlets for this release (${contacted.length})</summary><div class="mt-3 space-y-2">${previouslyContactedRows}</div></details>` : ''}
        </div>
        <label class="flex items-center gap-2 text-sm text-zinc-600">
          <input type="checkbox" name="allow_same_release" value="true">
          Allow re-contacting outlets already contacted for this release
        </label>
        <div class="flex items-center justify-between gap-3">
          <p class="text-xs text-zinc-500">Requires manual review before anything is actually sent.</p>
          <button class="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Create outreach run</button>
        </div>
      </form>
      <div class="min-w-0">
        ${marketingHtml}
      </div>
    </div>
  </article>`;
}

function renderMarketingSummary(summary, marketingKit) {
  if (!summary) return '';

  const releaseLinks = (summary.releaseLinks || [])
    .map(link => `<a href="${attr(link.url)}" target="_blank" rel="noopener" class="block rounded-lg border border-zinc-200 bg-white px-3 py-2 hover:border-blue-200 hover:bg-blue-50">
      <div class="text-[10px] uppercase tracking-wide text-zinc-400">${esc(link.label || 'Link')}</div>
      <div class="mt-1 text-xs text-blue-600 break-all">${esc(link.url)}</div>
    </a>`)
    .join('');

  const surfacedAssets = (summary.surfacedAssets || [])
    .map(asset => renderAssetLink(formatAssetLabel(asset), asset.url))
    .join('');

  const counts = [
    ['Store links', summary.counts.releaseLinks],
    ['Base image', summary.baseImage ? 1 : 0],
    ['Social images', summary.counts.socialImages],
    ['Social clips', summary.counts.socialClips],
  ].map(([label, value]) => `<div class="rounded-lg border border-zinc-200 bg-white px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-zinc-400">${label}</div><div class="mt-1 text-sm font-semibold text-zinc-800">${value}</div></div>`).join('');

  const warnings = (summary.warnings || []).slice(0, 4)
    .map(warning => `<li class="text-[11px] text-amber-700">${esc(warning)}</li>`)
    .join('');
  const missingSummary = [
    ...(marketingKit.marketing_readiness.missing_required_fields || []),
    ...(marketingKit.marketing_readiness.missing_recommended_fields || []),
  ].slice(0, 5).map(item => `<li class="text-[11px] text-zinc-600">${esc(item.replaceAll('_', ' '))}</li>`).join('');
  const readiness = marketingKit.marketing_readiness;

  return `<aside class="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
    <div>
      <div class="text-sm font-semibold text-zinc-800">Marketing Assets</div>
      <div class="text-[11px] text-zinc-500 mt-0.5">Song Catalog surfaced files, release links, and outreach readiness</div>
    </div>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div class="rounded-lg border border-zinc-200 bg-white px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-zinc-400">Smart link</div><div class="mt-1 text-sm font-semibold text-zinc-800">${marketingKit.marketing_links.smart_link ? 'ready' : 'missing'}</div></div>
      <div class="rounded-lg border border-zinc-200 bg-white px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-zinc-400">Release kit</div><div class="mt-1 text-sm font-semibold text-zinc-800">${marketingKit.marketing_links.release_kit_url ? 'ready' : 'missing'}</div></div>
      <div class="rounded-lg border border-zinc-200 bg-white px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-zinc-400">Audio download</div><div class="mt-1 text-sm font-semibold text-zinc-800">${marketingKit.marketing_links.audio_download_url ? 'ready' : 'missing'}</div></div>
      <div class="rounded-lg border border-zinc-200 bg-white px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-zinc-400">Social assets</div><div class="mt-1 text-sm font-semibold text-zinc-800">${marketingKit.marketing_assets.square_post_url || marketingKit.marketing_assets.vertical_post_url || marketingKit.marketing_assets.portrait_post_url ? 'ready' : 'missing'}</div></div>
    </div>
    <div class="mt-3">
      <div id="release-base-image-${attr(summary.songId)}">
        ${renderBaseImageSurface(summary)}
      </div>
    </div>
    <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
      <button type="button" id="build-pack-btn-${attr(summary.songId)}" onclick="buildReleaseMarketingPack('${attr(summary.songId)}')"
        class="w-full rounded-lg bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-700">Build Marketing Pack</button>
      <form onsubmit="event.preventDefault(); uploadReleaseBaseImage('${attr(summary.songId)}')" class="rounded-lg border border-zinc-200 bg-white p-2">
        <label class="block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Upload Base Image</label>
        <input id="base-image-input-${attr(summary.songId)}" type="file" name="base_image" accept=".png,.jpg,.jpeg,.webp" class="mt-1 block w-full text-xs text-zinc-600 file:mr-2 file:rounded-md file:border file:border-zinc-200 file:bg-zinc-50 file:px-2 file:py-1 file:text-xs">
        <button class="mt-2 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500">Upload</button>
      </form>
    </div>
    <div id="build-pack-status-${attr(summary.songId)}" class="mt-3 hidden rounded-lg border border-zinc-200 bg-zinc-950 overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Marketing Pack Build</div>
        <div id="build-pack-badge-${attr(summary.songId)}" class="text-xs text-emerald-400"></div>
      </div>
      <div id="build-pack-log-${attr(summary.songId)}" class="max-h-40 overflow-y-auto p-3 font-mono text-xs text-zinc-300 space-y-1"></div>
      <div id="build-pack-footer-${attr(summary.songId)}" class="px-3 py-2 text-[11px] text-zinc-500 border-t border-zinc-800"></div>
    </div>
    <div class="mt-3 grid grid-cols-2 gap-2">
      ${counts}
    </div>
    <div class="mt-4">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Release Links</div>
      <div class="mt-2 grid grid-cols-1 gap-2">
        ${releaseLinks || '<div class="text-[11px] text-zinc-400">No release or store links surfaced yet.</div>'}
      </div>
    </div>
    <div class="mt-4">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Assets & Pages</div>
      <div class="mt-2 grid grid-cols-1 gap-2">
        ${surfacedAssets || '<div class="text-[11px] text-zinc-400">No surfaced asset links yet.</div>'}
      </div>
    </div>
    <div class="mt-4">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Generation Check</div>
      ${warnings ? `<ul class="mt-2 space-y-1">${warnings}</ul>` : '<div class="mt-2 text-[11px] text-emerald-700">No surfaced marketing warnings.</div>'}
    </div>
    <div class="mt-3 rounded-lg border border-zinc-200 bg-white p-3">
      <div class="text-[10px] uppercase tracking-wide text-zinc-400">Missing fields</div>
      <ul class="mt-1 space-y-1">${missingSummary || '<li class="text-[11px] text-emerald-700">No major gaps</li>'}</ul>
      ${(readiness.warnings || []).length ? `<div class="mt-2 text-[11px] text-amber-700">${esc(readiness.warnings[0])}</div>` : ''}
    </div>
  </aside>`;
}

function renderAssetLink(label, url) {
  return `<a href="${attr(url)}" target="_blank" rel="noopener" class="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-blue-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700">
    <span>${esc(label)}</span>
    <span>Open →</span>
  </a>`;
}

function renderBaseImageSurface(summary) {
  if (summary.baseImage?.url) {
    return `<a href="${attr(summary.baseImage.url)}" target="_blank" rel="noopener" class="block">
      <img src="${attr(summary.baseImage.url)}" alt="Base image" class="w-full h-44 object-cover rounded-xl border border-zinc-200 bg-white">
    </a>`;
  }
  return '<div class="h-44 rounded-xl border border-dashed border-zinc-300 bg-white flex items-center justify-center text-xs text-zinc-400">No base image surfaced</div>';
}

function formatAssetLabel(asset) {
  const base = asset.label || asset.type || 'Asset';
  if (asset.platform) return `${asset.platform} · ${base}`;
  return base;
}

function renderCampaignList(campaigns) {
  const rows = campaigns.map(c => {
    const items = getOutreachItems({ campaign_id: c.id });
    return `<div class="border border-zinc-200 rounded-xl p-4 flex items-start justify-between gap-4"><div><a href="/marketing/campaigns/${attr(c.id)}" class="font-semibold text-blue-700 hover:underline">${esc(c.name)}</a><div class="text-xs text-zinc-500 mt-1">${items.length} item(s)</div></div><a href="/marketing/campaigns/${attr(c.id)}" class="border border-zinc-300 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-zinc-50">Open</a></div>`;
  }).join('');
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold text-lg mb-4">Campaigns / Gmail Draft Queue</h2><div class="space-y-2">${rows || emptyBox('No outreach campaigns yet.')}</div></section>`;
}

function renderMarketingDashboardScript() {
  return `<script>
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function appendBuildLog(songId, message, cls) {
  const log = document.getElementById('build-pack-log-' + songId);
  if (!log) return;
  const row = document.createElement('div');
  row.className = cls || 'text-zinc-300';
  row.textContent = message;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function setBuildStatus(songId, badge, footer, stateClass) {
  const badgeEl = document.getElementById('build-pack-badge-' + songId);
  const footerEl = document.getElementById('build-pack-footer-' + songId);
  if (badgeEl) {
    badgeEl.className = 'text-xs ' + (stateClass || 'text-zinc-300');
    badgeEl.textContent = badge;
  }
  if (footerEl) footerEl.textContent = footer || '';
}

window.uploadReleaseBaseImage = function(songId) {
  const input = document.getElementById('base-image-input-' + songId);
  const file = input?.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append('base_image', file);
  fetch('/api/songs/' + songId + '/base-image', { method: 'POST', body: form })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) throw new Error(d.error || 'Upload failed');
      const container = document.getElementById('release-base-image-' + songId);
      const url = d.baseImage?.url;
      if (container && url) {
        container.innerHTML = '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" class="block"><img src="' + escapeHtml(url) + '?v=' + Date.now() + '" alt="Base image" class="w-full h-44 object-cover rounded-xl border border-zinc-200 bg-white"></a>';
      }
      window.location.reload();
    })
    .catch(err => alert('Base image upload failed: ' + err.message));
};

window.buildReleaseMarketingPack = function(songId) {
  const status = document.getElementById('build-pack-status-' + songId);
  const btn = document.getElementById('build-pack-btn-' + songId);
  const log = document.getElementById('build-pack-log-' + songId);
  if (status) status.classList.remove('hidden');
  if (log) log.innerHTML = '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Building…';
    btn.classList.add('opacity-60');
  }
  setBuildStatus(songId, 'Running', 'Starting build…', 'text-emerald-400');
  appendBuildLog(songId, '$ POST /api/songs/' + songId + '/social-assets', 'text-zinc-500');

  fetch('/api/songs/' + songId + '/social-assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ renderVideos: true }),
  }).then(r => r.json()).then(d => {
    if (!d.jobId) throw new Error(d.error || 'No job ID returned');
    const es = new EventSource('/api/songs/social-assets/stream/' + d.jobId);
    es.addEventListener('log', e => {
      const data = JSON.parse(e.data);
      const message = data.message || '';
      const cls = message.startsWith('✓') || message.startsWith('✅')
        ? 'text-emerald-400'
        : message.startsWith('⚠')
          ? 'text-amber-400'
          : message.startsWith('❌')
            ? 'text-red-400'
            : 'text-zinc-300';
      appendBuildLog(songId, message, cls);
    });
    es.addEventListener('complete', e => {
      es.close();
      const data = JSON.parse(e.data);
      setBuildStatus(songId, 'Done', data.dashboardUrl ? 'Pack ready. Reloading…' : 'Build complete. Reloading…', 'text-emerald-400');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Build Marketing Pack';
        btn.classList.remove('opacity-60');
      }
      setTimeout(() => window.location.reload(), 1200);
    });
    es.addEventListener('error', e => {
      es.close();
      let message = 'Build failed';
      try { message = JSON.parse(e.data).message || message; } catch {}
      setBuildStatus(songId, 'Failed', message, 'text-red-400');
      appendBuildLog(songId, message, 'text-red-400');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Build Marketing Pack';
        btn.classList.remove('opacity-60');
      }
    });
  }).catch(err => {
    setBuildStatus(songId, 'Failed', err.message, 'text-red-400');
    appendBuildLog(songId, err.message, 'text-red-400');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Build Marketing Pack';
      btn.classList.remove('opacity-60');
    }
  });
};
</script>`;
}

function renderInboxTriage({ summary, messages }) {
  const rows = messages.map(m => {
    const gmailUrl = buildGmailMessageUrl(m);
    const subjectHtml = gmailUrl
      ? `<a href="${attr(gmailUrl)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 hover:underline">${esc(m.subject || '(no subject)')}</a>`
      : `<div class="font-semibold">${esc(m.subject || '(no subject)')}</div>`;
    return `<tr class="align-top border-b"><td class="py-3 pr-4">${subjectHtml}<div class="text-xs text-zinc-500">${esc(m.from_name ? `${m.from_name} <${m.from_email || ''}>` : m.from_email || '')}</div></td><td class="py-3 pr-4 text-xs">${esc(m.classification || 'unclassified')}</td><td class="py-3 pr-4 text-xs text-zinc-500">${esc(m.snippet || '').slice(0, 300)}</td><td class="py-3 text-xs"><textarea class="w-full min-h-24 border border-zinc-200 rounded-lg p-2 bg-zinc-50" readonly>${esc(m.suggested_reply || '')}</textarea></td></tr>`;
  }).join('');
  const summaryLine = summary ? `${summary.total || 0} scanned · ${summary.needs_ken || 0} need Ken · ${summary.safe_reply_candidate || 0} safe candidates` : 'Run inbox scan to populate Gmail triage.';
  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6"><h2 class="font-bold text-lg">Gmail Triage / Non-Campaign Replies</h2><p class="text-sm text-zinc-500 mt-1 mb-4">${esc(summaryLine)}</p>${rows ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-xs uppercase text-zinc-400 border-b"><tr><th class="py-2 pr-4">Message</th><th class="py-2 pr-4">Class</th><th class="py-2 pr-4">Snippet</th><th class="py-2">Suggested Reply</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyBox('No Gmail triage items found.')}</section>`;
}

function releaseReadySongs() {
  return getMarketingReleaseEntries(50);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
function statusChip(value, tone = 'complete') {
  const ok = Boolean(value);
  const okClass = 'bg-emerald-100 text-emerald-700';
  const missingClass = tone === 'recommended'
    ? 'bg-amber-100 text-amber-700'
    : 'bg-red-100 text-red-700';
  return `<span class="inline-flex rounded-full px-2 py-1 font-semibold ${ok ? okClass : missingClass}">${ok ? 'Complete' : 'Missing'}</span>`;
}
function buildGmailMessageUrl(msg) {
  if (msg.gmail_thread_id) return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(msg.gmail_thread_id)}`;
  if (msg.gmail_message_id) return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(msg.gmail_message_id)}`;
  return null;
}
function safeInbox() { try { return { summary: getInboxSummary(), messages: getInboxMessages(50).filter(m => m.requires_ken || ['safe_reply_candidate','opportunity','creator_reply','playlist_reply','blog_media_reply','needs_ken','submission_confirmation','platform_admin','account_admin','do_not_contact'].includes(m.classification)) }; } catch { return { summary: null, messages: [] }; } }
