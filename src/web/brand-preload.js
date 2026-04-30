import { createRequire } from 'module';
import { listBrandProfiles, setActiveBrandProfile, resolveActiveBrandProfilePath } from '../shared/brand-profile-switcher.js';
import { clearBrandProfileCache, loadBrandProfile } from '../shared/brand-profile.js';

const require = createRequire(import.meta.url);
const express = require('express');
const originalHandle = express.application.handle;

express.application.handle = function brandPickerHandle(req, res, done) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (pathname === '/brand' || pathname.startsWith('/brand/')) {
    routeBrand(req, res).catch((error) => {
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(error.stack || error.message);
    });
    return;
  }
  return originalHandle.call(this, req, res, done);
};

async function routeBrand(req, res) {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  if (pathname === '/brand' && req.method === 'GET') {
    return sendHtml(res, renderBrandPicker({
      message: url.searchParams.get('message') || '',
      error: url.searchParams.get('error') || '',
    }));
  }

  if (pathname === '/brand/select' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      setActiveBrandProfile(body.profile_path || '');
      clearBrandProfileCache();
      const active = loadBrandProfile();
      return redirect(res, `/brand?message=${encodeURIComponent(`Active brand set to ${active.brand_name}`)}`);
    } catch (error) {
      return redirect(res, `/brand?error=${encodeURIComponent(error.message)}`);
    }
  }

  res.statusCode = 404;
  return sendHtml(res, shell('Brand', '<main class="p-8">Brand route not found.</main>'));
}

function renderBrandPicker({ message = '', error = '' } = {}) {
  const activeSelection = resolveActiveBrandProfilePath();
  const activeProfile = safeLoadActiveProfile();
  const profiles = listBrandProfiles();

  const body = `
    <main class="p-8 space-y-8">
      <section class="bg-white border border-zinc-200 rounded-2xl p-6">
        <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5">
          <div>
            <div class="text-xs uppercase tracking-widest text-amber-600 font-semibold">Brand profile</div>
            <h1 class="text-3xl font-extrabold mt-1">Brand Switcher</h1>
            <p class="text-zinc-500 mt-2 max-w-3xl">Pick the active brand profile from JSON files in <code class="bg-zinc-100 px-1.5 py-0.5 rounded">config/</code> or its subfolders. Future pipeline and marketing runs read from the active profile.</p>
          </div>
          <div class="rounded-xl bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm text-zinc-600 min-w-72">
            <div class="font-semibold text-zinc-900">Current source</div>
            <div class="mt-1">${esc(activeSelection.source)}</div>
            <div class="mt-2 font-mono text-xs break-all">${esc(activeSelection.relativePath || activeSelection.profilePath || '')}</div>
          </div>
        </div>
      </section>

      ${message ? banner(message, 'emerald') : ''}
      ${error ? banner(error, 'red') : ''}

      <section class="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div class="xl:col-span-2 bg-white border border-zinc-200 rounded-2xl p-6">
          <h2 class="font-bold text-zinc-900 mb-4">Available brand profiles</h2>
          ${profiles.length ? profiles.map(renderProfileCard).join('') : '<div class="border border-dashed rounded-xl p-8 text-center text-zinc-500">No *brand.json files found under config/.</div>'}
        </div>

        <aside class="space-y-6">
          <div class="bg-white border border-zinc-200 rounded-2xl p-6">
            <h2 class="font-bold text-zinc-900">Active brand preview</h2>
            ${renderActivePreview(activeProfile)}
          </div>

          <div class="bg-white border border-zinc-200 rounded-2xl p-6">
            <h2 class="font-bold text-zinc-900">Discovery rule</h2>
            <p class="text-sm text-zinc-500 mt-2">The picker includes any JSON file whose filename ends with <code class="bg-zinc-100 px-1.5 py-0.5 rounded">brand.json</code>, plus the existing <code class="bg-zinc-100 px-1.5 py-0.5 rounded">brand-profile.json</code>.</p>
            <p class="text-sm text-zinc-500 mt-3">The selected profile is persisted to <code class="bg-zinc-100 px-1.5 py-0.5 rounded">config/active-brand-profile.json</code>.</p>
          </div>
        </aside>
      </section>
    </main>
  `;

  return shell('Brand', body);
}

