import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const TEST_DB_ARTIFACT_DIR = path.join(REPO_ROOT, 'test', 'artifacts', 'db');
const DEFAULT_RETENTION_DAYS = 7;

export function prepareTestDbSlug(prefix, options = {}) {
  const retentionDays = Number.isFinite(Number(options.retentionDays))
    ? Number(options.retentionDays)
    : Number(process.env.TEST_DB_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);

  fs.mkdirSync(TEST_DB_ARTIFACT_DIR, { recursive: true });
  cleanupOldTestDbArtifacts({ retentionDays });

  return {
    slug: createTestDbSlug(prefix),
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

export function getTestDbArtifactDir() {
  return TEST_DB_ARTIFACT_DIR;
}
