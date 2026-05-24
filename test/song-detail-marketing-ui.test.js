import test from 'node:test';
import assert from 'node:assert/strict';

import { marketingPack } from '../src/web/public/song-detail-marketing.js';
import fs from 'node:fs';
import path from 'node:path';
import { deleteSong, upsertSong } from '../src/shared/db.js';
import { getSongMarketingKit, buildReleaseKitViewModel } from '../src/shared/song-marketing-kit.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function createElement(id) {
  return {
    id,
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    scrollIntoView() {},
  };
}

function createDocument(songId) {
  const elements = new Map();
  const ids = [
    'release-kit-actions',
    `pack-mode-${songId}`,
    `pack-regen-${songId}`,
    `pack-novideos-${songId}`,
    `pack-terminal-${songId}`,
    `pack-log-${songId}`,
    `pack-footer-${songId}`,
    `pack-badge-${songId}`,
    `pack-status-${songId}`,
    `pack-trigger-idle-${songId}`,
    `pack-trigger-running-${songId}`,
  ];
  for (const id of ids) elements.set(id, createElement(id));
  elements.get('release-kit-actions').dataset = { reloadUrl: `/songs/${songId}?tab=marketing#release-kit-actions` };
  elements.get(`pack-mode-${songId}`).value = 'render_from_existing_visuals';
  elements.get(`pack-regen-${songId}`).checked = false;
  elements.get(`pack-novideos-${songId}`).checked = false;

  const buildButton = createElement(`pack-trigger-${songId}`);
  buildButton.dataset = { songId, releaseAssetsBuild: '1' };

  return {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll(selector) {
      if (selector === `button[data-song-id="${songId}"][data-release-assets-build]`) return [buildButton];
      return [];
    },
    createElement() {
      return createElement('generated');
    },
    elements,
    buildButton,
  };
}

test('clicking Generate Release Assets immediately changes button and status text before the backend completes', async t => {
  const songId = `UI_BUILD_${Date.now()}`;
  const documentStub = createDocument(songId);
  const locationCalls = [];
  const originalSetTimeout = global.setTimeout;

  global.document = documentStub;
  global.window = {
    __marketingPackInstances: {},
    location: {
      pathname: `/songs/${songId}`,
      assign(url) { locationCalls.push(url); },
    },
  };
  global.setTimeout = fn => {
    fn();
    return 0;
  };

  let resolveFetch;
  const fetchPromise = new Promise(resolve => { resolveFetch = resolve; });
  const controller = marketingPack(songId, () => fetchPromise);
  controller.register();

  const pending = controller.buildPack(songId, ['ig-square-post-1080x1080.png']);

  assert.equal(controller.packState, 'running');
  assert.equal(controller.packFooter, 'Generating release assets…');
  assert.match(documentStub.elements.get(`pack-status-${songId}`).textContent, /Generating release assets/i);
  assert.equal(documentStub.buildButton.disabled, true);

  resolveFetch({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({
      ok: true,
      marketingAssets: { generated_at: new Date().toISOString() },
      qaFailures: [],
    }),
  });

  await pending;
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    delete global.document;
    delete global.window;
  });
  assert.equal(controller.packState, 'done');
  assert.ok(locationCalls.length >= 1);
});

test('backend failure shows a visible error instead of a silent no-op', async t => {
  const songId = `UI_ERROR_${Date.now()}`;
  const documentStub = createDocument(songId);

  global.document = documentStub;
  global.window = {
    __marketingPackInstances: {},
    location: {
      pathname: `/songs/${songId}`,
      assign() {},
    },
  };

  const controller = marketingPack(songId, async () => ({
    ok: false,
    status: 500,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: 'simulated backend failure' }),
  }));

  await assert.rejects(
    controller.buildPack(songId, ['ig-square-post-1080x1080.png']),
    /simulated backend failure/,
  );

  t.after(() => {
    delete global.document;
    delete global.window;
  });
  assert.equal(controller.packState, 'error');
  assert.match(documentStub.elements.get(`pack-status-${songId}`).textContent, /simulated backend failure/i);
  assert.match(documentStub.elements.get(`pack-log-${songId}`).children.at(-1)?.textContent || '', /simulated backend failure/i);
});

test('song detail makes album inheritance explicit and removes competing song release controls', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/web/views/songs/detail.ejs'), 'utf8');

  assert.match(source, /Album Release Context/);
  assert.match(source, /inherits release media, DistroKid submission, HyperFollow, social readiness, and campaign context from the album/);
  assert.match(source, /This track uses album media\. Change or rebuild it on the album page\./);
  assert.match(source, /This track is submitted as part of its album/);
});

test('song detail and marketing kit use the song brand profile instead of the active default brand', t => {
  const songId = `SONG_REGGAE_PROFILE_${Date.now()}`;
  upsertSong({
    id: songId,
    title: 'Reggae Profile Check',
    status: 'draft',
    brand_profile_id: 'sunstone-signal-modern-roots-reggae',
  });
  t.after(() => deleteSong(songId));

  const kit = getSongMarketingKit(songId);
  const releaseKit = buildReleaseKitViewModel(songId);
  const detailSource = fs.readFileSync(path.join(repoRoot, 'src/web/views/songs/detail.ejs'), 'utf8');
  const serverSource = fs.readFileSync(path.join(repoRoot, 'src/web/server.js'), 'utf8');

  assert.equal(kit.brandName, 'Sunstone Signal [Modern Roots Reggae]');
  assert.equal(releaseKit.artistName, 'Sunstone Signal [Modern Roots Reggae]');
  assert.match(detailSource, /Brand profile:/);
  assert.match(detailSource, /Brand fit:/);
  assert.match(detailSource, /lyricsSourcePath/);
  assert.match(serverSource, /resolveSongBrandProfile\(song\)/);
  assert.match(serverSource, /readSongDetailFile\(song\.lyrics_path, fsAssets\.lyrics\)/);
});
