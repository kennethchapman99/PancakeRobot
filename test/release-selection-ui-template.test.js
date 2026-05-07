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

test('song catalog template exposes visual A&R filters, pills, and score columns', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/web/views/songs/index.ejs'), 'utf8');
  assert.match(source, /All A&R recommendations/);
  assert.match(source, /All release treatments/);
  assert.match(source, /Recommend to Publish/);
  assert.match(source, /Needs Manual Review/);
  assert.match(source, /Full Push/);
  assert.match(source, /Social Only/);
  assert.match(source, /A&R Score/);
  assert.match(source, /Run A&R Analysis/);
  assert.match(source, /Approve Selected for Release Packaging/);
});

