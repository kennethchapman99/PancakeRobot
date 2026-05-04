import { getMarketingTargets } from '../../../shared/marketing-db.js';
import { normalizeOutletForApi } from './api-controller.js';
import { renderMarketingLayout } from '../views/layout.js';
import { esc, attr } from '../utils/http.js';

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const AI_POLICY_LABELS = {
  allowed: { label: 'Allowed', cls: 'bg-emerald-100 text-emerald-800' },
  disclosure_required: { label: 'Disclosure req.', cls: 'bg-yellow-100 text-yellow-800' },
  unclear: { label: 'Unclear', cls: 'bg-zinc-100 text-zinc-700' },
  likely_hostile: { label: 'Likely hostile', cls: 'bg-orange-100 text-orange-800' },
  banned: { label: 'Banned', cls: 'bg-red-100 text-red-800' },
};

export function renderOutletsPage(req, res) {
  const filters = {
    status: req.query.status || undefined,
    type: req.query.type || undefined,
    q: req.query.q || undefined,
  };

  let outlets = getMarketingTargets(filters).map(normalizeOutletForApi);
  if (req.query.priority) outlets = outlets.filter(o => o.priority === req.query.priority);

  outlets.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 5;
    const pb = PRIORITY_ORDER[b.priority] ?? 5;
    return pa !== pb ? pa - pb : (b.fit_score || 0) - (a.fit_score || 0);
  });

  const statusCounts = {};
  outlets.forEach(o => { statusCounts[o.status] = (statusCounts[o.status] || 0) + 1; });

  const rows = outlets.map(o => {
    const aiInfo = AI_POLICY_LABELS[o.ai_policy] || { label: o.ai_policy || '—', cls: 'bg-zinc-100 text-zinc-700' };
    const contact = o.contact?.email
      ? `<a href="mailto:${attr(o.contact.email)}" class="text-blue-600 hover:underline text-xs">${esc(o.contact.email)}</a>`
      : o.contact?.method
        ? `<span class="text-xs text-zinc-500">${esc(String(o.contact.method).slice(0, 40))}</span>`
        : `<span class="text-xs text-zinc-400">—</span>`;

    const statusCls = o.status === 'approved' ? 'bg-emerald-100 text-emerald-800'
      : o.status === 'needs_review' ? 'bg-yellow-100 text-yellow-800'
      : o.status === 'do_not_contact' ? 'bg-red-100 text-red-800'
      : 'bg-zinc-100 text-zinc-600';

    const name = o.url
      ? `<a href="${attr(o.url)}" target="_blank" rel="noopener" class="font-medium text-blue-700 hover:underline">${esc(o.name)}</a>`
      : `<span class="font-medium">${esc(o.name)}</span>`;

    return `<tr class="border-b border-zinc-100 hover:bg-zinc-50">
      <td class="py-2 pr-3 text-sm">${name}</td>
      <td class="py-2 pr-3 text-xs text-zinc-600">${esc(o.type || '—')}</td>
      <td class="py-2 pr-3 text-xs font-mono font-semibold">${esc(o.priority || '—')}</td>
      <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium ${aiInfo.cls}">${esc(aiInfo.label)}</span></td>
      <td class="py-2 pr-3">${contact}</td>
      <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium ${statusCls}">${esc(o.status || '—')}</span></td>
      <td class="py-2 text-xs text-zinc-500 text-right">${o.fit_score != null ? o.fit_score : '—'}</td>
    </tr>`;
  }).join('');

  const filterBar = `<form method="GET" action="/marketing/outlets" class="flex flex-wrap gap-2 items-end">
    <input name="q" value="${attr(req.query.q || '')}" placeholder="Search name…" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm w-48">
    <select name="status" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm">
      <option value="">All statuses</option>
      ${['approved','needs_review','rejected','do_not_contact'].map(s => `<option value="${s}"${req.query.status === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select>
    <select name="priority" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm">
      <option value="">All priorities</option>
      ${['P0','P1','P2','P3'].map(p => `<option value="${p}"${req.query.priority === p ? ' selected' : ''}>${p}</option>`).join('')}
    </select>
    <select name="type" class="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm">
      <option value="">All types</option>
      ${['playlist','podcast','publication','educator','parent_creator','radio','blog'].map(t => `<option value="${t}"${req.query.type === t ? ' selected' : ''}>${t}</option>`).join('')}
    </select>
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
            <th class="py-2 pr-3">AI Policy</th>
            <th class="py-2 pr-3">Contact</th>
            <th class="py-2 pr-3">Status</th>
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
          <p class="text-sm text-zinc-500 mt-1">${outlets.length} outlet(s) · <a href="/marketing" class="text-blue-600 hover:underline">← Marketing</a></p>
        </div>
      </div>
      ${filterBar}
    </section>
    <section class="bg-white border border-zinc-200 rounded-2xl p-6">${table}</section>
  </main>`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderMarketingLayout('Outlets', body));
}
