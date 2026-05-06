import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('outreach link blocks omit blank fields and only include download links for file-needing outreach types', async () => {
  const { buildOutreachLinkBlock } = await import(`../src/shared/song-marketing-kit.js?links=${Date.now()}`);
  const links = {
    smart_link: 'https://listen.example/song',
    spotify_url: 'https://spotify.example/song',
    youtube_video_url: 'https://youtube.example/song',
    release_kit_url: 'https://press.example/song',
    audio_download_url: 'https://download.example/song.wav',
    promo_assets_folder_url: 'https://assets.example/song',
    instagram_url: 'https://instagram.example/song',
    tiktok_url: '',
    contact_email: 'hello@example.com',
  };

  const socialBlock = buildOutreachLinkBlock({ links, outreachType: 'social' });
  assert.match(socialBlock, /Listen \/ stream:/);
  assert.match(socialBlock, /Instagram:/);
  assert.doesNotMatch(socialBlock, /Download audio:/);
  assert.doesNotMatch(socialBlock, /Promo assets:/);
  assert.doesNotMatch(socialBlock, /TikTok:/);

  const radioBlock = buildOutreachLinkBlock({ links, outreachType: 'radio' });
  assert.match(radioBlock, /Download audio:/);
  assert.match(radioBlock, /Contact:/);

  const blogBlock = buildOutreachLinkBlock({ links, outreachType: 'blog', audience: 'kids and family' });
  assert.match(blogBlock, /Release kit:/);
  assert.match(blogBlock, /Promo assets:/);
  assert.doesNotMatch(blogBlock, /Download audio:/);
});

test('readiness scoring treats missing marketing fields as warnings instead of blockers', async () => {
  const { computeMarketingReadiness } = await import(`../src/shared/song-marketing-kit.js?readiness=${Date.now()}`);
  const readiness = computeMarketingReadiness({
    links: {
      smart_link: '',
      spotify_url: '',
      apple_music_url: '',
      youtube_music_url: '',
      youtube_video_url: '',
      release_kit_url: '',
      audio_download_url: '',
      promo_assets_folder_url: '',
      cover_art_url: '',
      lyrics_url: '',
      instagram_url: '',
      tiktok_url: '',
      artist_website_url: '',
      contact_email: '',
    },
    assets: {
      base_image_url: '',
      fallback_image_url: '',
      square_post_url: '',
      vertical_post_url: '',
      portrait_post_url: '',
      outreach_banner_url: '',
      cover_safe_promo_url: '',
      no_text_variation_url: '',
    },
  });

  assert.equal(readiness.score, 50);
  assert.ok(readiness.missing_required_fields.includes('smart_link'));
  assert.ok(readiness.missing_required_fields.includes('contact_email'));
  assert.ok(readiness.missing_required_fields.includes('base_or_fallback_image'));
  assert.ok(readiness.missing_required_fields.includes('social_asset_set'));
  assert.ok(readiness.missing_recommended_fields.includes('social_links'));
  assert.ok(readiness.warnings.some(w => /release kit/i.test(w)));
});

test('release-level marketing fields can be explicitly cleared without falling back to brand defaults', () => {
  const slug = `song-marketing-kit-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { upsertSong } from './src/shared/db.js';
      import { getSongMarketingKit, saveSongMarketingKit } from './src/shared/song-marketing-kit.js';

      upsertSong({ id: 'KIT_TEST', title: 'Marketing Kit Test' });
      const initial = getSongMarketingKit('KIT_TEST');
      assert.ok(initial.marketing_links.contact_email);

      saveSongMarketingKit('KIT_TEST', {
        marketing_links: {
          contact_email: '',
          instagram_url: '',
          smart_link: '',
        },
      });

      const saved = getSongMarketingKit('KIT_TEST');
      assert.equal(saved.marketing_links.contact_email, '');
      assert.equal(saved.marketing_links.instagram_url, '');
      assert.equal(saved.marketing_links.smart_link, '');
      console.log('OK');
    `], {
      cwd: repoRoot,
      env: { ...process.env, PIPELINE_APP_SLUG: slug },
      encoding: 'utf8',
    });

    assert.match(output, /OK/);
  } finally {
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      fs.rmSync(path.join(repoRoot, `${slug}${suffix}`), { force: true });
    }
  }
});

test('marketing kit falls back to the default base-image library when no release-specific image exists', () => {
  const slug = `song-marketing-kit-default-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { upsertSong } from './src/shared/db.js';
      import { getSongMarketingKit } from './src/shared/song-marketing-kit.js';

      upsertSong({ id: 'KIT_DEFAULT_IMAGE', title: 'Default Image Test' });
      const saved = getSongMarketingKit('KIT_DEFAULT_IMAGE');
      assert.match(saved.marketing_assets.fallback_image_url, /^\\/base-images\\//);
      assert.equal(saved.image_source.generation_source, 'default_base_image_pool');
      console.log('OK');
    `], {
      cwd: repoRoot,
      env: { ...process.env, PIPELINE_APP_SLUG: slug },
      encoding: 'utf8',
    });

    assert.match(output, /OK/);
  } finally {
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      fs.rmSync(path.join(repoRoot, `${slug}${suffix}`), { force: true });
    }
  }
});

