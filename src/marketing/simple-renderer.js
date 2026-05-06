/**
 * Compact deterministic renderer for social release packs.
 * Final text is drawn in code so platform assets never rely on AI-rendered words.
 */

import fs from 'fs';
import { dirname, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createCanvas, loadImage } from 'canvas';
import { loadBrandProfile } from '../shared/brand-profile.js';

const execFileAsync = promisify(execFile);
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name || 'Music Pipeline';
const PALETTE = BRAND_PROFILE.visual_style?.color_palette || {};
const INK = PALETTE.text_outline || PALETTE.dark || '#1F1A17';
const BACKGROUND = PALETTE.background || PALETTE.light || '#F8FAFC';
const BACKGROUND_ALT = PALETTE.background_alt || PALETTE.secondary || '#E0F2FE';
const ACCENT = PALETTE.primary || '#0EA5E9';
const ACCENT_DARK = PALETTE.accent_dark || PALETTE.dark || '#155E75';
const HIGHLIGHT = PALETTE.highlight || PALETTE.secondary || '#F59E0B';
const BUTTON = PALETTE.button || PALETTE.accent || '#EA580C';

async function commandWorks(command) {
  try { await execFileAsync(command, ['-version'], { timeout: 5000 }); return true; }
  catch { return false; }
}

function clean(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^[A-Za-z ]+:\s+/gm, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitFont(ctx, text, width, start, min = 30) {
  let size = start;
  while (size > min) {
    ctx.font = `900 ${size}px Arial, Helvetica, sans-serif`;
    if (ctx.measureText(clean(text)).width <= width) break;
    size -= 4;
  }
  ctx.font = `900 ${size}px Arial, Helvetica, sans-serif`;
}

function outline(ctx, text, x, y, fill = '#FFFFFF', stroke = INK, width = 10) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.strokeText(clean(text), x, y);
  ctx.fillStyle = fill;
  ctx.fillText(clean(text), x, y);
  ctx.restore();
}

function wrap(text, max = 18, maxLines = 3) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) { lines.push(line); line = word; }
    else line = next;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.length ? lines : [BRAND_NAME];
}

function brandHeadline() {
  const words = clean(BRAND_NAME).split(' ').filter(Boolean);
  if (words.length <= 2) return words.length ? words : ['NEW', 'MUSIC'];
  return wrap(BRAND_NAME, 14, 2);
}

