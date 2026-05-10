const LOCAL_DEFAULT_PUBLIC_BASE_URL = 'http://localhost:3737';

export function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export function getPublicBaseUrl(options = {}) {
  const allowLocalFallback = options.allowLocalFallback !== false;
  const configured = normalizeBaseUrl(
    process.env.PUBLIC_APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.TELEGRAM_PUBLIC_BASE_URL ||
    process.env.NGROK_URL ||
    process.env.NGROK_PUBLIC_URL
  );
  if (configured) return configured;
  return allowLocalFallback ? LOCAL_DEFAULT_PUBLIC_BASE_URL : '';
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