function renderProfileCard(profile) {
  const isActive = profile.active;
  return `
    <div class="rounded-xl border ${isActive ? 'border-emerald-300 bg-emerald-50' : 'border-zinc-200 bg-white'} p-4 mb-3">
      <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-semibold text-zinc-900">${esc(profile.brand_name)}</h3>
            ${isActive ? '<span class="badge badge-ok">active</span>' : ''}
            ${profile.valid ? '<span class="badge badge-ok">valid JSON</span>' : '<span class="badge badge-bad">invalid JSON</span>'}
          </div>
          <div class="text-xs text-zinc-400 font-mono mt-1 break-all">${esc(profile.relative_path)}</div>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-2 mt-3 text-sm text-zinc-600">
            ${profile.default_artist ? `<div><span class="text-zinc-400">Artist:</span> ${esc(profile.default_artist)}</div>` : ''}
            ${profile.primary_genre ? `<div><span class="text-zinc-400">Genre:</span> ${esc(profile.primary_genre)}</div>` : ''}
            ${profile.audience ? `<div><span class="text-zinc-400">Audience:</span> ${esc(profile.audience)}</div>` : ''}
            ${profile.brand_type ? `<div><span class="text-zinc-400">Type:</span> ${esc(profile.brand_type)}</div>` : ''}
          </div>
          ${profile.brand_description ? `<p class="text-sm text-zinc-500 mt-3">${esc(profile.brand_description)}</p>` : ''}
          ${profile.error ? `<p class="text-sm text-red-600 mt-3">${esc(profile.error)}</p>` : ''}
        </div>
        <form method="POST" action="/brand/select" class="shrink-0">
          <input type="hidden" name="profile_path" value="${attr(profile.relative_path)}">
          <button ${!profile.valid || isActive ? 'disabled' : ''} class="px-4 py-2 rounded-lg text-sm font-semibold ${!profile.valid || isActive ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed' : 'bg-zinc-900 text-white hover:bg-zinc-700'}">${isActive ? 'Selected' : 'Use this brand'}</button>
        </form>
      </div>
    </div>
  `;
}

function renderActivePreview(profile) {
  if (!profile) return '<div class="text-sm text-red-600 mt-3">Active profile could not be loaded.</div>';
  return `
    <div class="mt-4 space-y-3 text-sm">
      <div><span class="text-zinc-400">Brand:</span> <span class="font-semibold text-zinc-900">${esc(profile.brand_name)}</span></div>
      <div><span class="text-zinc-400">Artist:</span> ${esc(profile.distribution?.default_artist || '')}</div>
      <div><span class="text-zinc-400">Genre:</span> ${esc(profile.distribution?.primary_genre || '')}</div>
      <div><span class="text-zinc-400">Audience:</span> ${esc(profile.audience?.description || '')}</div>
      <div><span class="text-zinc-400">Music:</span> ${esc(profile.music?.default_style || '')}</div>
      <div><span class="text-zinc-400">Profile:</span> <span class="font-mono text-xs break-all">${esc(profile.__profile_relative_path || '')}</span></div>
    </div>
  `;
}

function safeLoadActiveProfile() {
  try {
    clearBrandProfileCache();
    return loadBrandProfile();
  } catch {
    return null;
  }
}

function banner(text, color) {
  return `<div class="rounded-xl border border-${color}-200 bg-${color}-50 px-4 py-3 text-sm text-${color}-800">${esc(text)}</div>`;
}

function shell(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Pancake Robot</title><link rel="icon" href="/logo.png"><script src="https://cdn.tailwindcss.com"></script><style>.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:.75rem;font-weight:500}.badge-ok{background:#d1fae5;color:#047857}.badge-warn{background:#fef3c7;color:#b45309}.badge-bad{background:#fee2e2;color:#b91c1c}</style></head><body class="bg-zinc-50 text-zinc-900"><div class="flex min-h-screen"><nav class="w-56 bg-zinc-900 text-zinc-100 p-4"><img src="/logo.png" class="w-32 h-32 object-contain mx-auto"><div class="mt-5 space-y-1"><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/">Dashboard</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas/generate">Generate Ideas</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas">Idea Vault</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/songs">Song Catalog</a><a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/marketing">Marketing</a><a class="block rounded-lg px-3 py-2 bg-zinc-700 text-white" href="/brand">Brand</a></div></nav><div class="flex-1">${body}</div></div></body></html>`;
}

async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] || '').includes('json')) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function sendHtml(res, content) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(content);
}

function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('location', location);
  res.end();
}

function esc(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#39;');
}

function attr(value) {
  return esc(value);
}
