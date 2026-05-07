const PACK_IDLE_CLASS = 'mt-3 hidden rounded-lg border px-3 py-3 text-sm font-medium shadow-sm';
const activePackBuilds = new Set();

function packStatusClasses(tone) {
  return {
    info: 'mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-sm font-medium text-blue-700 shadow-sm',
    success: 'mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-medium text-emerald-700 shadow-sm',
    error: 'mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm font-medium text-red-700 shadow-sm',
  }[tone] || PACK_IDLE_CLASS;
}

function baseImageStatusClasses(tone) {
  return {
    info: 'mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700',
    success: 'mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700',
    error: 'mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700',
  }[tone] || 'mt-3 hidden rounded-lg border px-3 py-2 text-xs font-medium';
}

function responseContentType(response) {
  return String(response?.headers?.get?.('content-type') || '').toLowerCase();
}

async function parseJsonResponse(response, { actionLabel }) {
  const contentType = responseContentType(response);
  const rawText = await response.text();

  if (contentType.includes('text/html')) {
    throw new Error(`Expected JSON but got HTML/redirect (${response.status})`);
  }

  let parsed = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`${actionLabel} failed with status ${response.status}: ${rawText}`);
    }
  }

  if (!response.ok) {
    const bodyText = rawText || JSON.stringify(parsed || {});
    throw new Error(`${actionLabel} failed with status ${response.status}: ${bodyText}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Expected JSON but got empty response (${response.status})`);
  }

  return parsed;
}

function setPackButtonsDisabled(songId, disabled) {
  document.querySelectorAll(`button[data-song-id="${songId}"][data-release-assets-build]`).forEach(button => {
    button.disabled = !!disabled;
  });
}

function setPackTriggerState(songId, running) {
  const idle = document.getElementById(`pack-trigger-idle-${songId}`);
  const active = document.getElementById(`pack-trigger-running-${songId}`);
  if (idle) idle.style.display = running ? 'none' : '';
  if (active) active.style.display = running ? '' : 'none';
}

function setPackStatus(songId, tone, message) {
  const panel = document.getElementById(`pack-status-${songId}`);
  if (!panel) return;
  if (!message) {
    panel.className = PACK_IDLE_CLASS;
    panel.textContent = '';
    return;
  }
  panel.className = packStatusClasses(tone);
  panel.textContent = message;
}

function setBaseImageStatus(songId, tone, message) {
  const panel = document.getElementById(`base-image-status-${songId}`);
  if (!panel) return;
  if (!message) {
    panel.className = 'mt-3 hidden rounded-lg border px-3 py-2 text-xs font-medium';
    panel.textContent = '';
    return;
  }
  panel.className = baseImageStatusClasses(tone);
  panel.textContent = message;
}

function setClearBaseImageState(songId, running) {
  const button = document.getElementById(`clear-base-image-button-${songId}`);
  const label = document.getElementById(`clear-base-image-label-${songId}`);
  if (button) button.disabled = !!running;
  if (label) label.textContent = running ? 'Clearing…' : 'Clear Base Image';
}

