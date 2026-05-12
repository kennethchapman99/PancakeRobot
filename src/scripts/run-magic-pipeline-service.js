import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { runMagicPipelineService } from '../services/magic-pipeline-service.js';
import { DEFAULT_PROFILE_ID } from '../shared/brand-profile.js';

function parseArgs(argv) {
  const idFlagIdx = argv.indexOf('--id');
  const brandFlagIdx = argv.indexOf('--brand');
  const modeFlagIdx = argv.indexOf('--mode');
  const stageFlagIdx = argv.indexOf('--stage');

  const excluded = new Set([
    idFlagIdx,
    idFlagIdx + 1,
    brandFlagIdx,
    brandFlagIdx + 1,
    modeFlagIdx,
    modeFlagIdx + 1,
    stageFlagIdx,
    stageFlagIdx + 1,
  ].filter(index => index >= 0));

  return {
    existingSongId: idFlagIdx !== -1 ? argv[idFlagIdx + 1] : null,
    brandId: brandFlagIdx !== -1 ? argv[brandFlagIdx + 1] : process.env.DEFAULT_BRAND_ID || DEFAULT_PROFILE_ID,
    mode: modeFlagIdx !== -1 ? argv[modeFlagIdx + 1] : process.env.MAGIC_SONG_MODE || 'human_review',
    pipelineStage: stageFlagIdx !== -1 ? argv[stageFlagIdx + 1] : process.env.MAGIC_PIPELINE_STAGE || process.env.MAGIC_SONG_PIPELINE_STAGE || 'song_only',
    topic: argv.filter((_, index) => !excluded.has(index)).join(' ').trim(),
  };
}

const { topic, existingSongId, brandId, mode, pipelineStage } = parseArgs(process.argv.slice(2));

if (!topic) {
  console.error('Usage: npm run magic -- "song topic here"');
  console.error('Optional: npm run magic -- --brand pancake_robot --id SONG_ID --stage full "song topic here"');
  process.exit(1);
}

try {
  const result = await runMagicPipelineService({
    topic,
    existingSongId,
    brandId,
    mode,
    pipelineStage,
  });

  console.log('\nMagic pipeline result:');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exit(1);
}
