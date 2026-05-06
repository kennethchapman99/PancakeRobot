import { getActiveProfileId } from '../../../shared/brand-profile.js';
import { getActiveBrandOutlets, getMarketingOutletsDiagnostics, isTestOrDemoTarget } from '../../../shared/marketing-outlet-health.js';
import { renderMarketingLayout } from '../views/layout.js';
import { esc, attr } from '../utils/http.js';

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const AI_POLICY_LABELS = {
  allowed: { label: 'Allowed', cls: 'bg-emerald-100 text-emerald-800' },
  unclear: { label: 'Unclear', cls: 'bg-zinc-100 text-zinc-700' },
  not_found: { label: 'Not found', cls: 'bg-sky-100 text-sky-800' },
  banned: { label: 'Banned', cls: 'bg-red-100 text-red-800' },
};

export function renderOutletsPage(req, res) {
  const brandProfileId = getActiveProfileId();
  const filters = {
    status: req.query.status || undefined,
    type: req.query.type || undefined,
    q: req.query.q || undefined,
  };
  const showTestData = req.query.show_test_data === 'true';
  const showExcluded = req.query.show_excluded !== 'false';
  const eligibleOnly = req.query.eligible === 'true';
  const diagnostics = getMarketingOutletsDiagnostics({ brandProfileId });

  let outlets = getActiveBrandOutlets({ brandProfileId, includeTestData: showTestData, filters });
  if (req.query.priority) outlets = outlets.filter(o => o.priority === req.query.priority);
  if (req.query.cost_status) outlets = outlets.filter(o => o.cost_status === req.query.cost_status);
  if (req.query.ai_policy) outlets = outlets.filter(o => o.ai_policy === req.query.ai_policy);
  if (req.query.contactability) outlets = outlets.filter(o => o.contactability.status === req.query.contactability);
  if (req.query.best_channel) outlets = outlets.filter(o => o.contactability.best_channel === req.query.best_channel);
  if (!showExcluded || eligibleOnly) outlets = outlets.filter(o => o.eligible === true);
  if (!showTestData) outlets = outlets.filter(o => !isTestOrDemoTarget(o));

  outlets.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 5;
    const pb = PRIORITY_ORDER[b.priority] ?? 5;
    return pa !== pb ? pa - pb : (b.fit_score || 0) - (a.fit_score || 0);
  });

  const rows = outlets.map(o => {
    const aiInfo = AI_POLICY_LABELS[o.ai_policy] || { label: o.ai_policy || '—', cls: 'bg-zinc-100 text-zinc-700' };
    const eligibleCls = o.eligible ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800';
    const contactabilityCls = o.contactability.status === 'contactable'
      ? 'bg-emerald-100 text-emerald-800'
      : ['contactable_manual', 'owned_action'].includes(o.contactability.status)
        ? 'bg-sky-100 text-sky-800'
        : o.contactability.status === 'manual_research_needed'
          ? 'bg-amber-100 text-amber-800'
          : 'bg-zinc-100 text-zinc-700';
    const costCls = o.cost_status === 'paid'
      ? 'bg-red-100 text-red-800'
      : o.cost_status === 'unclear'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-emerald-100 text-emerald-800';
    const lastContact = o.last_contact
      ? `<div class="text-xs text-zinc-600">${esc(formatDateTime(o.last_contact.contacted_at))}</div><div class="text-[11px] text-zinc-500">${esc(o.last_contact.release_title || o.last_contact.release_id || '')}</div><div class="text-[11px] text-zinc-500">${esc(o.last_contact.status || '')}</div>`
      : `<span class="text-xs text-zinc-400">—</span>`;
    const lastMessage = o.last_contact
      ? `<details class="text-xs"><summary class="cursor-pointer text-blue-600 hover:underline">View last message</summary><div class="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 whitespace-pre-wrap text-zinc-700">${esc(o.outreach_history?.[0]?.message_body || o.last_contact.message_preview || '')}</div></details>`
      : `<span class="text-xs text-zinc-400">—</span>`;
    const contact = o.contactability.contact_methods[0]
      ? `<span class="text-xs text-zinc-600">${esc(o.contactability.contact_methods[0].value)}</span>`
      : `<span class="text-xs text-zinc-400">—</span>`;
    const name = o.url
      ? `<a href="${attr(o.url)}" target="_blank" rel="noopener" class="font-medium text-blue-700 hover:underline">${esc(o.name)}</a>`
      : `<span class="font-medium">${esc(o.name)}</span>`;

    return `<tr class="border-b border-zinc-100 hover:bg-zinc-50">
      <td class="py-2 pr-3 text-sm">${name}</td>
      <td class="py-2 pr-3 text-xs text-zinc-600">${esc(o.type || '—')}</td>
      <td class="py-2 pr-3 text-xs font-mono font-semibold">${esc(o.priority || '—')}</td>
      <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium ${eligibleCls}">${o.eligible ? 'Eligible' : 'Excluded'}</span></td>
      <td class="py-2 pr-3 text-xs text-zinc-600">${esc(o.outreach_eligibility.reason_summary || '—')}</td>
      <td class="py-2 pr-3">${lastContact}</td>
      <td class="py-2 pr-3">${lastMessage}</td>
      <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium ${costCls}">${esc(o.cost_status)}</span></td>
      <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium ${aiInfo.cls}">${esc(aiInfo.label)}</span></td>
      <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium ${contactabilityCls}">${esc(o.contactability.status)}</span></td>
      <td class="py-2 pr-3 text-xs text-zinc-600">${esc(o.contactability.best_channel || '—')}</td>
      <td class="py-2 pr-3">${contact}</td>
      <td class="py-2 text-xs text-zinc-500 text-right">${o.fit_score != null ? o.fit_score : '—'}</td>
    </tr>`;
  }).join('');

  const summaryCards = `<div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-9 gap-2 mb-4">
    ${statCard('Source JSON outlets', diagnostics.sourceOutletCount)}
    ${statCard('Active DB outlets', diagnostics.activeBrandOutletCount)}
    ${statCard('Eligible', diagnostics.eligibleCount)}
    ${statCard('Contactable', diagnostics.contactableCount)}
    ${statCard('Email', diagnostics.emailCount)}
    ${statCard('Contact form/manual', diagnostics.contactFormCount)}
    ${statCard('Owned channel', diagnostics.ownedChannelCount)}
    ${statCard('Excluded', diagnostics.excludedCount)}
    ${statCard('Test/demo hidden', diagnostics.hiddenTestDemoCount)}
  </div>`;

  const filterBar = `<form method="GET" action="/marketing/outlets" class="flex flex-wrap gap-2 items-end">
    <input type="hidden" name="show_excluded" value="false">
    <input name="q" value="${attr(req.query.q || '')}" placeholder="Search name…" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm w-48">
    <select name="priority" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm">
      <option value="">All priorities</option>
      ${['P0', 'P1', 'P2', 'P3'].map(p => `<option value="${p}"${req.query.priority === p ? ' selected' : ''}>${p}</option>`).join('')}
    </select>
    <select name="type" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm">
      <option value="">All types</option>
      ${['playlist', 'podcast', 'publication', 'educator', 'parent_creator', 'radio', 'blog', 'community', 'kids_music_channel', 'media'].map(t => `<option value="${t}"${req.query.type === t ? ' selected' : ''}>${t}</option>`).join('')}
    </select>
    <select name="cost_status" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm">
      <option value="">All costs</option>
      ${['free', 'paid', 'unclear'].map(v => `<option value="${v}"${req.query.cost_status === v ? ' selected' : ''}>${v}</option>`).join('')}
    </select>
    <select name="ai_policy" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm">
      <option value="">All AI policies</option>
      ${['allowed', 'not_found', 'unclear', 'banned'].map(v => `<option value="${v}"${req.query.ai_policy === v ? ' selected' : ''}>${v}</option>`).join('')}
    </select>
    <select name="contactability" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm">
      <option value="">All contactability</option>
      ${['contactable', 'contactable_manual', 'owned_action', 'manual_research_needed'].map(v => `<option value="${v}"${req.query.contactability === v ? ' selected' : ''}>${v}</option>`).join('')}
    </select>
    <label class="flex items-center gap-2 text-sm px-2 py-1.5">
      <input type="checkbox" name="show_excluded" value="true" ${showExcluded ? 'checked' : ''}>
      Show excluded too
    </label>
    <label class="flex items-center gap-2 text-sm px-2 py-1.5">
      <input type="checkbox" name="eligible" value="true" ${eligibleOnly ? 'checked' : ''}>
      Eligible only
    </label>
    <label class="flex items-center gap-2 text-sm px-2 py-1.5">
      <input type="checkbox" name="show_test_data" value="true" ${showTestData ? 'checked' : ''}>
      Show test data
    </label>
    <button class="bg-zinc-800 text-white rounded-lg px-3 py-1.5 text-sm">Filter</button>
    <a href="/marketing/outlets" class="text-sm text-zinc-500 hover:underline py-1.5">Clear</a>
  </form>`;

  const table = rows
    ? `<div class="overflow-x-auto"><table class="w-full text-sm">
        <thead class="text-left text-xs uppercase text-zinc-400 border-b border-zinc-200">
          <tr>
            <th class="py-2 pr-3">Name</th>
            <th class="py-2 pr-3">Type</th>
            <th class="py-2 pr-3">Priority</th>
            <th class="py-2 pr-3">Eligible</th>
            <th class="py-2 pr-3">Reason</th>
            <th class="py-2 pr-3">Last Contact</th>
            <th class="py-2 pr-3">Last Message</th>
            <th class="py-2 pr-3">Cost</th>
            <th class="py-2 pr-3">AI Policy</th>
            <th class="py-2 pr-3">Contactability</th>
            <th class="py-2 pr-3">Best Channel</th>
            <th class="py-2 pr-3">Contact</th>
            <th class="py-2 text-right">Fit</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<p class="text-zinc-400 text-sm py-8 text-center">No outlets match these filters.</p>`;

  const body = `<main class="p-8 space-y-6">
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">
      <div class="flex items-center justify-between gap-4 mb-4">
        <div>
          <h1 class="text-2xl font-extrabold">Outlets</h1>
          <p class="text-sm text-zinc-500 mt-1">${outlets.length} visible outlet(s) · active brand <span class="font-mono">${esc(brandProfileId)}</span> · <a href="/marketing" class="text-blue-600 hover:underline">← Marketing</a></p>
        </div>
      </div>
      ${summaryCards}
      <details class="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
        <summary class="cursor-pointer text-sm font-semibold text-zinc-700">Diagnostics</summary>
        <div class="mt-3 text-xs text-zinc-600 space-y-1">
          <div>Active DB path: <span class="font-mono">${esc(diagnostics.activeDbPath)}</span></div>
          <div>Source JSON path: <span class="font-mono">${esc(diagnostics.sourcePath)}</span></div>
          <div>Preset counts: safe_p0 ${diagnostics.presetCounts.safe_p0}, safe_p0_p1 ${diagnostics.presetCounts.safe_p0_p1}, all_safe ${diagnostics.presetCounts.all_safe}, playlist ${diagnostics.presetCounts.playlist}, parent_teacher ${diagnostics.presetCounts.parent_teacher}</div>
          ${diagnostics.issues.length ? `<div class="text-red-700">Issues: ${esc(diagnostics.issues.join(' | '))}</div>` : '<div class="text-emerald-700">Preflight checks are passing.</div>'}
        </div>
      </details>
      ${filterBar}
    </section>
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">${table}</section>
  </main>`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout('Outlets', body));
}

function formatDateTime(value) {
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

function statCard(label, value) {
  return `<div class="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-zinc-400">${esc(label)}</div><div class="mt-1 text-lg font-semibold text-zinc-900">${esc(String(value))}</div></div>`;
}
