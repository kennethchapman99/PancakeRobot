import fs from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs as nodeParseArgs } from 'util';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const OUTPUT_DIR = join(REPO_ROOT, 'output');
export const RELEASE_PACKAGES_DIR = join(OUTPUT_DIR, 'release-packages');
export const AUTH_DIR = join(REPO_ROOT, '.auth');
export const DISTROKID_AUTH_PATH = join(AUTH_DIR, 'distrokid.json');
export const DISTROKID_CONFIG_DIR = join(REPO_ROOT, 'config', 'distrokid');
export const FIELD_MAP_EXAMPLE_PATH = join(DISTROKID_CONFIG_DIR, 'field-map.example.json');
export const FIELD_MAP_LOCAL_PATH = join(DISTROKID_CONFIG_DIR, 'field-map.local.json');

export const DANGEROUS_BUTTON_NAMES = Object.freeze([
  'Submit',
  'Done',
  'Finalize',
  'Release',
  'Upload to stores',
  'Continue & submit',
  'Continue',
  'Save and submit',
  'Submit release',
  'Send to stores',
]);

export const SAFE_CLICK_TEXTS = Object.freeze([
  'Add credits for each song on this release',
]);

export function parseArgs(options = {}) {
  return nodeParseArgs({ options, strict: false, allowPositionals: true });
}

export function ensureDir(path) {
  fs.mkdirSync(path, { recursive: true });
  return path;
}

export function exists(path) {
  return Boolean(path) && fs.existsSync(path);
}

export function safeReadJson(path, fallback = null) {
  try {
    return exists(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeText(path, value) {
  ensureDir(dirname(path));
  fs.writeFileSync(path, String(value), 'utf8');
}

export function copyFileIfExists(from, to) {
  if (!exists(from)) return false;
  ensureDir(dirname(to));
  fs.copyFileSync(from, to);
  return true;
}

export function relativeToRepo(path) {
  if (!path) return null;
  return relative(REPO_ROOT, path).replace(/\\/g, '/');
}

export function absoluteFromMaybeRelative(path) {
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

export function splitCsv(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

export function getReleasePackageDir(songId) {
  return join(RELEASE_PACKAGES_DIR, songId);
}

export function getDistrokidRunDir(songId) {
  return join(getReleasePackageDir(songId), 'distrokid-run');
}

export function hasDistrokidCookies(storageState) {
  return Array.isArray(storageState?.cookies)
    && storageState.cookies.some(cookie => String(cookie.domain || '').includes('distrokid.com'));
}

export function getCookieDomains(storageState) {
  return [...new Set((storageState?.cookies || []).map(cookie => cookie.domain).filter(Boolean))].sort();
}

export function isDistrokidNonSigninUrl(url) {
  const lower = String(url || '').toLowerCase();
  return lower.includes('distrokid.com') && !lower.includes('/signin') && !lower.includes('/sign-in');
}

export function isDangerousAction(nameOrText, dangerousNames = DANGEROUS_BUTTON_NAMES) {
  const text = normalizeActionText(nameOrText);
  if (!text) return false;
  if (SAFE_CLICK_TEXTS.some(name => text === normalizeActionText(name))) return false;
  if (text === '#donebutton' || text === 'donebutton') return true;
  return dangerousNames.some(name => text === normalizeActionText(name));
}

export function normalizeActionText(value) {
  return String(value || '').trim().toLowerCase().replace(/[^\p{L}\p{N}#&]+/gu, ' ').replace(/\s+/g, ' ');
}

export function makeRunSummary({ ok, message, details = {} }) {
  return {
    ok: Boolean(ok),
    message: message || '',
    details,
    at: new Date().toISOString(),
  };
}
