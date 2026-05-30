const LOCAL_DEFAULT_PUBLIC_BASE_URL = 'http://localhost:3737';

export function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

// Local-only mode is requested with PANCAKE_DISABLE_NGROK=true (the same flag the
// dev stack uses to skip the tunnel). In this mode every Pancake URL must stay on
// localhost: no ngrok/public tunnel URL may leak into a recorder tab, callback, or
// stored workflow package.
export function isLocalOnlyMode(env = process.env) {
  const raw = String(env.PANCAKE_DISABLE_NGROK || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export function containsNgrok(value) {
  return /ngrok/i.test(String(value || ''));
}

// Guard for the local-only contract: if local-only mode is active and a URL still
// points at ngrok (e.g. a stale value persisted from an earlier tunnelled session),
// fail fast with an operator-readable message instead of opening a dead tunnel tab.
export function assertNoNgrokInLocalOnly(value, label = 'URL', env = process.env) {
  if (isLocalOnlyMode(env) && containsNgrok(value)) {
    throw new Error(
      `Local-only mode (PANCAKE_DISABLE_NGROK=true) but ${label} still points at ngrok: ${value}. ` +
      'Clear the stale ngrok URL (NGROK_URL / PUBLIC_BASE_URL or the persisted package) and retry.',
    );
  }
  return value;
}

export function getPublicBaseUrl(options = {}) {
  const env = options.env || process.env;
  const allowLocalFallback = options.allowLocalFallback !== false;
  const localOnly = isLocalOnlyMode(env);

  // In local-only mode we never consult the ngrok-specific vars, and we ignore any
  // configured public URL that itself points at ngrok.
  const candidates = localOnly
    ? [env.PUBLIC_APP_BASE_URL, env.PUBLIC_BASE_URL, env.TELEGRAM_PUBLIC_BASE_URL]
    : [env.PUBLIC_APP_BASE_URL, env.PUBLIC_BASE_URL, env.TELEGRAM_PUBLIC_BASE_URL, env.NGROK_URL, env.NGROK_PUBLIC_URL];

  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized) continue;
    if (localOnly && containsNgrok(normalized)) continue;
    return normalized;
  }
  return allowLocalFallback ? LOCAL_DEFAULT_PUBLIC_BASE_URL : '';
}

// The always-local base URL for the running Pancake web server. Use this for URLs
// that are only ever consumed on this machine — e.g. the Browsy recording bridge:
// the recorder browser and the local Browsy server both reach Pancake at localhost,
// so a public/ngrok tunnel is never needed (and a stale tunnel just opens a dead
// tab / unreachable callback). This is independent of PANCAKE_DISABLE_NGROK so
// recording stays localhost even while ngrok is enabled for other features.
export function getLocalAppBaseUrl(env = process.env) {
  const port = String(env.WEB_PORT || '').trim() || '3737';
  return `http://localhost:${port}`;
}

export function isLocalPublicBaseUrl(value = getPublicBaseUrl()) {
  const normalized = normalizeBaseUrl(value).toLowerCase();
  return (
    normalized.startsWith('http://localhost') ||
    normalized.startsWith('https://localhost') ||
    normalized.startsWith('http://127.0.0.1') ||
    normalized.startsWith('https://127.0.0.1')
  );
}

export function normalizePublicPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '/';
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function buildPublicUrl(pathOrUrl, options = {}) {
  const normalizedPath = normalizePublicPath(pathOrUrl);
  if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;

  const baseUrl = getPublicBaseUrl(options);
  if (!baseUrl) return normalizedPath;
  return `${baseUrl}${normalizedPath}`;
}
