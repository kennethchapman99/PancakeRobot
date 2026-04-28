(() => {
  const match = window.location.pathname.match(/^\/songs\/([^/]+)$/);
  if (!match) return;

  const songId = decodeURIComponent(match[1]);
  const metaUrl = `/media/songs/${songId}/audio/generation-meta.json?ts=${Date.now()}`;

  const label = (value) => String(value || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  function statusPill(meta) {
    const tier = meta.render_tier || (String(meta.model || '').includes('free') ? 'free' : 'paid');
    const isPaid = tier === 'paid' || meta.model === 'music-2.6';
    const cls = isPaid
      ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : 'bg-amber-100 text-amber-800 border-amber-200';
    const icon = isPaid ? '💳' : '🧪';
    const labelText = isPaid ? 'Paid MiniMax render' : 'Free MiniMax audition';

    return `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold border ${cls}">${icon} ${labelText}</span>`;
  }

  function qaPill(ok, text) {
    const cls = ok
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-red-50 text-red-700 border-red-200';
    const icon = ok ? '✓' : '⚠';
    return `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border ${cls}">${icon} ${text}</span>`;
  }

  function inject(meta) {
    const audioPanel = [...document.querySelectorAll('div')]
      .find(el => el.textContent?.trim() === 'Audio' && el.className.includes('uppercase'));

    const targetCard = audioPanel?.closest('.bg-zinc-900') || document.querySelector('audio')?.closest('.bg-zinc-900');
    if (!targetCard || document.getElementById('minimax-render-meta')) return;

    const generated = meta.generated_at ? new Date(meta.generated_at).toLocaleString() : 'unknown time';
    const model = meta.model || 'unknown model';
    const tier = meta.render_tier || (String(model).includes('free') ? 'free' : 'paid');

    const box = document.createElement('div');
    box.id = 'minimax-render-meta';
    box.className = 'mt-4 pt-4 border-t border-zinc-800 space-y-2';
    box.innerHTML = `
      <div class="flex flex-wrap gap-2">
        ${statusPill({ ...meta, render_tier: tier })}
        ${qaPill(Boolean(meta.pre_render_qa_passed), 'pre-render QA')}
        ${qaPill(Boolean(meta.post_render_qa_passed), 'audio QA')}
      </div>
      <div class="text-xs text-zinc-400 leading-relaxed">
        Model: <span class="font-mono text-zinc-200">${label(model)}</span><br>
        Tier: <span class="font-mono text-zinc-200">${label(tier)}</span><br>
        Generated: <span class="font-mono text-zinc-300">${label(generated)}</span>
      </div>
    `;
    targetCard.appendChild(box);
  }

  fetch(metaUrl, { cache: 'no-store' })
    .then(res => res.ok ? res.json() : null)
    .then(meta => { if (meta) inject(meta); })
    .catch(() => {});
})();
