import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { runMagicReleaseStageService } from '../services/magic-release-stage-service.js';
import { DEFAULT_PROFILE_ID } from '../shared/brand-profile.js';

function parseArgs(argv) {
  const idFlagIdx = argv.indexOf('--id');
  const brandFlagIdx = argv.indexOf('--brand');
  const platformsFlagIdx = argv.indexOf('--platforms');
  const noSocialIdx = argv.indexOf('--no-social');
  const noYoutubeVideoIdx = argv.indexOf('--no-youtube-video');

  return {
    songId: idFlagIdx !== -1 ? argv[idFlagIdx + 1] : '',
    brandId: brandFlagIdx !== -1 ? argv[brandFlagIdx + 1] : process.env.DEFAULT_BRAND_ID || DEFAULT_PROFILE_ID,
    platforms: platformsFlagIdx !== -1 ? argv[platformsFlagIdx + 1] : null,
    buildSocialCampaign: noSocialIdx === -1,
    renderYouTubeVideo: noYoutubeVideoIdx === -1,
  };
}

const { songId, brandId, platforms, buildSocialCampaign, renderYouTubeVideo } = parseArgs(process.argv.slice(2));

if (!songId) {
  console.error('Usage: npm run release-stage -- --id SONG_ID');
  console.error('Optional: npm run release-stage -- --id SONG_ID --platforms youtube,instagram,facebook');
  console.error('Optional: npm run release-stage -- --id SONG_ID --no-social');
  process.exit(1);
}

try {
  const result = await runMagicReleaseStageService({
    songId,
    brandId,
    platforms,
    buildSocialCampaign,
    renderYouTubeVideo,
  });

  console.log('\nRelease stage result:');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exit(1);
}
