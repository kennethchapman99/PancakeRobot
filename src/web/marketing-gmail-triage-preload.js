import { createRequire } from 'module';
import { getInboxMessages, getInboxSummary } from '../shared/marketing-inbox-db.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import { buildBrandSocialLinks } from '../shared/marketing-email-assets.js';

const require = createRequire(import.meta.url);
const express = require('express');
const originalHandle = express.application.handle;
const BRAND_PROFILE = loadBrandProfile();

express.application.handle = function marketingGmailTriageHandle(req, res, done) {
  const pathname = new URL(req.url, 'http://local').pathname;

  if (pathname === '/marketing' && req.method === 'GET') {
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const chunks = [];

    res.write = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof cb === 'function') cb();
      return true;
    };

    res.end = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      let html = Buffer.concat(chunks).toString('utf8');

      try {
        const triageHtml = renderGmailTriageSection();
        if (html.includes('</main>')) {
          html = html.replace('</main>', `${triageHtml}</main>`);
        } else if (html.includes('</body>')) {
          html = html.replace('</body>', `${triageHtml}</body>`);
        }
      } catch (error) {
        const fallback = `<section class="bg-white border border-red-200 rounded-2xl p-6"><h2 class="font-bold text-lg">Gmail Triage</h2><p class="text-sm text-red-700 mt-2">Could not load Gmail triage: ${esc(error.message)}</p></section>`;
        html = html.includes('</main>') ? html.replace('</main>', `${fallback}</main>`) : html;
      }

      return originalEnd(html, 'utf8', cb);
    };

    return originalHandle.call(this, req, res, done);
  }

  return originalHandle.call(this, req, res, done);
};

