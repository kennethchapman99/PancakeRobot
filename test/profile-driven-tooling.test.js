import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('runtime config is generic and brandless', () => {
  const runtimePath = path.join(repoRoot, 'music-pipeline.config.json');
  assert.equal(fs.existsSync(runtimePath), true);
  assert.equal(fs.existsSync(path.join(repoRoot, 'pancake-robot.config.json')), false);

  const config = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  assert.equal(Object.hasOwn(config, 'brand'), false);
  assert.deepEqual(config.agents, {});
  assert.equal(config.distribution, null);
});

test('active tooling does not read generated brand config or legacy env names', () => {
  const files = [
    'src/shared/suggest.js',
    'src/shared/managed-agent.js',
    'src/shared/song-qa.js',
    'src/web/render-mode-preload.js',
    'src/web/server.js',
    'src/orchestrator.js',
    'src/agents/brand-manager.js',
    'src/agents/lyricist.js',
    'src/agents/product-manager.js',
    'src/agents/ops-manager.js',
    'src/marketing/simple-renderer.js',
  ];
  const source = files.map(read).join('\n');

  for (const forbidden of [
    'config.brand',
    'brandData',
    'themed-idea-generation',
    'PANCAKE_RENDER_MODE',
    'PANCAKE_ALLOW_SHORT_SONGS',
    'pancake-robot.config',
    'pancake-robot.db',
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} should not appear in active tooling`);
  }
});

test('managed agents are recreated when profile-driven definitions change', () => {
  const source = read('src/shared/managed-agent.js');

  assert.equal(source.includes('definition_hash'), true);
  assert.equal(source.includes('hashAgentDefinition'), true);
  assert.equal(source.includes("const APP_SLUG = process.env.PIPELINE_APP_SLUG || 'music-pipeline'"), true);
});
