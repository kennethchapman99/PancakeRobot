import { getSong, upsertSong } from '../../../shared/db.js';
import { getSongMarketingKit } from '../../../shared/song-marketing-kit.js';
import {
  getDailySocialCampaignById,
  getDailySocialCampaignForDate,
  getDailySocialCampaigns,
  getSocialPostById,
  getSocialPostsByCampaignId,
  getSocialPublishingSummary,
  updateDailySocialCampaign,
  updateSocialPost,
} from '../../../shared/social-publishing-db.js';
import { createOrRefreshDailySocialCampaign } from '../../../agents/daily-social-planner-agent.js';
import { runSocialPublishWorker } from '../../../agents/social-publish-worker.js';
import { generateSocialCopy } from '../../../agents/social-copy-agent.js';
import { getSocialEnv } from '../../../shared/social/social-env.js';
import { listSocialConnectorStatuses } from '../../../shared/social/social-publisher.js';
import { exchangeYoutubeAuthCode, getYoutubeAuthSummary, getYoutubeAuthUrl } from '../../../shared/social/youtube-auth.js';
import { renderMarketingLayout } from '../views/layout.js';
import { attr, esc, sendJson } from '../utils/http.js';

function todayDate(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function statusChip(status) {
  const tone = {
    published: 'bg-emerald-100 text-emerald-700',
    ready: 'bg-blue-100 text-blue-700',
    ready_for_review: 'bg-amber-100 text-amber-700',
    approved: 'bg-sky-100 text-sky-700',
    draft: 'bg-zinc-100 text-zinc-600',
    queued: 'bg-indigo-100 text-indigo-700',
    needs_auth: 'bg-rose-100 text-rose-700',
    blocked_by_policy: 'bg-rose-100 text-rose-700',
    attention_required: 'bg-rose-100 text-rose-700',
    skipped: 'bg-zinc-100 text-zinc-500',
    failed: 'bg-rose-100 text-rose-700',
    generated: 'bg-emerald-100 text-emerald-700',
    reused: 'bg-blue-100 text-blue-700',
    missing: 'bg-rose-100 text-rose-700',
  }[status] || 'bg-zinc-100 text-zinc-600';
  return `<span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ${tone}">${esc(status || 'draft')}</span>`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderAssetPreview(post) {
  if (!post?.asset_url) return '<div class="w-full h-44 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 flex items-center justify-center text-xs text-zinc-400">Missing asset</div>';
  const url = attr(post.asset_url);
  if (String(post.asset_url).match(/\.(mp4|mov|webm)$/i)) {
    return `<video controls class="w-full h-44 rounded-xl border border-zinc-200 bg-zinc-950"><source src="${url}"></video>`;
  }
  return `<img src="${url}" alt="${esc(post.platform)} asset" class="w-full h-44 object-cover rounded-xl border border-zinc-200 bg-zinc-50">`;
}

function renderWarnings(post) {
  const warnings = [...(post.validation_warnings || []), ...(post.error_message ? [post.error_message] : [])].filter(Boolean);
  if (!warnings.length) return '<div class="text-xs text-zinc-400">No validation warnings.</div>';
  return `<ul class="space-y-1 text-xs text-amber-700">${warnings.map(item => `<li>• ${esc(item)}</li>`).join('')}</ul>`;
}

function warningValue(warnings, prefixes) {
  const prefixList = Array.isArray(prefixes) ? prefixes : [prefixes];
  const match = warnings.find(item => prefixList.some(prefix => String(item || '').startsWith(prefix)));
  if (!match) return '';
  const prefix = prefixList.find(item => String(match).startsWith(item));
  return String(match).slice(prefix.length).trim();
}

function renderYoutubeAssetDetails(post) {
  if (post.platform !== 'youtube') return '';
  const warnings = post.validation_warnings || [];
  const generatedPath = warningValue(warnings, 'YouTube MP4 generated:');
  const reusedPath = warningValue(warnings, 'YouTube MP4 reused:');
  const selectedPath = generatedPath || reusedPath || post.asset_url || '';
  const sourceAudio = warningValue(warnings, 'YouTube source audio:');
  const sourceImage = warningValue(warnings, 'YouTube source image:');
  const isVideo = String(post.asset_type || '').toLowerCase() === 'video' && String(post.asset_url || '').match(/\.(mp4|mov|webm)$/i);
  const state = post.error_message ? 'missing' : generatedPath ? 'generated' : reusedPath ? 'reused' : isVideo ? 'ready' : 'missing';

  return `<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div class="text-[10px] uppercase tracking-wide text-zinc-400">YouTube Asset</div>
      ${statusChip(state)}
    </div>
    <div class="grid gap-1 text-xs text-zinc-600">
      <div><span class="font-medium text-zinc-700">Video:</span> ${esc(selectedPath || '—')}</div>
      <div><span class="font-medium text-zinc-700">Source audio:</span> ${esc(sourceAudio || '—')}</div>
      <div><span class="font-medium text-zinc-700">Source image:</span> ${esc(sourceImage || '—')}</div>
      <div><span class="font-medium text-zinc-700">Privacy:</span> private</div>
    </div>
  </div>`;
}

function renderPostCard(post) {
  const copyBlock = post.platform === 'youtube'
    ? `<div class="space-y-2">
        <div><div class="text-[10px] uppercase tracking-wide text-zinc-400">Title</div><div class="text-sm text-zinc-800">${esc(post.title || '—')}</div></div>
        <div><div class="text-[10px] uppercase tracking-wide text-zinc-400">Description</div><div class="text-sm text-zinc-700 whitespace-pre-wrap">${esc(post.description || '—')}</div></div>
      </div>`
    : `<div class="space-y-2">
        <div><div class="text-[10px] uppercase tracking-wide text-zinc-400">Caption</div><div class="text-sm text-zinc-700 whitespace-pre-wrap">${esc(post.caption || '—')}</div></div>
      </div>`;
  const hashtags = post.hashtags?.length
    ? `<div class="flex flex-wrap gap-1">${post.hashtags.map(tag => `<span class="rounded-full bg-zinc-100 px-2 py-1 text-[11px] text-zinc-600">${esc(tag)}</span>`).join('')}</div>`
    : '<div class="text-xs text-zinc-400">No hashtags.</div>';
  const postUrl = post.platform_post_url ? `<a href="${attr(post.platform_post_url)}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">Open published post</a>` : '<span class="text-xs text-zinc-400">Not published</span>';

  return `<article class="rounded-2xl border border-zinc-200 bg-white p-4 space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold capitalize">${esc(post.platform)}</h3>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          ${statusChip(post.status)}
          <span class="text-xs text-zinc-500">${esc(post.asset_type)}</span>
          <span class="text-xs text-zinc-500">Scheduled ${esc(formatDateTime(post.scheduled_at))}</span>
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="rounded-lg border border-zinc-200 px-3 py-2 text-xs hover:bg-zinc-50" onclick="runSocialAction('/api/social/posts/${attr(post.id)}/regenerate-copy')">Regenerate copy</button>
        <button type="button" class="rounded-lg border border-zinc-200 px-3 py-2 text-xs hover:bg-zinc-50" onclick="runSocialAction('/api/social/posts/${attr(post.id)}/skip')">Skip</button>
      </div>
    </div>
    ${renderAssetPreview(post)}
    ${copyBlock}
    <div>
      <div class="text-[10px] uppercase tracking-wide text-zinc-400 mb-2">Hashtags / tags</div>
      ${hashtags}
    </div>
    ${renderYoutubeAssetDetails(post)}
    <div>
      <div class="text-[10px] uppercase tracking-wide text-zinc-400 mb-2">Validation</div>
      ${renderWarnings(post)}
    </div>
    <div class="flex items-center justify-between gap-2">
      ${postUrl}
      <span class="text-[11px] text-zinc-400">${esc(post.idempotency_key || '')}</span>
    </div>
  </article>`;
}

function renderConfigCard() {
  const connectorStatuses = listSocialConnectorStatuses();
  const youtubeAuth = getYoutubeAuthSummary();
  return `<section class="rounded-2xl border border-zinc-200 bg-white p-6">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold">Platform Config</h2>
        <p class="mt-1 text-sm text-zinc-500">Dry-run stays safe by default. Missing auth/config is surfaced here instead of crashing the lane.</p>
      </div>
    </div>
    <div class="mt-4 grid gap-3 md:grid-cols-3">
      ${connectorStatuses.map(item => `
        <div class="rounded-xl border border-zinc-200 p-4">
          <div class="flex items-center justify-between gap-2">
            <div class="font-medium capitalize">${esc(item.platform)}</div>
            ${statusChip(item.config.ok ? 'ready' : 'needs_auth')}
          </div>
          <div class="mt-3 text-xs text-zinc-500">${item.config.ok ? 'Config present.' : `Missing: ${esc(item.config.missing.join(', '))}`}</div>
          ${item.platform === 'youtube' ? `
            <div class="mt-3 text-xs text-zinc-500">Token path: ${esc(youtubeAuth.tokenPath || '—')}</div>
            <div class="mt-1 text-xs text-zinc-500">Channel: ${esc(youtubeAuth.channelTitle || youtubeAuth.channelId || 'not connected')}</div>
            <div class="mt-3 flex flex-wrap gap-2">
              <a href="/api/auth/youtube/start" class="rounded-lg border border-zinc-200 px-3 py-2 text-xs hover:bg-zinc-50">${youtubeAuth.hasSavedToken || youtubeAuth.hasEnvRefreshToken ? 'Reconnect YouTube' : 'Connect YouTube'}</a>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  </section>`;
}

function renderHistory(campaigns) {
  const rows = campaigns.map(campaign => {
    const song = getSong(campaign.selected_song_id);
    const posts = getSocialPostsByCampaignId(campaign.id);
    const urls = posts
      .filter(post => post.platform_post_url)
      .map(post => `<a href="${attr(post.platform_post_url)}" target="_blank" rel="noopener" class="text-blue-600 hover:underline capitalize">${esc(post.platform)}</a>`)
      .join(' · ') || '<span class="text-zinc-400">—</span>';
    const platforms = posts.map(post => post.platform).join(', ') || '—';
    const errors = posts.filter(post => post.error_message).map(post => `${post.platform}: ${post.error_message}`).join(' | ') || '—';
    return `<tr class="border-b border-zinc-100 align-top">
      <td class="py-3 pr-4 text-sm">${esc(campaign.date)}</td>
      <td class="py-3 pr-4 text-sm">${esc(song?.title || song?.topic || campaign.selected_song_id)}</td>
      <td class="py-3 pr-4 text-sm capitalize">${esc(platforms)}</td>
      <td class="py-3 pr-4 text-sm">${statusChip(campaign.status)}</td>
      <td class="py-3 pr-4 text-xs">${urls}</td>
      <td class="py-3 text-xs text-zinc-500">${esc(errors)}</td>
    </tr>`;
  }).join('');
  return `<section class="rounded-2xl border border-zinc-200 bg-white p-6">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">History</h2>
        <p class="mt-1 text-sm text-zinc-500">Owned social only. Outreach campaigns, reviewers, radio targets, and playlist contacts stay separate.</p>
      </div>
    </div>
    <div class="mt-4 overflow-x-auto">
      <table class="min-w-full text-left">
        <thead class="border-b border-zinc-200 text-[11px] uppercase tracking-wide text-zinc-400">
          <tr>
            <th class="py-2 pr-4">Date</th>
            <th class="py-2 pr-4">Song</th>
            <th class="py-2 pr-4">Platforms</th>
            <th class="py-2 pr-4">Status</th>
            <th class="py-2 pr-4">Post URLs</th>
            <th class="py-2">Errors</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="6" class="py-6 text-sm text-zinc-400">No daily social history yet.</td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

function renderCampaignPanel(campaign, posts) {
  const song = campaign ? getSong(campaign.selected_song_id) : null;
  if (!campaign || !song) {
    return `<section class="rounded-2xl border border-zinc-200 bg-white p-6">
      <h2 class="text-lg font-semibold">Today’s Campaign</h2>
      <p class="mt-2 text-sm text-zinc-500">No campaign exists for today yet. Use Generate Dry Run to create one.</p>
      <div class="mt-4">
        <button type="button" class="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700" onclick="runSocialAction('/api/social/daily/run-dry-run')">Generate Dry Run</button>
      </div>
    </section>`;
  }

  const songUrl = `/songs/${encodeURIComponent(song.id)}?tab=marketing`;
  const releaseKitUrl = `/release-kit/${encodeURIComponent(song.id)}`;
  return `<section class="rounded-2xl border border-zinc-200 bg-white p-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="text-xs uppercase tracking-[0.2em] text-zinc-400">Today’s Campaign</div>
        <h2 class="mt-2 text-2xl font-semibold">${esc(song.title || song.topic || song.id)}</h2>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          ${statusChip(campaign.status)}
          <span class="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">${esc(campaign.campaign_type)}</span>
          <span class="text-xs text-zinc-500">${esc(campaign.timezone)}</span>
        </div>
        <p class="mt-4 max-w-3xl text-sm text-zinc-600">${esc(campaign.rationale || 'No rationale saved.')}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700" onclick="runSocialAction('/api/social/daily/run-dry-run')">Generate Dry Run</button>
        <button type="button" class="rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50" onclick="runSocialAction('/api/social/daily/${attr(campaign.id)}/approve')">Approve all</button>
        <button type="button" class="rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50" onclick="runSocialAction('/api/social/daily/${attr(campaign.id)}/publish')">Publish now</button>
        <button type="button" class="rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50" onclick="skipCampaign([${posts.map(post => `'${post.id}'`).join(', ')}])">Skip today</button>
        <a href="${attr(releaseKitUrl)}" class="rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50">View release kit</a>
        <a href="${attr(songUrl)}" class="rounded-lg border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50">View song</a>
      </div>
    </div>
    <div class="mt-6 grid gap-4 xl:grid-cols-3">${posts.map(renderPostCard).join('') || '<div class="text-sm text-zinc-400">No platform posts yet.</div>'}</div>
  </section>`;
}

export function renderDailySocialPage(req, res) {
  const env = getSocialEnv();
  const date = todayDate(env.dailySocialTimezone);
  const campaign = getDailySocialCampaignForDate(date);
  const posts = campaign ? getSocialPostsByCampaignId(campaign.id) : [];
  const history = getDailySocialCampaigns({ limit: 20 });
  const summary = getSocialPublishingSummary();

  const body = `<main class="p-8 space-y-6">
    <section class="rounded-2xl border border-zinc-200 bg-white p-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-3xl font-extrabold">Daily Social Publishing</h1>
          <p class="mt-2 text-sm text-zinc-500">Owned social broadcasting only: Facebook Page, Instagram, and YouTube. Dry-run and approval-first by default.</p>
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div class="rounded-xl border border-zinc-200 px-4 py-3"><div class="text-[10px] uppercase tracking-wide text-zinc-400">Mode</div><div class="mt-1 font-semibold text-zinc-800">${esc(env.socialPublishMode)}</div></div>
          <div class="rounded-xl border border-zinc-200 px-4 py-3"><div class="text-[10px] uppercase tracking-wide text-zinc-400">Approval</div><div class="mt-1 font-semibold text-zinc-800">${env.dailySocialRequireApproval ? 'required' : 'optional'}</div></div>
          <div class="rounded-xl border border-zinc-200 px-4 py-3"><div class="text-[10px] uppercase tracking-wide text-zinc-400">Today</div><div class="mt-1 font-semibold text-zinc-800">${esc(date)}</div></div>
          <div class="rounded-xl border border-zinc-200 px-4 py-3"><div class="text-[10px] uppercase tracking-wide text-zinc-400">Posts tracked</div><div class="mt-1 font-semibold text-zinc-800">${summary.totals?.total_posts || 0}</div></div>
        </div>
      </div>
    </section>
    <div id="social-action-status" hidden class="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800"></div>
    <div id="social-action-error" hidden class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"></div>
    ${renderConfigCard()}
    ${renderCampaignPanel(campaign, posts)}
    ${renderHistory(history)}
  </main>
  <script>
    function setSocialMessage(id, message) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = message || '';
      el.hidden = !message;
    }
    function setSocialButtonsDisabled(disabled) {
      document.querySelectorAll('button').forEach(button => {
        button.disabled = disabled;
        button.classList.toggle('opacity-60', disabled);
        button.classList.toggle('cursor-wait', disabled);
      });
    }
    async function runSocialAction(url, reload = true) {
      setSocialMessage('social-action-error', '');
      setSocialMessage('social-action-status', 'Working...');
      setSocialButtonsDisabled(true);
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.ok === false) {
          const error = body.error || 'Request failed';
          setSocialMessage('social-action-error', error);
          setSocialMessage('social-action-status', '');
          return false;
        }
        const processed = Array.isArray(body.processed) ? body.processed.length : null;
        setSocialMessage('social-action-status', processed === null ? 'Done. Reloading...' : 'Done. Processed ' + processed + ' post(s). Reloading...');
        if (reload) setTimeout(() => window.location.reload(), 350);
        return true;
      } catch (error) {
        setSocialMessage('social-action-error', error.message || String(error));
        setSocialMessage('social-action-status', '');
        return false;
      } finally {
        setSocialButtonsDisabled(false);
      }
    }
    async function skipCampaign(postIds) {
      for (const id of postIds) {
        const ok = await runSocialAction('/api/social/posts/' + encodeURIComponent(id) + '/skip', false);
        if (!ok) return;
      }
      window.location.reload();
    }
  </script>`;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout('Daily Social', body));
}

export async function postRunDailySocialDryRun(_req, res) {
  try {
    const result = createOrRefreshDailySocialCampaign();
    const worker = await runSocialPublishWorker({ campaignId: result.campaign.id, force: true });
    sendJson(res, {
      ok: true,
      campaign: getDailySocialCampaignById(result.campaign.id),
      posts: getSocialPostsByCampaignId(result.campaign.id),
      processed: worker.processed,
      config: listSocialConnectorStatuses(),
    });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

export async function postApproveDailySocialCampaign(req, res) {
  try {
    const campaign = getDailySocialCampaignById(req.params.campaignId);
    if (!campaign) return sendJson(res, { ok: false, error: 'Campaign not found.' }, 404);
    updateDailySocialCampaign(campaign.id, { status: 'approved', approved_at: new Date().toISOString() });
    for (const post of getSocialPostsByCampaignId(campaign.id)) {
      if (!['published', 'skipped'].includes(post.status)) updateSocialPost(post.id, { status: 'approved' });
    }
    sendJson(res, { ok: true, campaign: getDailySocialCampaignById(campaign.id), posts: getSocialPostsByCampaignId(campaign.id) });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

export async function postPublishDailySocialCampaign(req, res) {
  try {
    const campaign = getDailySocialCampaignById(req.params.campaignId);
    if (!campaign) return sendJson(res, { ok: false, error: 'Campaign not found.' }, 404);
    if (!campaign.approved_at) updateDailySocialCampaign(campaign.id, { status: 'approved', approved_at: new Date().toISOString() });
    const worker = await runSocialPublishWorker({ campaignId: campaign.id, force: true });
    sendJson(res, { ok: true, campaign: getDailySocialCampaignById(campaign.id), posts: getSocialPostsByCampaignId(campaign.id), processed: worker.processed });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

export function postRegenerateSocialCopy(req, res) {
  try {
    const post = getSocialPostById(req.params.postId);
    if (!post) return sendJson(res, { ok: false, error: 'Post not found.' }, 404);
    const campaign = getDailySocialCampaignById(post.campaign_id);
    const song = getSong(post.song_id);
    if (!campaign || !song) return sendJson(res, { ok: false, error: 'Campaign or song not found.' }, 404);
    const marketingKit = getSongMarketingKit(song);
    const copy = generateSocialCopy({
      platform: post.platform,
      song,
      marketingKit,
      campaignType: campaign.campaign_type,
      assetType: post.asset_type,
      madeForKids: post.platform === 'youtube' ? (post.made_for_kids === null ? false : post.made_for_kids) : null,
    });
    const updated = updateSocialPost(post.id, {
      title: copy.title,
      caption: copy.caption,
      description: copy.description,
      hashtags: copy.hashtags,
      status: ['published', 'skipped'].includes(post.status) ? post.status : 'draft',
    });
    sendJson(res, { ok: true, post: updated });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

export function postSkipSocialPost(req, res) {
  try {
    const post = getSocialPostById(req.params.postId);
    if (!post) return sendJson(res, { ok: false, error: 'Post not found.' }, 404);
    const updated = updateSocialPost(post.id, { status: 'skipped', error_code: null, error_message: null });
    sendJson(res, { ok: true, post: updated });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

export function startYoutubeAuth(req, res) {
  try {
    const state = Buffer.from(JSON.stringify({
      returnTo: '/marketing/social',
      startedAt: Date.now(),
    }), 'utf8').toString('base64url');
    res.redirect(303, getYoutubeAuthUrl({ state }));
  } catch (error) {
    res.statusCode = 500;
    res.end(renderMarketingLayout('YouTube Auth Error', `<main class="p-8"><section class="rounded-2xl border border-red-200 bg-red-50 p-6"><h1 class="text-xl font-semibold text-red-800">YouTube auth could not start</h1><p class="mt-3 text-sm text-red-700">${esc(error.message)}</p><div class="mt-4"><a href="/marketing/social" class="text-blue-600 hover:underline">Back to Daily Social</a></div></section></main>`));
  }
}

export async function handleYoutubeAuthCallback(req, res) {
  const callbackError = String(req.query.error || '').trim();
  if (callbackError) {
    res.statusCode = 400;
    res.end(renderMarketingLayout('YouTube Auth Failed', `<main class="p-8"><section class="rounded-2xl border border-red-200 bg-red-50 p-6"><h1 class="text-xl font-semibold text-red-800">YouTube authorization failed</h1><p class="mt-3 text-sm text-red-700">${esc(callbackError)}</p><div class="mt-4"><a href="/marketing/social" class="text-blue-600 hover:underline">Back to Daily Social</a></div></section></main>`));
    return;
  }

  const code = String(req.query.code || '').trim();
  if (!code) {
    res.statusCode = 400;
    res.end(renderMarketingLayout('YouTube Auth Failed', '<main class="p-8"><section class="rounded-2xl border border-red-200 bg-red-50 p-6"><h1 class="text-xl font-semibold text-red-800">Missing YouTube authorization code</h1><div class="mt-4"><a href="/marketing/social" class="text-blue-600 hover:underline">Back to Daily Social</a></div></section></main>'));
    return;
  }

  try {
    const result = await exchangeYoutubeAuthCode(code);
    res.end(renderMarketingLayout('YouTube Connected', `<main class="p-8"><section class="rounded-2xl border border-emerald-200 bg-emerald-50 p-6"><h1 class="text-xl font-semibold text-emerald-800">YouTube connected</h1><p class="mt-3 text-sm text-emerald-700">Channel: ${esc(result.channelTitle || result.channelId)}</p><p class="mt-1 text-xs text-emerald-700">Saved token path: ${esc(result.tokenPath)}</p><p class="mt-4 text-sm text-emerald-700">Return to Daily Social when you are ready to test uploads.</p><div class="mt-4"><a href="/marketing/social" class="text-blue-600 hover:underline">Back to Daily Social</a></div></section></main>`));
  } catch (authError) {
    res.statusCode = 500;
    res.end(renderMarketingLayout('YouTube Auth Failed', `<main class="p-8"><section class="rounded-2xl border border-red-200 bg-red-50 p-6"><h1 class="text-xl font-semibold text-red-800">YouTube authorization failed</h1><p class="mt-3 text-sm text-red-700">${esc(authError.message)}</p><div class="mt-4"><a href="/marketing/social" class="text-blue-600 hover:underline">Back to Daily Social</a></div></section></main>`));
  }
}
