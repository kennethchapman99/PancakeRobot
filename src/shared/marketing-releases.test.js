import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const nodeBin = process.execPath;

test('marketing release entries stay scoped to the requested brand and can include draft songs for art builds', async () => {
  const slug = `marketing-releases-${Date.now()}`;
  const dbPath = path.join(repoRoot, `${slug}.db`);
  const env = { ...process.env, PIPELINE_APP_SLUG: slug };

  try {
    const output = execFileSync(nodeBin, [
      '--input-type=module',
      '-e',
      `
        const { upsertSong } = await import('./src/shared/db.js');
        const { getMarketingReleaseEntries } = await import('./src/shared/marketing-releases.js');
        upsertSong({ id: 'SONG_DEFAULT_BUTTER', title: 'Butter Beats', status: 'submitted to DistroKid', brand_profile_id: 'default' });
        upsertSong({ id: 'SONG_GRAVL_DRAFT', title: 'Gravl Draft', status: 'draft', brand_profile_id: 'gravl-brand-profile' });
        upsertSong({ id: 'SONG_GRAVL_RELEASE', title: 'Gravl Release', status: 'submitted to DistroKid', brand_profile_id: 'gravl-brand-profile' });
        const gravlAll = getMarketingReleaseEntries({ limit: 50, brand_profile_id: 'gravl-brand-profile', releaseOnly: false }).map(entry => entry.song.id).sort();
        const gravlReleaseReady = getMarketingReleaseEntries({ limit: 50, brand_profile_id: 'gravl-brand-profile', releaseOnly: true }).map(entry => entry.song.id);
        process.stdout.write(JSON.stringify({ gravlAll, gravlReleaseReady }));
      `,
    ], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    const parsed = JSON.parse(output);
    assert.deepEqual(parsed.gravlAll, ['SONG_GRAVL_DRAFT', 'SONG_GRAVL_RELEASE']);
    assert.deepEqual(parsed.gravlReleaseReady, ['SONG_GRAVL_RELEASE']);
  } finally {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
    try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
  }
});
