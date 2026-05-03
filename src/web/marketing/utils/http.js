export async function readBody(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('json')) return JSON.parse(raw);

  const params = new URLSearchParams(raw);
  const body = {};
  for (const [key, value] of params.entries()) {
    if (body[key] === undefined) body[key] = value;
    else if (Array.isArray(body[key])) body[key].push(value);
    else body[key] = [body[key], value];
  }
  return body;
}

export function sendHtml(res, html) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}

export function sendJson(res, payload, status = 200) {
  res.status(status).json(payload);
}

export function redirect(res, location) {
  res.redirect(303, location);
}

export function campaignUrl(campaignId, text, key = 'message') {
  return `/marketing/campaigns/${encodeURIComponent(campaignId)}?${key}=${encodeURIComponent(text)}`;
}

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function attr(value) {
  return esc(value);
}

export function normalizeIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  return [];
}

export function parseBool(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}
