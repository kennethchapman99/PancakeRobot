import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getSong } from '../db.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'output');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac']);

function unique(values = []) {
  return [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

function isWithinDirectory(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

export function isYoutubeVideoPath(value = '') {
  const ext = path.extname(String(value || '').split('?')[0]).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function isImagePath(value = '') {
  const ext = path.extname(String(value || '').split('?')[0]).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function isAudioPath(value = '') {
  const ext = path.extname(String(value || '').split('?')[0]).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

function resolveLocalMediaPath(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return '';
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return '';
    }
  }
  if (trimmed.startsWith('/media/')) {
    return path.join(OUTPUT_ROOT, trimmed.slice('/media/'.length));
  }
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(REPO_ROOT, trimmed);
}

function firstExistingPath(candidates = [], predicate = () => true) {
  for (const candidate of unique(candidates)) {
    const localPath = resolveLocalMediaPath(candidate);
    if (localPath && fs.existsSync(localPath) && predicate(localPath)) return localPath;
  }
  return '';
}

function scoreAudioPath(filePath) {
  const normalized = normalizeSlashes(filePath).toLowerCase();
  let score = 0;
  if (normalized.includes('/masters/')) score += 100;
  if (normalized.includes('mastered')) score += 80;
  if (normalized.includes('320')) score += 30;
  if (normalized.includes('/source/')) score += 20;
  if (normalized.includes('original')) score += 10;
  if (normalized.endsWith('.wav')) score += 5;
  if (normalized.endsWith('.mp3')) score += 3;
  return score;
}

function scoreImagePath(filePath) {
  const normalized = normalizeSlashes(filePath).toLowerCase();
  let score = 0;
  if (normalized.includes('social')) score += 80;
  if (normalized.includes('marketing')) score += 70;
  if (normalized.includes('cover')) score += 60;
  if (normalized.includes('square')) score += 30;
  if (normalized.includes('vertical')) score += 25;
  if (normalized.includes('portrait')) score += 20;
  if (normalized.endsWith('.png')) score += 5;
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) score += 4;
  return score;
}

function findRecursiveFiles(rootDir, predicate, maxDepth = 5) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  walk(rootDir, 0);
  return results;
}

function songOutputDir(songId) {
  return path.join(OUTPUT_ROOT, 'songs', songId);
}

export function getYoutubeVideoOutput(songId, outputPath = '') {
  const finalPath = outputPath || path.join(songOutputDir(songId), 'marketing', 'youtube', 'youtube_video.mp4');
  return {
    outputPath: finalPath,
    assetUrl: outputPath ? finalPath : `/media/songs/${encodeURIComponent(songId)}/marketing/youtube/youtube_video.mp4`,
  };
}

function collectAudioCandidates({ post = {}, request = {}, song = {}, sourceAudioPath = '' }) {
  const songId = post.song_id || request.songId || request.song_id || song?.id || '';
  const base = songId ? songOutputDir(songId) : '';
  const directCandidates = unique([
    sourceAudioPath,
    request.sourceAudioPath,
    request.audioPath,
    request.masteredAudioPath,
    post.source_audio_path,
    post.audio_path,
    song.mastered_audio_path,
    song.masteredAudioPath,
    song.audio_path,
    song.audioPath,
    song.source_audio_path,
    song.sourceAudioPath,
    song.media?.mastered_audio_path,
    song.media?.audio_path,
    base && path.join(base, 'masters', 'local_fast_master', 'mastered_320.mp3'),
    base && path.join(base, 'masters', 'mastered_320.mp3'),
    base && path.join(base, 'media', 'source', 'original.mp3'),
    base && path.join(base, 'media', 'source', 'original.wav'),
    base && path.join(base, 'original.mp3'),
    base && path.join(base, 'song.mp3'),
  ]);
  const recursive = base
    ? findRecursiveFiles(base, filePath => isAudioPath(filePath))
        .sort((a, b) => scoreAudioPath(b) - scoreAudioPath(a))
    : [];
  return unique([...directCandidates, ...recursive]);
}

function collectImageCandidates({ post = {}, request = {}, song = {}, sourceImagePath = '' }) {
  const songId = post.song_id || request.songId || request.song_id || song?.id || '';
  const base = songId ? songOutputDir(songId) : '';
  const marketingAssets = song.marketing_assets || {};
  const directCandidates = unique([
    sourceImagePath,
    request.sourceImagePath,
    post.asset_url,
    request.assetUrl,
    request.publicAssetUrl,
    marketingAssets.vertical_post_url,
    marketingAssets.square_post_url,
    marketingAssets.portrait_post_url,
    marketingAssets.cover_safe_promo_url,
    marketingAssets.no_text_variation_url,
    marketingAssets.cover_url,
    song.cover_url,
    song.coverArtPath,
    song.cover_art_path,
    base && path.join(base, 'art', 'cover.png'),
    base && path.join(base, 'art', 'cover.jpg'),
    base && path.join(base, 'art', 'cover-front.png'),
    base && path.join(base, 'marketing', 'cover.png'),
  ]);
  const recursive = base
    ? findRecursiveFiles(base, filePath => isImagePath(filePath) && !normalizeSlashes(filePath).includes('/marketing/youtube/'))
        .sort((a, b) => scoreImagePath(b) - scoreImagePath(a))
    : [];
  return unique([...directCandidates, ...recursive]);
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      if (error.code === 'ENOENT') {
        reject(new Error('ffmpeg is required to render YouTube video assets. Install with: brew install ffmpeg'));
      } else {
        reject(error);
      }
    });
    child.on('close', code => {
      if (code === 0) resolve({ code, stderr });
      else reject(new Error(`ffmpeg failed with exit code ${code}: ${stderr.split('\n').slice(-8).join(' ')}`));
    });
  });
}