async function drawContain(ctx, imagePath, x, y, w, h) {
  if (!imagePath || !fs.existsSync(imagePath)) return false;
  try {
    const img = await loadImage(imagePath);
    const scale = Math.min(w / img.width, h / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
    ctx.restore();
    return true;
  } catch { return false; }
}

async function drawCover(ctx, imagePath, w, h) {
  if (!imagePath || !fs.existsSync(imagePath)) return;
  try {
    const img = await loadImage(imagePath);
    const scale = Math.max(w / img.width, h / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
    ctx.restore();
  } catch {}
}

async function drawFullBleed(ctx, imagePath, w, h, alpha = 1.0) {
  if (!imagePath || !fs.existsSync(imagePath)) return false;
  try {
    const img = await loadImage(imagePath);
    const scale = Math.max(w / img.width, h / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
    ctx.restore();
    return true;
  } catch { return false; }
}

function drawHandlePill(ctx, assets, w, h, safeFraction = 0.08) {
  const fh = h * 0.052, fw = w * 0.72, fx = (w - fw) / 2;
  const fy = h - h * safeFraction - fh;
  ctx.fillStyle = ACCENT_DARK;
  roundRect(ctx, fx, fy, fw, fh, fh / 2);
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitFont(ctx, assets.handle, fw - 60, fh * 0.48, 22);
  ctx.fillText(clean(assets.handle), w / 2, fy + fh / 2 + 2);
}

async function drawFullBleedHero(ctx, assets, baseImagePath, w, h, headline, subhead) {
  const SAFE = 0.08;
  await drawFullBleed(ctx, baseImagePath, w, h, 0.85);
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.75);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.72)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  const lines = Array.isArray(headline) ? headline : wrap(headline, 12, 2);
  let y = h * SAFE + w * 0.14;
  for (const line of lines) {
    fitFont(ctx, line.toUpperCase(), w * (1 - 2 * SAFE), w * 0.16, 56);
    outline(ctx, line.toUpperCase(), w / 2, y, '#FFFFFF', INK, w * 0.015);
    y += w * 0.155;
  }
  drawHandlePill(ctx, assets, w, h, SAFE);
}

async function drawLyricsCard(ctx, assets, baseImagePath, w, h, headline, lyricText) {
  const SAFE = 0.08;
  await drawFullBleed(ctx, baseImagePath, w, h, 0.5);
  const cardW = w * 0.70, cardH = h * 0.26;
  const cardX = (w - cardW) / 2, cardY = h * 0.37;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.fill();
  const titleText = clean(Array.isArray(headline) ? headline[0] : headline) || assets.title;
  fitFont(ctx, titleText, w * (1 - 2 * SAFE), w * 0.065, 28);
  outline(ctx, titleText, w / 2, cardY - w * 0.04, '#FFFFFF', INK, 6);
  const lines = wrap(lyricText || assets.title, 23, 3);
  const lh = cardH / (lines.length + 1);
  for (let i = 0; i < lines.length; i++) {
    fitFont(ctx, lines[i], cardW - 40, cardH * 0.24, 26);
    outline(ctx, lines[i], w / 2, cardY + lh * (i + 1), '#FFFFFF', INK, 5);
  }
  drawHandlePill(ctx, assets, w, h, SAFE);
}

async function drawCharacterHero(ctx, assets, baseImagePath, w, h, headline) {
  const SAFE = 0.08;
  await drawFullBleed(ctx, baseImagePath, w, h, 1.0);
  const gradStart = h * 0.65;
  const grad = ctx.createLinearGradient(0, gradStart, 0, h);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.88)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradStart, w, h - gradStart);
  const lines = Array.isArray(headline) ? headline : wrap(headline, 14, 2);
  let y = h * 0.72;
  for (const line of lines) {
    fitFont(ctx, line.toUpperCase(), w * (1 - 2 * SAFE), w * 0.10, 36);
    outline(ctx, line.toUpperCase(), w / 2, y, '#FFFFFF', INK, w * 0.012);
    y += w * 0.105;
  }
  drawHandlePill(ctx, assets, w, h, SAFE);
}

async function drawStoryCTA(ctx, assets, baseImagePath, w, h, headline, subhead) {
  const SAFE = 0.08;
  const splitY = h * 0.60;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, splitY);
  ctx.clip();
  await drawFullBleed(ctx, baseImagePath, w, splitY, 1.0);
  ctx.restore();
  const grad = ctx.createLinearGradient(0, splitY, 0, h);
  grad.addColorStop(0, 'rgba(15,15,15,0.93)');
  grad.addColorStop(1, 'rgba(15,15,15,1.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, splitY, w, h - splitY);
  const lines = Array.isArray(headline) ? headline : ['NEW SONG', 'OUT NOW'];
  let y = splitY + h * 0.075;
  for (const line of lines) {
    fitFont(ctx, line.toUpperCase(), w * (1 - 2 * SAFE), w * 0.13, 48);
    outline(ctx, line.toUpperCase(), w / 2, y, '#FFFFFF', INK, w * 0.013);
    y += w * 0.135;
  }
  if (subhead) {
    const bh = h * 0.055, bw = w * 0.68, bx = (w - bw) / 2, by = h * 0.82;
    ctx.fillStyle = BUTTON;
    roundRect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, subhead, bw - 40, bh * 0.50, 22);
    ctx.fillText(clean(subhead), w / 2, by + bh / 2 + 2);
  }
  drawHandlePill(ctx, assets, w, h, SAFE);
}

