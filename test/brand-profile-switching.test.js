import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  clearBrandProfileDefaultImage,
  DEFAULT_PROFILE_ID,
  findBrandProfileDefaultImage,
  getBrandProfileMediaDir,
  listBrandProfiles,
  loadBrandProfileById,
  resolveBrandProfilePath,
  saveBrandProfileById,
  setBrandProfileDefaultImageFile,
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

test('non-default brand profiles remain selectable and isolated from the default', () => {
  // Sue Wong profile (my-new-brand.json) was deleted in May 2026; this test now
  // verifies the general invariant: at least one non-default profile must exist
  // and must load cleanly without inheriting the Pancake Robot identity.
  const profiles = listBrandProfiles();
  const nonDefault = profiles.find((profileSummary) => {
    if (profileSummary.isDefault) return false;
    try {
      const profile = loadBrandProfileById(profileSummary.id);
      return typeof profile.character?.name === 'string' && profile.character.name !== 'Pancake Robot';
    } catch {
      return false;
    }
  });

  assert.ok(nonDefault, 'at least one non-default brand profile must be present and loadable');

  const profile = loadBrandProfileById(nonDefault.id);
  assert.ok(profile.character.name, 'non-default profile must have a character name');
  assert.notEqual(profile.character.name, 'Pancake Robot');
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

test('brand default image helpers persist and clear profile media state', () => {
  const profileId = `brand-default-image-test-${Date.now()}`;
  const profilePath = resolveBrandProfilePath(profileId);
  const mediaDir = getBrandProfileMediaDir(profileId);
  const seedProfile = loadBrandProfileById(DEFAULT_PROFILE_ID);

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  saveBrandProfileById(profileId, {
    ...seedProfile,
    brand_name: 'Brand Default Image Test',
    character: {
      ...seedProfile.character,
      name: 'Brand Default Image Test',
    },
    media: {
      default_image_url: '',
      default_image_path: '',
    },
  });

  try {
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'default-image.png'), 'fake-image');

    const saved = setBrandProfileDefaultImageFile(profileId, 'default-image.png');
    assert.match(saved.profile.media.default_image_url, new RegExp(`^/brand-media/${profileId}/default-image\\.png$`));
    assert.equal(saved.profile.media.default_image_path, '');

    const found = findBrandProfileDefaultImage(profileId);
    assert.ok(found);
    assert.equal(found.name, 'default-image.png');
    assert.equal(found.path, path.join(mediaDir, 'default-image.png'));

    const cleared = clearBrandProfileDefaultImage(profileId);
    assert.equal(cleared.defaultImage, null);
    assert.equal(cleared.profile.media.default_image_url, '');
    assert.equal(cleared.profile.media.default_image_path, '');
    assert.equal(findBrandProfileDefaultImage(profileId), null);
    assert.equal(fs.existsSync(path.join(mediaDir, 'default-image.png')), false);
  } finally {
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});