test('syncSongMarketingKitFromPack preserves saved marketing links while refreshing assets', () => {
  const slug = `song-marketing-kit-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { upsertSong } from './src/shared/db.js';
      import { saveSongMarketingKit, syncSongMarketingKitFromPack, getSongMarketingKit } from './src/shared/song-marketing-kit.js';

      upsertSong({ id: 'KIT_SYNC_TEST', title: 'Sync Test' });
      saveSongMarketingKit('KIT_SYNC_TEST', {
        marketing_links: {
          smart_link: 'https://example.com/hyperfollow',
          spotify_url: 'https://example.com/spotify',
          promo_assets_folder_url: 'https://example.com/assets',
          lyrics_url: 'https://example.com/lyrics',
          contact_email: 'ken@example.com',
        },
      });

      syncSongMarketingKitFromPack('KIT_SYNC_TEST', {
        marketingPack: {
          meta: {
            generated_at: new Date().toISOString(),
            generated_assets: [
              { name: 'ig-square-post-1080x1080.png', path: 'output/marketing-ready/KIT_SYNC_TEST/instagram/ig-square-post-1080x1080.png' },
              { name: 'ig-feed-announcement-1080x1350.png', path: 'output/marketing-ready/KIT_SYNC_TEST/instagram/ig-feed-announcement-1080x1350.png' },
            ],
          },
        },
      });

      const saved = getSongMarketingKit('KIT_SYNC_TEST');
      assert.equal(saved.marketing_links.smart_link, 'https://example.com/hyperfollow');
      assert.equal(saved.marketing_links.spotify_url, 'https://example.com/spotify');
      assert.equal(saved.marketing_links.promo_assets_folder_url, 'https://example.com/assets');
      assert.equal(saved.marketing_links.lyrics_url, 'https://example.com/lyrics');
      console.log('OK');
    `], {
      cwd: repoRoot,
      env: { ...process.env, PIPELINE_APP_SLUG: slug },
      encoding: 'utf8',
    });

    assert.match(output, /OK/);
  } finally {
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      fs.rmSync(path.join(repoRoot, `${slug}${suffix}`), { force: true });
    }
  }
});

test('release kit publish flag persists when submitted inside marketing_assets payload', () => {
  const slug = `song-marketing-kit-publish-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { upsertSong } from './src/shared/db.js';
      import { saveSongMarketingKit, getSongMarketingKit } from './src/shared/song-marketing-kit.js';

      upsertSong({ id: 'KIT_PUBLISH_TEST', title: 'Publish Test' });
      saveSongMarketingKit('KIT_PUBLISH_TEST', {
        marketing_assets: {
          release_kit_published: true,
        },
      });

      const saved = getSongMarketingKit('KIT_PUBLISH_TEST');
      assert.equal(saved.marketing_assets.release_kit_published, true);
      console.log('OK');
    `], {
      cwd: repoRoot,
      env: { ...process.env, PIPELINE_APP_SLUG: slug },
      encoding: 'utf8',
    });

    assert.match(output, /OK/);
  } finally {
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      fs.rmSync(path.join(repoRoot, `${slug}${suffix}`), { force: true });
    }
  }
});

test('partial marketing link saves do not wipe previously saved links', () => {
  const slug = `song-marketing-kit-partial-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { upsertSong } from './src/shared/db.js';
      import { saveSongMarketingKit, getSongMarketingKit } from './src/shared/song-marketing-kit.js';

      upsertSong({ id: 'KIT_PARTIAL_TEST', title: 'Partial Save Test' });
      saveSongMarketingKit('KIT_PARTIAL_TEST', {
        marketing_links: {
          smart_link: 'https://example.com/hyperfollow',
          spotify_url: 'https://example.com/spotify',
          promo_assets_folder_url: 'https://example.com/assets',
          lyrics_url: 'https://example.com/lyrics',
          contact_email: 'ken@example.com',
        },
      });

      saveSongMarketingKit('KIT_PARTIAL_TEST', {
        marketing_links: {
          release_kit_url: '/release-kit/KIT_PARTIAL_TEST',
        },
        marketing_assets: {
          release_kit_published: true,
        },
      });

      const saved = getSongMarketingKit('KIT_PARTIAL_TEST');
      assert.equal(saved.marketing_links.smart_link, 'https://example.com/hyperfollow');
      assert.equal(saved.marketing_links.spotify_url, 'https://example.com/spotify');
      assert.equal(saved.marketing_links.promo_assets_folder_url, 'https://example.com/assets');
      assert.equal(saved.marketing_links.lyrics_url, 'https://example.com/lyrics');
      assert.equal(saved.marketing_links.release_kit_url, '/release-kit/KIT_PARTIAL_TEST');
      assert.equal(saved.marketing_assets.release_kit_published, true);
      console.log('OK');
    `], {
      cwd: repoRoot,
      env: { ...process.env, PIPELINE_APP_SLUG: slug },
      encoding: 'utf8',
    });

    assert.match(output, /OK/);
  } finally {
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      fs.rmSync(path.join(repoRoot, `${slug}${suffix}`), { force: true });
    }
  }
});