async function poster({ assets, outputPath, width, height, headline, subhead, lyricText, platform, baseImagePath, layout }) {
  fs.mkdirSync(dirname(outputPath), { recursive: true });
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const assetName = outputPath.split('/').pop().replace(/\.[^.]+$/, '');
  console.log(`[RENDERER] ${assetName}: rendering with ${baseImagePath || '(no base image)'}`);

  if (baseImagePath && layout && layout !== 'default') {
    if (layout === 'fullBleedHero') await drawFullBleedHero(ctx, assets, baseImagePath, width, height, headline, subhead);
    else if (layout === 'lyricsCard') await drawLyricsCard(ctx, assets, baseImagePath, width, height, headline, lyricText);
    else if (layout === 'characterHero') await drawCharacterHero(ctx, assets, baseImagePath, width, height, headline);
    else if (layout === 'storyCTA') await drawStoryCTA(ctx, assets, baseImagePath, width, height, headline, subhead);
  } else {
    // Original card layout — used for static images and when no base image is available
    const cover = assets.source.copiedCover || assets.source.coverPath;
    const character = assets.source.copiedCharacter || assets.source.characterPath || cover;

    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, BACKGROUND);
    grad.addColorStop(1, BACKGROUND_ALT);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    await drawCover(ctx, cover, width, height);

    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(width / 2, height * 0.49, Math.min(width * 0.43, height * 0.30), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(8, width * 0.014);
    ctx.stroke();

    let y = height * 0.08;
    for (const line of Array.isArray(headline) ? headline : wrap(headline)) {
      fitFont(ctx, line.toUpperCase(), width * 0.88, width * 0.145, 40);
      outline(ctx, line.toUpperCase(), width / 2, y, line.toLowerCase().includes('new') ? HIGHLIGHT : '#FFFFFF', INK, width * 0.012);
      y += width * 0.13;
    }

    if (subhead) {
      const ph = height * 0.052;
      const pw = width * 0.68;
      const px = (width - pw) / 2;
      const py = height * 0.245;
      ctx.fillStyle = BUTTON;
      roundRect(ctx, px, py, pw, ph, ph / 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fitFont(ctx, subhead, pw - 50, ph * 0.48, 22);
      ctx.fillText(clean(subhead), width / 2, py + ph / 2 + 2);
    }

    const drew = await drawContain(ctx, character, width * 0.08, height * 0.33, width * 0.84, height * 0.48);
    if (!drew) {
      ctx.fillStyle = '#FFFFFF';
      roundRect(ctx, width * 0.18, height * 0.39, width * 0.64, height * 0.18, 34);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 8;
      ctx.stroke();
      fitFont(ctx, BRAND_NAME, width * 0.52, width * 0.065, 26);
      ctx.fillStyle = INK;
      ctx.fillText(BRAND_NAME, width / 2, height * 0.49);
    }

    if (lyricText) {
      const bx = width * 0.08, by = height * 0.63, bw = width * 0.84, bh = height * 0.16;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      roundRect(ctx, bx, by, bw, bh, 32);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 6;
      ctx.stroke();
      const lines = wrap(lyricText, 23, 3);
      const lh = width * 0.065;
      const sy = by + bh / 2 - ((lines.length - 1) * lh / 2);
      for (let i = 0; i < lines.length; i++) {
        fitFont(ctx, lines[i], bw - 60, width * 0.058, 30);
        outline(ctx, lines[i], width / 2, sy + i * lh, ACCENT_DARK, '#FFFFFF', 5);
      }
    }

    const fh = height * 0.052, fw = width * 0.72, fx = (width - fw) / 2, fy = height - height * 0.115;
    ctx.fillStyle = ACCENT_DARK;
    roundRect(ctx, fx, fy, fw, fh, fh / 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, assets.handle, fw - 60, fh * 0.48, 22);
    ctx.fillText(clean(assets.handle), width / 2, fy + fh / 2 + 2);
  }

  const out = fs.createWriteStream(outputPath);
  const stream = /\.jpe?g$/i.test(outputPath) ? canvas.createJPEGStream({ quality: 0.94 }) : canvas.createPNGStream();
  await new Promise((resolve, reject) => {
    stream.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

async function mp4({ imagePath, audioPath, outputPath, hook, durationOverride }) {
  if (!audioPath || !fs.existsSync(audioPath)) return { skipped: true, reason: 'missing_audio' };
  if (!await commandWorks('ffmpeg')) return { skipped: true, reason: 'ffmpeg_not_found' };
  const duration = durationOverride || hook.hook_duration_sec || 15;
  const start = hook.hook_start_sec || 0;
  const frames = Math.round(duration * 30);
  fs.mkdirSync(dirname(outputPath), { recursive: true });
  // Scale to 20% larger than output to give zoompan room, then gently zoom in over the clip duration
  const vf = `scale=1296:2304:force_original_aspect_ratio=increase,crop=1296:2304,zoompan=z='min(pzoom+0.0002,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30,format=yuv420p`;
  try {
    await execFileAsync('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', imagePath, '-ss', String(start), '-t', String(duration), '-i', audioPath, '-t', String(duration), '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', outputPath], { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
    return { skipped: false, path: outputPath };
  } catch (err) {
    return { skipped: true, reason: `ffmpeg_failed: ${err.message}` };
  }
}

function firstLyric(lyrics, fallback) {
  return String(lyrics || '').split(/\r?\n/).map(v => v.trim()).filter(v => v.length >= 8 && !/^\[/.test(v))[0] || fallback;
}

export async function renderMarketingAssets(assets, hook) {
  const audioPath = assets.source.copiedAudio || assets.source.audioPath;
  const lyric = firstLyric(assets.lyricsClean, assets.title);
  const generated = [];
  const skipped = [];
  const work = assets.dirs.workingDir;
  const profileHeadline = brandHeadline();

  // Resolve base image: prefer uploaded base image, fall back to cover art
  let baseImagePath = null;
  if (assets.baseImagePath) {
    if (!fs.existsSync(assets.baseImagePath)) {
      throw new Error(`[RENDERER] Base image file not found: ${assets.baseImagePath}`);
    }
    baseImagePath = assets.baseImagePath;
    console.log(`[RENDERER] Resolved base image: ${baseImagePath} (source: uploaded)`);
  } else {
    baseImagePath = assets.source.copiedCover || assets.source.coverPath || assets.source.copiedBrandFallback || assets.source.brandFallbackPath || null;
    console.log(`[RENDERER] Resolved base image: ${baseImagePath || 'none'} (source: cover-art-fallback)`);
  }

  const jobs = [
    ['igHook',      join(work, 'ig-reel-hook-base.jpg'),      1080, 1920, ['LISTEN', 'EVERYWHERE'],   'link in bio',       null,  'instagram', 'fullBleedHero'],
    ['igLyrics',    join(work, 'ig-reel-lyrics-base.jpg'),    1080, 1920, [assets.title],              'new release',       lyric, 'instagram', 'lyricsCard'],
    ['igCharacter', join(work, 'ig-reel-character-base.jpg'), 1080, 1920, profileHeadline,             'new music',         null,  'instagram', 'characterHero'],
    ['igStory',     join(work, 'ig-story-base.jpg'),          1080, 1920, ['NEW SONG', 'OUT NOW'],     'tap link in bio',   null,  'instagram', 'storyCTA'],
    ['tiktokHook',  join(work, 'tiktok-hook-base.jpg'),       1080, 1920, ['NEW SONG', 'OUT NOW'],     'listen now',        null,  'tiktok',    'fullBleedHero'],
    ['tiktokLyrics',join(work, 'tiktok-lyrics-base.jpg'),    1080, 1920, [assets.title],              'new release',       lyric, 'tiktok',    'lyricsCard'],
    ['tiktokLoop',  join(work, 'tiktok-loop-base.jpg'),       1080, 1920, profileHeadline,             'official sound',    null,  'tiktok',    'characterHero'],
    ['ig-feed-announcement-1080x1350.png', join(assets.dirs.instagramDir, 'ig-feed-announcement-1080x1350.png'), 1080, 1350, ['NEW SONG', 'OUT NOW'], 'Listen everywhere', null, 'instagram', 'fullBleedHero'],
    ['ig-square-post-1080x1080.png',       join(assets.dirs.instagramDir, 'ig-square-post-1080x1080.png'),       1080, 1080, profileHeadline,         null,                null, 'instagram', 'characterHero'],
    ['outreach-hero-1600x900.png',         join(assets.outputDir, 'outreach-hero-1600x900.png'),                 1600, 900, [assets.artist],           assets.title,        null, 'press',     'fullBleedHero'],
    ['no-text-variation.png',              join(assets.outputDir, 'no-text-variation.png'),                      1080, 1080, [],                       null,                null, 'press',     'fullBleedHero'],
    ['ig-reel-cover.jpg',                  join(assets.dirs.instagramDir, 'ig-reel-cover.jpg'),                  1080, 1920, ['NEW SONG', 'OUT NOW'], 'Link in bio',       null, 'instagram', 'storyCTA'],
    ['tiktok-cover.jpg',                   join(assets.dirs.tiktokDir,    'tiktok-cover.jpg'),                   1080, 1920, ['NEW SONG', 'OUT NOW'], 'Link in bio',       null, 'tiktok',    'storyCTA'],
  ];
  const requestedFormats = new Set((assets.requestedFormats || []).map(value => String(value).trim()).filter(Boolean));
  const filteredJobs = requestedFormats.size
    ? jobs.filter(([name]) => requestedFormats.has(name))
    : jobs;

  const map = {};
  for (const [name, path, width, height, headline, subhead, lyricText, platform, layout] of filteredJobs) {
    await poster({ assets, outputPath: path, width, height, headline, subhead, lyricText, platform, baseImagePath, layout });
    map[name] = path;
    if (/\.(png|jpe?g)$/i.test(name)) generated.push({ platform, type: 'image', name, path });
  }

  const videos = [
    ['ig-reel-hook.mp4', 'instagram', map.igHook, join(assets.dirs.instagramDir, 'ig-reel-hook.mp4')],
    ['ig-reel-lyrics.mp4', 'instagram', map.igLyrics, join(assets.dirs.instagramDir, 'ig-reel-lyrics.mp4')],
    ['ig-reel-character.mp4', 'instagram', map.igCharacter, join(assets.dirs.instagramDir, 'ig-reel-character.mp4')],
    ['ig-story-new-song.mp4', 'instagram', map.igStory, join(assets.dirs.instagramDir, 'ig-story-new-song.mp4')],
    ['tiktok-hook.mp4', 'tiktok', map.tiktokHook, join(assets.dirs.tiktokDir, 'tiktok-hook.mp4')],
    ['tiktok-lyric-karaoke.mp4', 'tiktok', map.tiktokLyrics, join(assets.dirs.tiktokDir, 'tiktok-lyric-karaoke.mp4')],
    ['tiktok-character-loop.mp4', 'tiktok', map.tiktokLoop, join(assets.dirs.tiktokDir, 'tiktok-character-loop.mp4'), Math.min(10, hook.hook_duration_sec || 10)],
  ];

  for (const [name, platform, imagePath, outputPath, durationOverride] of videos.filter(([name]) => !requestedFormats.size || requestedFormats.has(name))) {
    const result = await mp4({ imagePath, audioPath, outputPath, hook, durationOverride });
    if (result.skipped) skipped.push({ name, reason: result.reason });
    else generated.push({ platform, type: 'video', name, path: outputPath });
  }

  return { generated, skipped };
}
