import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PROFILE_ID,
  listBrandProfiles,
  loadBrandProfileById,
  resolveBrandProfilePath,
} from '../src/shared/brand-profile.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('default brand profile is Pancake Robot', () => {
  const profile = loadBrandProfileById(DEFAULT_PROFILE_ID);

  assert.equal(profile.brand_name, 'Pancake Robot');
  assert.equal(profile.character.name, 'Pancake Robot');
});

test('profile list includes default profile first', () => {
  const profiles = listBrandProfiles();

  assert.equal(profiles[0].id, DEFAULT_PROFILE_ID);
  assert.equal(profiles[0].isDefault, true);
  assert.equal(profiles[0].name, 'Pancake Robot');
});

test('custom Sue profile remains selectable but isolated', () => {
  const profiles = listBrandProfiles();
  const sue = profiles.find(profile => profile.name.includes('Sue') || profile.id === 'my-new-brand');

  assert.ok(sue);

  const profile = loadBrandProfileById(sue.id);
  assert.equal(profile.character.name, 'Sue Wong');
});

test('runtime config is not the active default profile source', () => {
  const profile = loadBrandProfileById(DEFAULT_PROFILE_ID);

  assert.equal(profile.character.name, 'Pancake Robot');
  assert.notEqual(profile.character.name, 'Sue Wong');
});

test('shared suggester does not read stale generated config brand data', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/shared/suggest.js'), 'utf8');

  assert.equal(source.includes('config.brand'), false);
  assert.equal(source.includes('loadConfig'), false);
});

test('unsafe profile ids are rejected', () => {
  assert.throws(() => resolveBrandProfilePath('../brand-profile'));
  assert.throws(() => resolveBrandProfilePath('/tmp/foo'));
  assert.throws(() => resolveBrandProfilePath('..'));
  assert.throws(() => resolveBrandProfilePath('nested/profile'));
});