function buildFfmpegArgs({ sourceImagePath, sourceAudioPath, outputPath }) {
  const commonVideoFilter = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p';
  const isGif = path.extname(sourceImagePath).toLowerCase() === '.gif';
  if (isGif) {
    return [
      '-y',
      '-stream_loop', '-1',
      '-i', sourceImagePath,
      '-i', sourceAudioPath,
      '-vf', commonVideoFilter,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      outputPath,
    ];
  }
  return [
    '-y',
    '-loop', '1',
    '-i', sourceImagePath,
    '-i', sourceAudioPath,
    '-vf', commonVideoFilter,
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    outputPath,
  ];
}

export async function ensureYouTubeVideoAsset({
  post = {},
  request = {},
  song = null,
  force = false,
  outputPath = '',
  sourceAudioPath = '',
  sourceImagePath = '',
  runner = null,
} = {}) {
  const songId = post.song_id || request.songId || request.song_id || song?.id || '';
  if (!songId) {
    return { ok: false, error: 'YouTube video asset generation requires song_id.' };
  }

  const resolvedSong = song || getSong(songId) || { id: songId };
  const output = getYoutubeVideoOutput(songId, outputPath);

  if (!force && fs.existsSync(output.outputPath)) {
    return {
      ok: true,
      reused: true,
      videoPath: output.outputPath,
      videoAssetUrl: output.assetUrl,
      sourceAudioPath: '',
      sourceImagePath: '',
      commandSummary: 'Reused existing YouTube MP4 asset.',
    };
  }

  const resolvedAudioPath = firstExistingPath(
    collectAudioCandidates({ post, request, song: resolvedSong, sourceAudioPath }),
    filePath => isAudioPath(filePath),
  );
  if (!resolvedAudioPath) {
    return {
      ok: false,
      error: `No YouTube source audio found for ${songId}. Expected mastered audio or original audio under output/songs/${songId}/...`,
    };
  }

  const resolvedImagePath = firstExistingPath(
    collectImageCandidates({ post, request, song: resolvedSong, sourceImagePath }),
    filePath => isImagePath(filePath),
  );
  if (!resolvedImagePath) {
    return {
      ok: false,
      error: `No YouTube source image found for ${songId}. Expected a local campaign/social image, release-kit image, or cover art.`,
    };
  }

  fs.mkdirSync(path.dirname(output.outputPath), { recursive: true });
  const args = buildFfmpegArgs({
    sourceImagePath: resolvedImagePath,
    sourceAudioPath: resolvedAudioPath,
    outputPath: output.outputPath,
  });

  try {
    if (runner) {
      await runner({
        command: 'ffmpeg',
        args,
        sourceAudioPath: resolvedAudioPath,
        sourceImagePath: resolvedImagePath,
        outputPath: output.outputPath,
      });
    } else {
      await runFfmpeg(args);
    }
  } catch (error) {
    return { ok: false, error: error.message, sourceAudioPath: resolvedAudioPath, sourceImagePath: resolvedImagePath };
  }

  if (!fs.existsSync(output.outputPath)) {
    return {
      ok: false,
      error: `YouTube video render completed but no MP4 was created at ${output.outputPath}.`,
      sourceAudioPath: resolvedAudioPath,
      sourceImagePath: resolvedImagePath,
    };
  }

  return {
    ok: true,
    reused: false,
    videoPath: output.outputPath,
    videoAssetUrl: output.assetUrl,
    sourceAudioPath: resolvedAudioPath,
    sourceImagePath: resolvedImagePath,
    commandSummary: `ffmpeg ${args.map(arg => (String(arg).includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`,
  };
}

export function isOutputMediaAsset(assetUrl = '') {
  const localPath = resolveLocalMediaPath(assetUrl);
  return Boolean(localPath && isWithinDirectory(OUTPUT_ROOT, localPath));
}

export { resolveLocalMediaPath };
