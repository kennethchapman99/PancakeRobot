/**
 * Collects song assets for Instagram/TikTok launch packs.
 * Manual-posting first: no platform APIs are called from this module.
 */

import fs from 'fs';
import { basename, dirname, extname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { getSong } from '../shared/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');

function exists(path) {
  return path && fs.existsSync(path);
}

function readJson(path) {
  if (!exists(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path) {
  if (!exists(path)) return null;
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function firstExisting(paths) {
  return paths.find(exists) || null;
}

function filesIn(dir, predicate = () => true) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => join(dir, name))
    .filter(path => {
      try { return fs.statSync(path).isFile() && predicate(path); }
      catch { return false; }
    });
}

function preferredImage(paths) {
  const priority = [
    /cover-art-3000x3000/i,
    /apple.*cover/i,
    /spotify.*final/i,
    /square.*final/i,
    /spotify.*base/i,
    /square.*base/i,
    /youtube.*final/i,
    /landscape.*final/i,
    /\.png$/i,
    /\.jpe?g$/i,
  ];
  for (const pattern of priority) {
    const hit = paths.find(path => pattern.test(basename(path)));
    if (hit) return hit;
  }
  return paths[0] || null;
}

function cleanLyrics(raw) {
  if (!raw) return '';
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^#{1,6}\s/.test(line))
    .filter(line => !/^\[[^\]]+\]$/.test(line))
    .filter(line => !/^\*.*\*$/.test(line))
    .map(line => line.replace(/^[-*]\s+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function copyIfExists(source, destination) {
  if (!exists(source)) return null;
  fs.mkdirSync(dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return destination;
}

function rel(path) {
  return path ? relative(REPO_ROOT, path) : null;
}

export function getMarketingOutputDir(songId, outputRoot = process.env.MARKETING_OUTPUT_DIR || 'output/marketing-ready') {
  return join(REPO_ROOT, outputRoot, songId);
}

export function collectMarketingAssets(songId, options = {}) {
  const song = getSong(songId);
  const songDir = join(REPO_ROOT, 'output/songs', songId);
  const distributionDir = join(REPO_ROOT, 'output/distribution-ready', songId);
  const outputDir = getMarketingOutputDir(songId, options.outputRoot);

  const instagramDir = join(outputDir, 'instagram');
  const tiktokDir = join(outputDir, 'tiktok');
  const sourceDir = join(outputDir, 'source');
  const workingDir = join(outputDir, '.working');
  for (const dir of [outputDir, instagramDir, tiktokDir, sourceDir, workingDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const metadataPath = firstExisting([
    join(distributionDir, 'metadata.json'),
    join(songDir, 'metadata.json'),
  ]);
  const metadata = readJson(metadataPath) || {};

  const audioCandidates = [
    join(distributionDir, 'upload-this.mp3'),
    join(distributionDir, 'upload-this.wav'),
    join(songDir, 'audio.mp3'),
    join(songDir, 'audio.wav'),
    ...filesIn(join(songDir, 'audio'), path => /\.(mp3|wav)$/i.test(path)),
  ];
  const audioPath = firstExisting(audioCandidates);

  const thumbImages = filesIn(join(songDir, 'thumbnails'), path => /\.(png|jpg|jpeg)$/i.test(path));
  const distributionImages = filesIn(distributionDir, path => /\.(png|jpg|jpeg)$/i.test(path));
  const coverPath = preferredImage([...distributionImages, ...thumbImages]);

  const characterPath = firstExisting([
    process.env.MARKETING_CHARACTER_ASSET,
    join(REPO_ROOT, 'assets/pancake-robot-character.png'),
    join(REPO_ROOT, 'assets/pancake-robot-avatar.png'),
    join(REPO_ROOT, 'src/web/public/logo.png'),
    coverPath,
  ]);

  const lyricsPath = firstExisting([
    join(songDir, 'lyrics-clean.txt'),
    join(songDir, 'lyrics.md'),
    join(distributionDir, 'lyrics.txt'),
  ]);
  const lyricsRaw = readText(lyricsPath) || '';
  const lyricsClean = cleanLyrics(lyricsRaw);

  const title = song?.title || metadata.title || metadata.youtube_title || song?.topic || songId;
  const artist = metadata.artist || metadata.primary_artist || process.env.MARKETING_DEFAULT_ARTIST || 'Pancake Robot';
  const handle = process.env.MARKETING_DEFAULT_HANDLE || '@pancakerobotmusic';
  const cta = process.env.MARKETING_DEFAULT_CTA || 'Listen everywhere - link in bio';
  const hyperfollowUrl = metadata.hyperfollow_url || metadata.hyperfollow || metadata.streaming_link || metadata.link_in_bio_url || '';

  const copiedAudio = audioPath ? copyIfExists(audioPath, join(sourceDir, `final-audio${extname(audioPath) || '.mp3'}`)) : null;
  const copiedCover = coverPath ? copyIfExists(coverPath, join(sourceDir, `cover-art${extname(coverPath) || '.png'}`)) : null;
  const copiedCharacter = characterPath ? copyIfExists(characterPath, join(sourceDir, `character-asset${extname(characterPath) || '.png'}`)) : null;
  const copiedLyrics = join(sourceDir, 'lyrics-clean.txt');
  fs.writeFileSync(copiedLyrics, lyricsClean || title);

  return {
    songId,
    song,
    title,
    artist,
    handle,
    cta,
    hyperfollowUrl,
    metadata,
    metadataPath,
    lyricsRaw,
    lyricsClean,
    lyricsPath,
    repoRoot: REPO_ROOT,
    songDir,
    distributionDir,
    outputDir,
    dirs: { instagramDir, tiktokDir, sourceDir, workingDir },
    source: {
      audioPath,
      coverPath,
      characterPath,
      copiedAudio,
      copiedCover,
      copiedCharacter,
      copiedLyrics,
    },
    relative: {
      audioPath: rel(audioPath),
      coverPath: rel(coverPath),
      characterPath: rel(characterPath),
      outputDir: rel(outputDir),
      copiedAudio: rel(copiedAudio),
      copiedCover: rel(copiedCover),
      copiedCharacter: rel(copiedCharacter),
    },
  };
}
