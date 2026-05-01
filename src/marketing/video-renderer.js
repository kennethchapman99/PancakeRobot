/**
 * Deterministic renderer for Instagram/TikTok marketing packs.
 * Uses canvas for exact text overlays and ffmpeg when available for MP4 assembly.
 */

import fs from 'fs';
import { basename, dirname, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createCanvas, loadImage } from 'canvas';

const execFileAsync = promisify(execFile);

const COLORS = {
  cream: '#FFF3D7',
  cream2: '#FFE5A3',
  teal: '#87D7E6',
  tealDark: '#155E75',
  amber: '#F59E0B',
  orange: '#EA580C',
  red: '#DC2626',
  ink: '#1F1A17',
  white: '#FFFFFF',
  muted: '#6B7280',
};

async function hasCommand(command, args = ['-version']) {
  try {
    await execFileAsync(command, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function escapeDrawText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function pickLines(text, maxChars = 28, maxLines = 4) {
  const words = escapeDrawText(text).split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function fitText(ctx, text, maxWidth, startSize, minSize = 34, weight = '900') {
  let size = startSize;
  const value = escapeDrawText(text);
  while (size > minSize) {
    ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
    if (ctx.measureText(value).width <= maxWidth) break;
    size -= 4;
  }
  ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
  return size;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawOutlinedText(ctx, text, x, y, opts = {}) {
  const {
    align = 'center',
    fill = COLORS.white,
    stroke = COLORS.ink,
    lineWidth = 12,
  } = opts;
  ctx.save();
  ctx.textAlign = align;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

async function drawImageContain(ctx, imagePath, x, y, w, h, options = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) return false;
  try {
    const img = await loadImage(imagePath);
    const scale = Math.min(w / img.width, h / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    const ix = x + (w - iw) / 2;
    const iy = y + (h - ih) / 2;
    if (options.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 10;
      ctx.drawImage(img, ix, iy, iw, ih);
      ctx.restore();
    } else {
      ctx.drawImage(img, ix, iy, iw, ih);
    }
    return true;
  } catch {
    return false;
  }
}

async function drawImageCover(ctx, imagePath, x, y, w, h, alpha = 1) {
  if (!imagePath || !fs.existsSync(imagePath)) return false;
  try {
    const img = await loadImage(imagePath);
    const scale = Math.max(w / img.width, h / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    const ix = x + (w - iw) / 2;
    const iy = y + (h - ih) / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, ix, iy, iw, ih);
    ctx.restore();
    return true;
  } catch {
    return false;
  }
}

function drawBackground(ctx, width, height, variant = 'default') {
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, COLORS.cream);
  grad.addColorStop(1, variant === 'tiktok' ? '#BDEFFF' : '#FDE7B0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = COLORS.teal;
  ctx.beginPath();
  ctx.arc(width / 2, height * 0.48, Math.min(width * 0.46, height * 0.31), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 16;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = COLORS.white;
  ctx.font = `900 ${Math.round(width * 0.08)}px Arial, Helvetica, sans-serif`;
  const notes = ['♪', '♫', '♪', '♫'];
  const positions = [
    [width * 0.13, height * 0.23],
    [width * 0.82, height * 0.22],
    [width * 0.12, height * 0.68],
    [width * 0.86, height * 0.64],
  ];
  notes.forEach((note, idx) => ctx.fillText(note, positions[idx][0], positions[idx][1]));
  ctx.restore();
}

function drawSafeFooter(ctx, width, height, handle, color = COLORS.tealDark) {
  const footerY = height - Math.round(height * 0.115);
  const footerH = Math.round(height * 0.055);
  const footerW = Math.round(width * 0.72);
  const footerX = (width - footerW) / 2;
  ctx.fillStyle = color;
  roundRect(ctx, footerX, footerY, footerW, footerH, footerH / 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.white;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = COLORS.white;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, handle, footerW - 60, Math.round(footerH * 0.48), 24, '900');
  ctx.fillText(handle, width / 2, footerY + footerH / 2 + 2);
}

function drawButton(ctx, text, x, y, w, h, fill = COLORS.orange) {
  ctx.save();
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, Math.round(h / 2));
  ctx.fill();
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = COLORS.white;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, text, w - 40, Math.round(h * 0.48), 24, '900');
  ctx.fillText(text, x + w / 2, y + h / 2 + 2);
  ctx.restore();
}

async function renderCanvasImage({ width, height, outputPath, assets, headline, subhead, mode = 'default', lyricText = null }) {
  fs.mkdirSync(dirname(outputPath), { recursive: true });
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, width, height, mode === 'tiktok' ? 'tiktok' : 'default');

  const coverPath = assets.source.copiedCover || assets.source.coverPath;
  const characterPath = assets.source.copiedCharacter || assets.source.characterPath || coverPath;

  await drawImageCover(ctx, coverPath, 0, 0, width, height, 0.08);

  if (headline) {
    const headlineLines = Array.isArray(headline) ? headline : pickLines(headline, 16, 3);
    let y = Math.round(height * 0.08);
    for (const line of headlineLines) {
      fitText(ctx, line, width * 0.88, Math.round(width * 0.16), 50, '900');
      drawOutlinedText(ctx, line.toUpperCase(), width / 2, y, {
        fill: line.toLowerCase().includes('new') ? COLORS.amber : COLORS.white,
        stroke: COLORS.ink,
        lineWidth: Math.max(8, Math.round(width * 0.012)),
      });
      y += Math.round(width * 0.15);
    }
  }

  if (subhead) {
    drawButton(ctx, subhead, width * 0.16, height * 0.25, width * 0.68, height * 0.055, mode === 'tiktok' ? COLORS.red : COLORS.orange);
  }

  const characterTop = headline ? height * 0.33 : height * 0.18;
  const characterHeight = headline ? height * 0.48 : height * 0.58;
  const imageOk = await drawImageContain(ctx, characterPath, width * 0.08, characterTop, width * 0.84, characterHeight, { shadow: true });
  if (!imageOk) {
    ctx.fillStyle = COLORS.white;
    roundRect(ctx, width * 0.18, height * 0.37, width * 0.64, height * 0.22, 40);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.fillStyle = COLORS.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, 'PANCAKE ROBOT', width * 0.55, width * 0.08, 32, '900');
    ctx.fillText('PANCAKE ROBOT', width / 2, height * 0.48);
  }

  if (lyricText) {
    const boxX = width * 0.08;
    const boxY = height * 0.64;
    const boxW = width * 0.84;
    const boxH = height * 0.16;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    roundRect(ctx, boxX, boxY, boxW, boxH, 32);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 6;
    ctx.stroke();
    const lyricLines = pickLines(lyricText, 24, 3);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, lyricLines[0] || assets.title, boxW - 60, Math.round(width * 0.07), 34, '900');
    const lineHeight = Math.round(width * 0.068);
    const startY = boxY + boxH / 2 - ((lyricLines.length - 1) * lineHeight / 2);
    lyricLines.forEach((line, idx) => {
      drawOutlinedText(ctx, line, width / 2, startY + idx * lineHeight, { fill: COLORS.tealDark, stroke: COLORS.white, lineWidth: 5 });
    });
  }

  drawSafeFooter(ctx, width, height, assets.handle);

  const ext = outputPath.toLowerCase().endsWith('.jpg') || outputPath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  const out = fs.createWriteStream(outputPath);
  const stream = ext === 'image/jpeg' ? canvas.createJPEGStream({ quality: 0.94 }) : canvas.createPNGStream();
  await new Promise((resolve, reject) => {
    stream.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return outputPath;
}

async function renderMp4({ imagePath, audioPath, outputPath, hook, durationOverride = null }) {
  if (!audioPath || !fs.existsSync(audioPath)) return { skipped: true, reason: 'missing_audio' };
  if (!imagePath || !fs.existsSync(imagePath)) return { skipped: true, reason: 'missing_image' };
  if (!await hasCommand('ffmpeg')) return { skipped: true, reason: 'ffmpeg_not_found' };

  fs.mkdirSync(dirname(outputPath), { recursive: true });
  const duration = durationOverride || hook.hook_duration_sec || 15;
  const start = hook.hook_start_sec || 0;

  const args = [
    '-y',
    '-loop', '1',
    '-framerate', '30',
    '-i', imagePath,
    '-ss', String(start),
    '-t', String(duration),
    '-i', audioPath,
    '-t', String(duration),
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'main',
    '-level', '4.0',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ];

  try {
    await execFileAsync('ffmpeg', args, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
    return { skipped: false, path: outputPath };
  } catch (err) {
    return { skipped: true, reason: `ffmpeg_failed: ${err.message}` };
  }
}

function firstLyricLine(lyricsClean, fallback) {
  const line = String(lyricsClean || '')
    .split(/\r?\n/)
    .map(v => v.trim())
    .filter(Boolean)
    .find(v => v.length >= 8 && !/^\[/.test(v));
  return line || fallback;
}

export async function renderMarketingAssets(assets, hook) {
  const title = assets.title;
  const audioPath = assets.source.copiedAudio || assets.source.audioPath;
  const firstLyric = firstLyricLine(assets.lyricsClean, title);
  const generated = [];
  const skipped = [];

  const baseImages = {
    igHook: join(assets.dirs.workingDir, 'ig-reel-hook-base.jpg'),
    igLyrics: join(assets.dirs.workingDir, 'ig-reel-lyrics-base.jpg'),
    igCharacter: join(assets.dirs.workingDir, 'ig-reel-character-base.jpg'),
    igStory: join(assets.dirs.workingDir, 'ig-story-base.jpg'),
    tiktokHook: join(assets.dirs.workingDir, 'tiktok-hook-base.jpg'),
    tiktokLyrics: join(assets.dirs.workingDir, 'tiktok-lyrics-base.jpg'),
    tiktokLoop: join(assets.dirs.workingDir, 'tiktok-loop-base.jpg'),
  };

  const staticTargets = [
    { name: 'ig-feed-announcement-1080x1350.png', path: join(assets.dirs.instagramDir, 'ig-feed-announcement-1080x1350.png'), width: 1080, height: 1350, headline: ['NEW SONG', 'OUT NOW'], subhead: 'Listen everywhere', mode: 'instagram' },
    { name: 'ig-square-post-1080x1080.png', path: join(assets.dirs.instagramDir, 'ig-square-post-1080x1080.png'), width: 1080, height: 1080, headline: ['NEW SONG'], subhead: 'Link in bio', mode: 'instagram' },
    { name: 'ig-reel-cover.jpg', path: join(assets.dirs.instagramDir, 'ig-reel-cover.jpg'), width: 1080, height: 1920, headline: ['NEW SONG', 'OUT NOW'], subhead: 'Link in bio', mode: 'instagram' },
    { name: 'tiktok-cover.jpg', path: join(assets.dirs.tiktokDir, 'tiktok-cover.jpg'), width: 1080, height: 1920, headline: ['NEW SONG', 'OUT NOW'], subhead: 'Link in bio', mode: 'tiktok' },
  ];

  await renderCanvasImage({ width: 1080, height: 1920, outputPath: baseImages.igHook, assets, headline: ['LISTEN', 'EVERYWHERE'], subhead: 'link in bio', mode: 'instagram' });
  await renderCanvasImage({ width: 1080, height: 1920, outputPath: baseImages.igLyrics, assets, headline: [title], subhead: 'sing along', mode: 'instagram', lyricText: firstLyric });
  await renderCanvasImage({ width: 1080, height: 1920, outputPath: baseImages.igCharacter, assets, headline: ['PANCAKE', 'ROBOT'], subhead: 'new music', mode: 'instagram' });
  await renderCanvasImage({ width: 1080, height: 1920, outputPath: baseImages.igStory, assets, headline: ['NEW SONG', 'OUT NOW'], subhead: 'tap link in bio', mode: 'instagram' });
  await renderCanvasImage({ width: 1080, height: 1920, outputPath: baseImages.tiktokHook, assets, headline: ['NEW SONG', 'OUT NOW'], subhead: 'listen now', mode: 'tiktok' });
  await renderCanvasImage({ width: 1080, height: 1920, outputPath: baseImages.tiktokLyrics, assets, headline: [title], subhead: 'sing along', mode: 'tiktok', lyricText: firstLyric });
  await renderCanvasImage({ width: 1080, height: 1920, outputPath: baseImages.tiktokLoop, assets, headline: ['PANCAKE', 'ROBOT'], subhead: 'dance loop', mode: 'tiktok' });

  for (const target of staticTargets) {
    await renderCanvasImage(target);
    generated.push({ platform: target.path.includes('/tiktok/') ? 'tiktok' : 'instagram', type: 'image', name: target.name, path: target.path });
  }

  const videos = [
    { name: 'ig-reel-hook.mp4', image: baseImages.igHook, path: join(assets.dirs.instagramDir, 'ig-reel-hook.mp4') },
    { name: 'ig-reel-lyrics.mp4', image: baseImages.igLyrics, path: join(assets.dirs.instagramDir, 'ig-reel-lyrics.mp4') },
    { name: 'ig-reel-character.mp4', image: baseImages.igCharacter, path: join(assets.dirs.instagramDir, 'ig-reel-character.mp4') },
    { name: 'ig-story-new-song.mp4', image: baseImages.igStory, path: join(assets.dirs.instagramDir, 'ig-story-new-song.mp4') },
    { name: 'tiktok-hook.mp4', image: baseImages.tiktokHook, path: join(assets.dirs.tiktokDir, 'tiktok-hook.mp4') },
    { name: 'tiktok-lyric-karaoke.mp4', image: baseImages.tiktokLyrics, path: join(assets.dirs.tiktokDir, 'tiktok-lyric-karaoke.mp4') },
    { name: 'tiktok-character-loop.mp4', image: baseImages.tiktokLoop, path: join(assets.dirs.tiktokDir, 'tiktok-character-loop.mp4'), durationOverride: Math.min(10, hook.hook_duration_sec || 10) },
  ];

  for (const video of videos) {
    const result = await renderMp4({ imagePath: video.image, audioPath, outputPath: video.path, hook, durationOverride: video.durationOverride });
    if (result.skipped) {
      skipped.push({ name: video.name, reason: result.reason });
      continue;
    }
    generated.push({ platform: video.path.includes('/tiktok/') ? 'tiktok' : 'instagram', type: 'video', name: video.name, path: video.path });
  }

  return { generated, skipped };
}
