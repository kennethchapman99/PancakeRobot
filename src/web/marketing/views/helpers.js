import { esc, attr } from '../utils/http.js';

export function banner(text, kind = 'ok') {
  if (!text) return '';
  const cls = kind === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return `<div class="rounded-xl border ${cls} px-4 py-3 text-sm">${esc(text)}</div>`;
}

export function emptyBox(text) {
  return `<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">${esc(text)}</div>`;
}

export function statCard(label, value) {
  return `<div class="bg-white border border-zinc-200 rounded-xl p-4"><div class="text-2xl font-extrabold">${esc(value || 0)}</div><div class="text-xs text-zinc-500 mt-1">${esc(label)}</div></div>`;
}

export function presetRadio(value, label, checked = false) {
  return `<label class="flex items-center gap-2 text-sm border border-zinc-200 rounded-lg p-3 hover:bg-zinc-50"><input type="radio" name="outlet_preset" value="${attr(value)}" ${checked ? 'checked' : ''}> <span>${esc(label)}</span></label>`;
}

export function modeRadio(value, label, checked = false) {
  return `<label class="flex items-center gap-2 text-sm border border-zinc-200 rounded-lg p-3 hover:bg-zinc-50"><input type="radio" name="mode" value="${attr(value)}" ${checked ? 'checked' : ''}> <span>${esc(label)}</span></label>`;
}

export function pill(text, tone = 'zinc') {
  const tones = {
    green: 'bg-emerald-50 text-emerald-700',
    blue: 'bg-blue-50 text-blue-700',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
    zinc: 'bg-zinc-100 text-zinc-600',
  };
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${tones[tone] || tones.zinc}">${esc(text)}</span>`;
}
