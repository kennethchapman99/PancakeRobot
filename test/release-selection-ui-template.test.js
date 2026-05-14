import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('song detail template exposes release-selection explanation and operator CTAs', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/web/views/songs/detail.ejs'), 'utf8');
  assert.match(source, /Release Selection/);
  assert.match(source, /Approve for DistroKid Package/);
  assert.match(source, /Send to Editing/);
  assert.match(source, /Hold as Draft/);
  assert.match(source, /Archive Song/);
  assert.match(source, /Review Issues/);
  assert.match(source, /Category Scores/);
  assert.match(source, /Best Hook/);
});

test('song catalog template exposes clean catalog filters and removes stale A&R pill filters', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/web/views/songs/index.ejs'), 'utf8');

  assert.match(source, /All brand profiles/);
  assert.match(source, /All statuses/);
  assert.match(source, /All activity dates/);
  assert.match(source, /Latest activity first/);
  assert.match(source, /Brand Profile/);
  assert.match(source, /Latest Activity/);
  assert.match(source, /Run A&R Analysis/);
  assert.match(source, /Approve Selected for Release Packaging/);

  assert.doesNotMatch(source, /All A&R recommendations/);
  assert.doesNotMatch(source, /All release treatments/);
  assert.doesNotMatch(source, /Score ≥ 85/);
  assert.doesNotMatch(source, /Score &lt; 55/);
});