function updatePackTerminal(songId, patch = {}) {
  const terminal = document.getElementById(`pack-terminal-${songId}`);
  const log = document.getElementById(`pack-log-${songId}`);
  const footer = document.getElementById(`pack-footer-${songId}`);
  const badge = document.getElementById(`pack-badge-${songId}`);
  if (terminal && patch.visible !== undefined) terminal.style.display = patch.visible ? '' : 'none';
  if (patch.clearLog && log) log.innerHTML = '';
  if (patch.appendLog && log) {
    const div = document.createElement('div');
    div.className = `leading-relaxed whitespace-pre-wrap break-words ${patch.logClass || 'text-zinc-300'}`;
    div.textContent = patch.appendLog;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  if (footer && Object.prototype.hasOwnProperty.call(patch, 'footer')) footer.textContent = patch.footer || '';
  if (badge && Object.prototype.hasOwnProperty.call(patch, 'badgeHtml')) badge.innerHTML = patch.badgeHtml || '';
  if (terminal && patch.scroll !== false && terminal.scrollIntoView) {
    terminal.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function reloadSongMarketingPane(songId, generatedAt) {
  const section = document.getElementById('release-kit-actions');
  const baseUrl = section?.dataset?.reloadUrl || `${window.location.pathname}?tab=marketing#release-kit-actions`;
  const [withoutHash, hash = ''] = baseUrl.split('#');
  const joiner = withoutHash.includes('?') ? '&' : '?';
  const refreshedAt = encodeURIComponent(generatedAt || Date.now().toString());
  window.location.assign(`${withoutHash}${joiner}releaseAssetsRefreshed=${refreshedAt}${hash ? `#${hash}` : ''}`);
}

function buildPackPayload(songId, formats = []) {
  const mode = document.getElementById(`pack-mode-${songId}`)?.value || 'render_from_existing_visuals';
  const regenerateBaseArt = document.getElementById(`pack-regen-${songId}`)?.checked || false;
  const noVideos = document.getElementById(`pack-novideos-${songId}`)?.checked || false;
  return {
    mode,
    useBaseImage: true,
    regenerateBaseArt,
    renderVideos: !noVideos,
    formats,
  };
}

async function runPackBuild(songId, payload, state = null, fetchImpl = fetch) {
  if (activePackBuilds.has(songId)) {
    setPackStatus(songId, 'info', 'Release asset generation is already running.');
    return null;
  }

  activePackBuilds.add(songId);
  setPackTriggerState(songId, true);
  setPackButtonsDisabled(songId, true);
  setPackStatus(songId, 'info', 'Generating release assets…');
  updatePackTerminal(songId, {
    visible: true,
    clearLog: true,
    badgeHtml: '<span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span> Running</span>',
    footer: 'Generating release assets…',
    appendLog: 'Generating release assets…',
  });

  try {
    const response = await fetchImpl(`/api/songs/${songId}/release-assets/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await parseJsonResponse(response, { actionLabel: 'Release asset generation' });
    if (!data.ok) {
      throw new Error(data.error || 'Release asset generation failed.');
    }

    const successMessage = data.qaFailures?.length
      ? 'Release assets generated with QA failures that need review.'
      : 'Release assets generated.';
    if (state) {
      state.packState = data.qaFailures?.length ? 'error' : 'done';
      state.packBadge = data.qaFailures?.length ? '<span class="text-amber-400">⚠ Review</span>' : '<span class="text-emerald-400">✓ Done</span>';
      state.packFooter = successMessage;
    }
    setPackStatus(songId, data.qaFailures?.length ? 'error' : 'success', successMessage);
    updatePackTerminal(songId, {
      visible: true,
      badgeHtml: data.qaFailures?.length ? '<span class="text-amber-400">⚠ Review</span>' : '<span class="text-emerald-400">✓ Done</span>',
      footer: successMessage,
      appendLog: successMessage,
      logClass: data.qaFailures?.length ? 'text-amber-400' : 'text-emerald-400',
      scroll: false,
    });
    setTimeout(() => reloadSongMarketingPane(songId, data.marketingAssets?.generated_at), 800);
    return data;
  } catch (error) {
    if (state) {
      state.packState = 'error';
      state.packBadge = '<span class="text-red-400">✗ Failed</span>';
      state.packFooter = error.message;
    }
    setPackStatus(songId, 'error', error.message);
    updatePackTerminal(songId, {
      visible: true,
      badgeHtml: '<span class="text-red-400">✗ Failed</span>',
      footer: error.message,
      appendLog: `ERROR: ${error.message}`,
      logClass: 'text-red-400',
      scroll: false,
    });
    throw error;
  } finally {
    activePackBuilds.delete(songId);
    setPackTriggerState(songId, false);
    setPackButtonsDisabled(songId, false);
  }
}

function marketingPack(songId, fetchImpl = fetch) {
  return {
    packState: 'idle',
    packFooter: '',
    packBadge: '',
    register() {
      window.__marketingPackInstances = window.__marketingPackInstances || {};
      window.__marketingPackInstances[songId] = this;
    },
    buildPack(id, formats = []) {
      if (this.packState === 'running') return Promise.resolve(null);
      this.packState = 'running';
      this.packFooter = 'Generating release assets…';
      this.packBadge = '<span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span> Running</span>';
      return runPackBuild(id, buildPackPayload(id, formats), this, fetchImpl);
    },
  };
}

function buildPackWithFormats(songId, formats, fetchImpl = fetch) {
  if (window.__marketingPackInstances?.[songId]) {
    return window.__marketingPackInstances[songId].buildPack(songId, formats || []);
  }
  return runPackBuild(songId, buildPackPayload(songId, formats || []), null, fetchImpl);
}

function buildPackAllFormats(songId, formats, fetchImpl = fetch) {
  return buildPackWithFormats(songId, formats || [], fetchImpl);
}

async function uploadBaseImage(songId, input, fetchImpl = fetch) {
  const file = input.files?.[0];
  if (!file) return null;
  const form = new FormData();
  form.append('base_image', file);
  const response = await fetchImpl(`/api/songs/${songId}/base-image`, { method: 'POST', body: form });
  const data = await parseJsonResponse(response, { actionLabel: 'Base image upload' });
  if (!data.ok) throw new Error(data.error || 'Base image upload failed.');
  reloadSongMarketingPane(songId, Date.now().toString());
  return data;
}

async function clearBaseImage(songId, fetchImpl = fetch) {
  if (typeof window.confirm === 'function' && !window.confirm('Remove base image?')) return null;

  setClearBaseImageState(songId, true);
  setBaseImageStatus(songId, 'info', 'Clearing release-specific base image…');
  try {
    const response = await fetchImpl(`/api/songs/${songId}/base-image/clear`, { method: 'POST' });
    const data = await parseJsonResponse(response, { actionLabel: 'Base image clear' });
    if (!data.ok) throw new Error(data.error || 'Base image clear failed.');
    setBaseImageStatus(songId, 'success', data.warning || 'Release-specific base image cleared.');
    setTimeout(() => reloadSongMarketingPane(songId, Date.now().toString()), 800);
    return data;
  } catch (error) {
    setBaseImageStatus(songId, 'error', error.message);
    throw error;
  } finally {
    setClearBaseImageState(songId, false);
  }
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    marketingPack,
    buildPackWithFormats,
    buildPackAllFormats,
    uploadBaseImage,
    clearBaseImage,
  });
}

export {
  clearBaseImage,
  marketingPack,
  buildPackAllFormats,
  buildPackWithFormats,
  parseJsonResponse,
  runPackBuild,
  uploadBaseImage,
};
