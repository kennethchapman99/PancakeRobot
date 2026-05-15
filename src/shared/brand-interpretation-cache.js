/**
 * Brand-interpretation cache.
 *
 * Album batch generation reuses the same brand interpretation across every
 * track in a batch so that the expensive brand "read" only happens once per
 * batch (or once per cache window across batches for the same brand+revision).
 *
 * The cache key combines the brand profile id with a short signature of the
 * brand profile contents that affect songwriting/style, so editing the brand
 * profile naturally invalidates stale interpretations.
 */

import { createHash } from 'crypto';

const CACHE = new Map();
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24; // 24h

export function makeBrandInterpretationSignature(brandProfile = {}) {
  const subset = {
    brand_name: brandProfile.brand_name,
    character: brandProfile.character,
    music: brandProfile.music,
    songwriting: brandProfile.songwriting,
    audience: brandProfile.audience,
    lyrics: brandProfile.lyrics,
  };
  return createHash('sha1').update(JSON.stringify(subset)).digest('hex').slice(0, 12);
}

export function getCachedBrandInterpretation(brandId, signature, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const key = `${brandId}::${signature}`;
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (now - entry.storedAt > ttlMs) {
    CACHE.delete(key);
    return null;
  }
  return entry.value;
}

export function setCachedBrandInterpretation(brandId, signature, value, { now = Date.now() } = {}) {
  const key = `${brandId}::${signature}`;
  CACHE.set(key, { storedAt: now, value });
  return value;
}

export function clearBrandInterpretationCache() {
  CACHE.clear();
}
