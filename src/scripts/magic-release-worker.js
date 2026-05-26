#!/usr/bin/env node

import { runMagicReleaseWorker } from '../shared/magic-release.js';

const result = await runMagicReleaseWorker({ dryRun: process.argv.includes('--live') ? false : true });
console.log(JSON.stringify(result, null, 2));