function renderGmailTriageSection() {
  let messages = [];
  let summary = null;

  try {
    summary = getInboxSummary();
    messages = getInboxMessages(50).filter(msg => {
      const classification = msg.classification || '';
      return msg.requires_ken || [
        'safe_reply_candidate',
        'opportunity',
        'creator_reply',
        'playlist_reply',
        'blog_media_reply',
        'needs_ken',
        'submission_confirmation',
        'platform_admin',
        'account_admin',
        'do_not_contact',
      ].includes(classification);
    });
  } catch {
    messages = [];
    summary = null;
  }

  const summaryLine = summary
    ? `${summary.total || 0} scanned · ${summary.needs_ken || 0} need Ken · ${summary.safe_reply_candidate || 0} safe reply candidates · ${summary.opportunity || 0} opportunities`
    : 'Run inbox scan to populate Gmail triage.';

  const heading = `<div class="flex items-center justify-between gap-3 mb-4">
    <div>
      <h2 class="font-bold text-lg">Gmail Triage / Non-Campaign Replies</h2>
      <p class="text-sm text-zinc-500 mt-1">${esc(summaryLine)}</p>
    </div>
    <form method="POST" action="/marketing/agents/inbox-scan">
      <button class="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-semibold">Refresh Gmail scan</button>
    </form>
  </div>`;

  if (!messages.length) {
    return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">${heading}<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No Gmail triage items found. Run inbox scan to refresh.</div></section>`;
  }

  const rows = messages.map((msg, i) => {
    const reply = msg.suggested_reply || buildSuggestedReply(msg);
    const replyId = `gmail-triage-reply-${i}`;
    const from = msg.from_name
      ? `${msg.from_name} <${msg.from_email || ''}>`
      : msg.from_email || '';
    const gmailUrl = buildGmailMessageUrl(msg);
    const subjectHtml = gmailUrl
      ? `<a href="${esc(gmailUrl)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 hover:underline">${esc(msg.subject || '(no subject)')}</a>`
      : `<div class="font-semibold">${esc(msg.subject || '(no subject)')}</div>`;

    return `<tr class="align-top border-b last:border-b-0">
      <td class="py-4 pr-4 font-medium max-w-xs">
        ${subjectHtml}
        <div class="text-xs text-zinc-500 mt-0.5">${esc(from)}</div>
        <div class="text-xs text-zinc-400 mt-0.5">${msg.received_at ? esc(new Date(msg.received_at).toLocaleString()) : ''}</div>
      </td>
      <td class="py-4 pr-4">
        <span class="${inboxBadge(msg.classification)}">${esc(msg.classification || 'unclassified')}</span>
        <div class="${msg.requires_ken ? 'text-amber-600' : 'text-zinc-400'} font-semibold text-xs mt-1">${msg.requires_ken ? 'NEEDS-KEN' : esc(msg.status || 'new')}</div>
      </td>
      <td class="py-4 pr-4 text-zinc-500 text-xs max-w-sm">${esc(msg.snippet || '').slice(0, 420)}</td>
      <td class="py-4 pl-2 min-w-80">
        <div class="relative">
          <textarea id="${replyId}" class="w-full text-xs font-mono border border-zinc-200 rounded-lg p-3 bg-zinc-50 resize-y min-h-36" readonly>${esc(reply)}</textarea>
          <button type="button" onclick="(function(btn){const t=document.getElementById('${replyId}');navigator.clipboard.writeText(t.value).then(()=>{const orig=btn.textContent;btn.textContent='Copied!';btn.classList.add('bg-emerald-600');setTimeout(()=>{btn.textContent=orig;btn.classList.remove('bg-emerald-600')},1500)});})(this)" class="absolute top-2 right-2 bg-zinc-800 hover:bg-zinc-700 text-white text-xs px-2 py-1 rounded transition-colors">Copy</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<section class="bg-white border border-zinc-200 rounded-2xl p-6">
    ${heading}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase text-zinc-400 border-b">
          <tr><th class="py-3 pr-4">Message</th><th class="py-3 pr-4">Status</th><th class="py-3 pr-4">Snippet</th><th class="py-3 pl-2">Suggested Reply</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function buildSuggestedReply(msg) {
  const social = BRAND_PROFILE.social || {};
  const brand = BRAND_PROFILE.brand_name || 'Pancake Robot';
  const email = social.email_contact || 'pancake.robot.music@gmail.com';
  const combined = `${msg.subject || ''} ${msg.snippet || ''} ${msg.body_text || ''}`.toLowerCase();
  const hasPlaylist = /playlist|curator|curate/.test(combined);
  const hasPress = /blog|press|review|media|feature|interview/.test(combined);
  const hasCollaboration = /collab|partner|sponsor|brand deal/.test(combined);

  const links = buildBrandSocialLinks().map(link => `${link.label}: ${link.url}`);
  if (social.linktree_url) links.push(`All links: ${social.linktree_url}`);
  if (social.press_kit_url) links.push(`Press kit: ${social.press_kit_url}`);
  const linkBlock = links.length ? links.join('\n') : '[Add social links in Brand Profile → social section]';

  if (hasPlaylist) {
    return `Hi,\n\nThanks so much for reaching out. We'd love to have ${brand} considered for your playlist.\n\n${brand} makes upbeat, silly children's music for families and kids — high-energy pop songs designed for replayability and participation.\n\nHere are our links:\n${linkBlock}\n\nHappy to send specific tracks or any other info you need.\n\nBest,\nKen (${brand})\n${email}`;
  }

  if (hasPress) {
    return `Hi,\n\nThanks for your interest in ${brand}.\n\n${brand} is a children's music project featuring upbeat, singalong-ready songs for kids and families.\n\nHere are our links:\n${linkBlock}\n\nHappy to answer questions, share tracks, or send more background.\n\nBest,\nKen (${brand})\n${email}`;
  }

  if (hasCollaboration) {
    return `Hi,\n\nThanks for reaching out about a collaboration. We're open to the right partnerships for ${brand}.\n\nHere's a quick overview of where we are:\n${linkBlock}\n\nFeel free to send over more details on what you have in mind.\n\nBest,\nKen (${brand})\n${email}`;
  }

  return `Hi,\n\nThanks so much for reaching out.\n\n${brand} is a children's music project with upbeat, silly songs for kids and families.\n\nHere are our links:\n${linkBlock}\n\nLet me know what would be most helpful.\n\nBest,\nKen (${brand})\n${email}`;
}

function buildGmailMessageUrl(msg) {
  if (msg.gmail_thread_id) return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(msg.gmail_thread_id)}`;
  if (msg.gmail_message_id) return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(msg.gmail_message_id)}`;
  return null;
}

function inboxBadge(cls) {
  const map = {
    do_not_contact:'bg-red-100 text-red-700',
    safe_reply_candidate:'bg-emerald-100 text-emerald-700',
    opportunity:'bg-amber-100 text-amber-700',
    submission_confirmation:'bg-blue-100 text-blue-700',
    vendor_spam:'bg-zinc-100 text-zinc-500',
    needs_ken:'bg-orange-100 text-orange-700',
    creator_reply:'bg-violet-100 text-violet-700',
    playlist_reply:'bg-indigo-100 text-indigo-700',
    blog_media_reply:'bg-sky-100 text-sky-700',
    platform_admin:'bg-gray-100 text-gray-500',
    account_admin:'bg-gray-100 text-gray-500',
  };
  return `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[cls] || 'bg-zinc-100 text-zinc-600'}`;
}

function esc(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#39;');
}
