import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_ARTIFACT_DIR = path.join(REPO_ROOT, 'test', 'artifacts', 'db');
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');
const DEFAULT_RETENTION_DAYS = 7;
const registeredDbCleanups = new Set();

export function prepareTestDbSlug(prefix, options = {}) {
  const retentionDays = Number.isFinite(Number(options.retentionDays))
    ? Number(options.retentionDays)
    : Number(process.env.TEST_DB_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);

  fs.mkdirSync(TEST_DB_ARTIFACT_DIR, { recursive: true });
  cleanupOldTestDbArtifacts({ retentionDays });

  const slug = createTestDbSlug(prefix);
  if (options.cleanupOnExit !== false) {
    registerTestDbCleanupOnExit(slug);
  }

  return {
    slug,
    artifactDir: TEST_DB_ARTIFACT_DIR,
  };
}

export function createTestDbSlug(prefix) {
  const safePrefix = String(prefix || 'test-db')
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'test-db';
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // db.js resolves PIPELINE_APP_SLUG relative to repo root and appends `.db`.
  // Keep generated test databases contained under test/artifacts/db/.
  return path.posix.join('test', 'artifacts', 'db', `${safePrefix}-${suffix}`);
}

export function cleanupOldTestDbArtifacts(options = {}) {
  const retentionDays = Number.isFinite(Number(options.retentionDays))
    ? Number(options.retentionDays)
    : DEFAULT_RETENTION_DAYS;

  if (retentionDays <= 0) return { deleted: 0 };
  if (!fs.existsSync(TEST_DB_ARTIFACT_DIR)) return { deleted: 0 };

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const entry of fs.readdirSync(TEST_DB_ARTIFACT_DIR)) {
    if (!/\.db(?:-(?:shm|wal))?$/.test(entry)) continue;

    const filePath = path.join(TEST_DB_ARTIFACT_DIR, entry);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs >= cutoffMs) continue;

    fs.rmSync(filePath, { force: true });
    deleted += 1;
  }

  return { deleted };
}

export function cleanupTestDbArtifacts(options = {}) {
  const slug = options.slug || options.dbSlug || '';
  const dbPath = options.dbPath || (slug ? path.resolve(REPO_ROOT, `${slug}.db`) : '');
  if (!dbPath) return { deleted: 0 };

  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  let deleted = 0;

  for (const target of targets) {
    const resolved = path.resolve(target);
    const allowedRoot = path.resolve(TEST_DB_ARTIFACT_DIR);
    if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) continue;
    if (!fs.existsSync(resolved)) continue;

    fs.rmSync(resolved, { force: true });
    deleted += 1;
  }

  return { deleted };
}

function registerTestDbCleanupOnExit(slug) {
  if (!slug || registeredDbCleanups.has(slug)) return;
  registeredDbCleanups.add(slug);

  process.once('exit', () => {
    cleanupTestDbArtifacts({ slug });
  });
}

export function getTestDbArtifactDir() {
  return TEST_DB_ARTIFACT_DIR;
}

export function cleanupTestOutputArtifacts(options = {}) {
  const songIds = normalizeIdList(options.songIds || options.songs);
  const albumIds = normalizeIdList(options.albumIds || options.albums);
  const marketingIds = normalizeIdList(options.marketingIds || options.marketing);
  const packageIds = normalizeIdList(options.packageIds || options.packages);
  let deleted = 0;

  for (const songId of songIds) {
    deleted += removeOutputDir('songs', songId);
    deleted += removeOutputDir('distribution-ready', songId);
    deleted += removeOutputDir('marketing-ready', songId);
    deleted += removeOutputDir('release-packages', songId);
  }
  for (const albumId of albumIds) {
    deleted += removeOutputDir('albums', albumId);
  }
  for (const marketingId of marketingIds) {
    deleted += removeOutputDir('marketing-ready', marketingId);
  }
  for (const packageId of packageIds) {
    deleted += removeOutputDir('release-packages', packageId);
    deleted += removeOutputDir('release-workflows', packageId);
  }

  return { deleted };
}

function normalizeIdList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function removeOutputDir(namespace, id) {
  const target = path.join(OUTPUT_DIR, namespace, id);
  const resolved = path.resolve(target);
  const allowedRoot = path.resolve(OUTPUT_DIR, namespace);
  if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) return 0;
  if (!fs.existsSync(resolved)) return 0;

  fs.rmSync(resolved, { recursive: true, force: true });
  return 1;
}
