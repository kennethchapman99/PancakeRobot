#!/usr/bin/env node

const REQUIRED_NODE = '22.22.2';
const REQUIRED_MAJOR = '22';
const EXPECTED_NODE_MODULE_VERSION = '127';
const actualNode = process.versions.node;
const actualMajor = actualNode.split('.')[0];
const actualModuleVersion = process.versions.modules;
const allowMismatch = process.env.PANCAKE_ALLOW_NODE_MISMATCH === '1';

if (!allowMismatch && actualNode !== REQUIRED_NODE) {
  console.error(`\n[Pancake Robot] Wrong Node.js version.`);
  console.error(`  Required: v${REQUIRED_NODE}`);
  console.error(`  Current:  v${actualNode}`);
  console.error(`  Node ABI: ${actualModuleVersion}`);
  console.error(`\nRun one of these from the repo root:`);
  console.error(`  ./scripts/pancake.sh web`);
  console.error(`  volta install node@${REQUIRED_NODE} && volta pin node@${REQUIRED_NODE}`);
  console.error(`\nThen rebuild native modules:`);
  console.error(`  npm rebuild better-sqlite3 canvas`);
  console.error('');
  process.exit(1);
}

if (!allowMismatch && actualMajor !== REQUIRED_MAJOR) {
  console.error(`[Pancake Robot] Node major must be ${REQUIRED_MAJOR}; got ${actualMajor}.`);
  process.exit(1);
}

if (!allowMismatch && actualModuleVersion !== EXPECTED_NODE_MODULE_VERSION) {
  console.error(`[Pancake Robot] Node native module ABI must be ${EXPECTED_NODE_MODULE_VERSION}; got ${actualModuleVersion}.`);
  console.error('Run: npm rebuild better-sqlite3 canvas');
  process.exit(1);
}

console.log(`[Pancake Robot] Node runtime OK: v${actualNode} / ABI ${actualModuleVersion}`);
