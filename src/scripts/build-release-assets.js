import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { buildSongReleaseAssets } from '../shared/song-release-assets-service.js';

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const songId = getArg('--song-id');
const mode = getArg('--mode') || 'render_from_existing_visuals';
const formatsArg = getArg('--formats');
const formats = formatsArg ? formatsArg.split(',').map(value => value.trim()).filter(Boolean) : null;
const renderVideos = hasFlag('--no-render-videos') ? false : true;
const json = hasFlag('--json');

if (!songId) {
  console.error('Usage: node src/scripts/build-release-assets.js --song-id SONG_ID [options]');
  process.exit(1);
}

try {
  const restoreConsoleLog = json
    ? (() => {
        const original = console.log;
        console.log = (...args) => console.error(...args);
        return () => { console.log = original; };
      })()
    : () => {};
  const result = await buildSongReleaseAssets(songId, {
    mode,
    formats,
    renderVideos,
  });
  restoreConsoleLog();

  const payload = {
    ok: result.ok,
    songId: result.songId,
    dashboardUrl: result.dashboardUrl,
    generatedAssets: result.generatedAssets,
    marketingAssets: result.marketingAssets,
    imageSource: result.imageSource,
    qaWarnings: result.qaWarnings,
    qaFailures: result.qaFailures,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    console.error(`[RELEASE] ${result.ok ? 'success' : 'needs_review'} ${songId}`);
    console.error(`[RELEASE] Dashboard: ${result.dashboardUrl || 'none'}`);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }

  process.exit(result.qaFailures.length ? 2 : 0);
} catch (error) {
  console.error(`[RELEASE] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
