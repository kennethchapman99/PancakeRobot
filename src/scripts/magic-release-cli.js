#!/usr/bin/env node

import {
  createMagicReleaseCampaign,
  getMagicReleaseState,
  ingestBrowsyResult,
  refreshMagicReleasePlan,
  runNextMagicReleaseTask,
} from '../shared/magic-release.js';
import { importVisualLibraryAsset, recommendVisualAssets } from '../shared/visual-library.js';

const [, , command = '', ...rest] = process.argv;

try {
  const args = parseArgs(rest);

  switch (command) {
    case 'create':
      print(createMagicReleaseCampaign({ releaseType: args.type, releaseId: args.id }));
      break;
    case 'plan':
      print(refreshMagicReleasePlan({ releaseType: args.type, releaseId: args.id }));
      break;
    case 'run-next':
      print(await runNextMagicReleaseTask({ releaseType: args.type, releaseId: args.id, dryRun: args.dryRun !== false }));
      break;
    case 'browsy-package':
    case 'browsy-run':
      print(await runNextMagicReleaseTask({ releaseType: args.type, releaseId: args.id, dryRun: args.dryRun !== false }));
      break;
    case 'ingest-result':
      print(await ingestBrowsyResult({ resultPath: args.result }));
      break;
    case 'status':
      print(getMagicReleaseState(args.type, args.id));
      break;
    case 'visual-import':
      print(importVisualLibraryAsset({ sourcePath: args.path, tags: args.tags || '' }));
      break;
    case 'visual-recommend':
      print(recommendVisualAssets({ releaseType: args.type, releaseId: args.id, songId: args.songId || null }));
      break;
    default:
      throw new Error(`Unknown magic release command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--type') args.type = next;
    if (token === '--id') args.id = next;
    if (token === '--song-id') args.songId = next;
    if (token === '--result') args.result = next;
    if (token === '--path') args.path = next;
    if (token === '--tags') args.tags = next;
    if (token === '--dry-run') args.dryRun = true;
    if (token === '--live') args.dryRun = false;
  }
  return args;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
