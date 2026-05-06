import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSong, getReleaseLinks } from './db.js';
import { loadBrandProfile } from './brand-profile.js';
import { getSongMarketingKit } from './song-marketing-kit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');

export function getReleaseMarketingPack(songId) {
  const song = getSong(songId);
  if (!song) throw new Error(`Song not found: ${songId}`);

  const brand = loadBrandProfile();
  const releaseLinks = getReleaseLinks(songId);
  const marketingKit = getSongMarketingKit(song);
  const songDirs = findLikelySongOutputDirs(song);
  const files = songDirs.flatMap(dir => scanDirSafe(dir));

  return {
    song: normalizeSong(song),
    brand: {
      name: brand.brand_name || 'Pancake Robot',
      social: brand.social || {},
      ai_disclosure: brand.ai_disclosure || 'The music is AI-assisted and human-directed.',
    },
    marketing_links: marketingKit.marketing_links,
    marketing_assets: marketingKit.marketing_assets,
    marketing_readiness: marketingKit.marketing_readiness,
    streaming_links: releaseLinks.map(link => ({ platform: link.platform, url: link.url })),
    primary_link: choosePrimaryLink(releaseLinks),
    cover_art: findFiles(files, ['cover', 'album', 'art'], ['.png', '.jpg', '.jpeg']).map(fileInfo),
    lyrics_assets: findFiles(files, ['lyric'], ['.md', '.txt', '.pdf']).map(fileInfo),
    audio_previews: findFiles(files, ['preview', 'snippet', 'hook', 'sample'], ['.mp3', '.wav', '.m4a']).map(fileInfo),
    social_clips: findFiles(files, ['clip', 'reel', 'short', 'tiktok'], ['.mp4', '.mov', '.webm']).map(fileInfo),
    social_images: findFiles(files, ['instagram', 'facebook', 'social', 'post'], ['.png', '.jpg', '.jpeg']).map(fileInfo),
    captions: findFiles(files, ['caption', 'social'], ['.txt', '.md', '.json']).map(fileInfo),
    press_assets: findFiles(files, ['press', 'epk', 'distrokid', 'youtube-upload'], ['.md', '.txt', '.json']).map(fileInfo),
    asset_dirs: songDirs,
    missing: buildMissingList({ releaseLinks, files }),
    generated_at: new Date().toISOString(),
  };
}

export function getBundleMarketingPack(songIds = []) {
  const packs = songIds.map(id => getReleaseMarketingPack(id));
  return {
    bundle_song_ids: songIds,
    releases: packs,
    primary_links: packs.map(pack => ({ song_id: pack.song.id, title: pack.song.title, primary_link: pack.primary_link })),
    missing: packs.flatMap(pack => pack.missing.map(m => `${pack.song.title || pack.song.id}: ${m}`)),
    generated_at: new Date().toISOString(),
  };
}

function normalizeSong(song) {
  return {
    id: song.id,
    title: song.title,
    topic: song.topic,
    concept: song.concept,
    status: song.status,
    release_date: song.release_date,
    distributor: song.distributor,
    target_age_range: song.target_age_range,
  };
}

function choosePrimaryLink(links = []) {
  const priority = ['distrokid', 'distrokid_link', 'spotify', 'apple music', 'youtube'];
  for (const wanted of priority) {
    const match = links.find(link => String(link.platform || '').toLowerCase() === wanted);
    if (match) return { platform: match.platform, url: match.url };
  }
  return links[0] ? { platform: links[0].platform, url: links[0].url } : null;
}

function findLikelySongOutputDirs(song) {
  const candidates = [];
  const values = [song.id, song.slug, song.title, song.topic].filter(Boolean).map(safeNameVariants).flat();
  const roots = [
    path.join(OUTPUT_DIR, 'distribution-ready'),
    path.join(OUTPUT_DIR, 'marketing'),
    path.join(OUTPUT_DIR, 'songs'),
    OUTPUT_DIR,
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const value of values) candidates.push(path.join(root, value));
    for (const child of listDirs(root)) {
      const lower = path.basename(child).toLowerCase();
      if (values.some(value => lower.includes(value.toLowerCase()))) candidates.push(child);
    }
  }

  return [...new Set(candidates.filter(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory()))];
}

function safeNameVariants(value) {
  const raw = String(value || '').trim();
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const snake = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return [raw, slug, snake].filter(Boolean);
}

function listDirs(root) {
  try {
    return fs.readdirSync(root).map(name => path.join(root, name)).filter(p => fs.statSync(p).isDirectory());
  } catch {
    return [];
  }
}

function scanDirSafe(dir) {
  const results = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) results.push(...scanDirSafe(full));
      else results.push({ path: full, name, ext: path.extname(name).toLowerCase(), size_bytes: stat.size });
    }
  } catch {
    return results;
  }
  return results;
}

function findFiles(files, includes = [], exts = []) {
  return files.filter(file => {
    const lower = file.name.toLowerCase();
    return includes.some(term => lower.includes(term)) && exts.includes(file.ext);
  });
}

function fileInfo(file) {
  return {
    name: file.name,
    path: file.path,
    relative_path: path.relative(ROOT_DIR, file.path),
    size_bytes: file.size_bytes,
  };
}

function buildMissingList({ releaseLinks, files }) {
  const missing = [];
  if (!releaseLinks.length) missing.push('release links');
  if (!findFiles(files, ['cover', 'album', 'art'], ['.png', '.jpg', '.jpeg']).length) missing.push('cover art');
  if (!findFiles(files, ['clip', 'reel', 'short', 'tiktok'], ['.mp4', '.mov', '.webm']).length) missing.push('short social clips');
  return missing;
}
