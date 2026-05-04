import { esc } from '../utils/http.js';
import { loadBrandProfile } from '../../../shared/brand-profile.js';

export function renderMarketingLayout(title, body) {
  const brand = loadBrandProfile();
  const appTitle = brand.app_title || brand.brand_name || 'Music Pipeline';
  const logoPath = brand.ui?.logo_path || '/logo.png';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — ${esc(appTitle)}</title>
  <link rel="icon" href="${esc(logoPath)}">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-50 text-zinc-900">
  <div class="flex min-h-screen">
    <nav class="w-56 bg-zinc-900 text-zinc-100 p-4">
      <img src="${esc(logoPath)}" class="w-32 h-32 object-contain mx-auto">
      <div class="mt-5 space-y-1">
        <a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/">Dashboard</a>
        <a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas/generate">Generate Ideas</a>
        <a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/ideas">Idea Vault</a>
        <a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/songs">Song Catalog</a>
        <a class="block rounded-lg px-3 py-2 bg-zinc-700 text-white" href="/marketing">Marketing</a>
        <a class="block rounded-lg px-3 py-2 pl-6 text-zinc-400 hover:bg-zinc-800 text-xs" href="/marketing/outlets">↳ Outlets</a>
        <a class="block rounded-lg px-3 py-2 text-zinc-300 hover:bg-zinc-800" href="/brand">Brand</a>
      </div>
    </nav>
    <div class="flex-1">${body}</div>
  </div>
</body>
</html>`;
}
