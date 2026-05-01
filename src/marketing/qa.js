/**
 * QA checks for generated social marketing packs.
 */

import fs from 'fs';
import { basename, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REQUIRED_IMAGES = [
  'instagram/ig-feed-announcement-1080x1350.png',
  'instagram/ig-square-post-1080x1080.png',
  'instagram/ig-reel-cover.jpg',
  'tiktok/tiktok-cover.jpg',
];

const EXPECTED_VIDEOS = [
  'instagram/ig-reel-hook.mp4',
  'instagram/ig-reel-lyrics.mp4',
  'instagram/ig-reel-character.mp4',
  'instagram/ig-story-new-song.mp4',
  'tiktok/tiktok-hook.mp4',
  'tiktok/tiktok-lyric-karaoke.mp4',
  'tiktok/tiktok-character-loop.mp4',
];

function exists(path) {
  return path && fs.existsSync(path);
}

function fileSize(path) {
  try { return fs.statSync(path).size; } catch { return 0; }
}

function pngDimensions(path) {
  if (!exists(path)) return null;
  const buf = fs.readFileSync(path);
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(path) {
  if (!exists(path)) return null;
  const buf = fs.readFileSync(path);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    const length = buf.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function imageDimensions(path) {
  if (/\.png$/i.test(path)) return pngDimensions(path);
  if (/\.jpe?g$/i.test(path)) return jpegDimensions(path);
  return null;
}

async function hasCommand(command) {
  try {
    await execFileAsync(command, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function probeVideo(path) {
  if (!exists(path) || !await hasCommand('ffprobe')) return null;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      path,
    ], { timeout: 10000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function containsForbiddenCopy(text) {
  const patterns = [
    /\[[^\]]+\]/,
    /\*[^*]+\*/,
    /\b(vocals start|music slows|sfx|sound effect|spoken|stage direction)\b/i,
    /```/,
  ];
  return patterns.some(pattern => pattern.test(text || ''));
}

export async function runMarketingQA(assets, renderResult, hook, captionResult) {
  const failures = [];
  const warnings = [];
  const checks = [];

  const pass = (check, detail = '') => checks.push({ check, passed: true, detail });
  const fail = (check, detail = '') => { failures.push(`${check}: ${detail}`); checks.push({ check, passed: false, detail }); };
  const warn = (check, detail = '') => { warnings.push(`${check}: ${detail}`); checks.push({ check, passed: true, warning: detail }); };

  if (!assets.title) fail('Title', 'missing title'); else pass('Title', assets.title);
  if (assets.handle !== '@pancakerobotmusic') warn('Handle', `Using ${assets.handle}; expected @pancakerobotmusic`); else pass('Handle', assets.handle);

  if (!assets.source.audioPath) warn('Audio', 'No final audio found. Static images were generated; MP4 exports are skipped until audio exists.');
  else pass('Audio', basename(assets.source.audioPath));

  if (!assets.source.coverPath) warn('Cover art', 'No cover art found. Renderer will use fallback layout.');
  else pass('Cover art', basename(assets.source.coverPath));

  for (const relPath of REQUIRED_IMAGES) {
    const fullPath = join(assets.outputDir, relPath);
    if (!exists(fullPath)) {
      fail('Required image', `${relPath} missing`);
      continue;
    }
    const dims = imageDimensions(fullPath);
    if (!dims) fail('Required image', `${relPath} has unreadable dimensions`);
    else pass('Required image', `${relPath} ${dims.width}x${dims.height}`);
    if (fileSize(fullPath) < 20 * 1024) warn('Image size', `${relPath} is very small (${fileSize(fullPath)} bytes)`);
  }

  for (const relPath of EXPECTED_VIDEOS) {
    const fullPath = join(assets.outputDir, relPath);
    if (!exists(fullPath)) {
      const skipped = renderResult.skipped?.find(item => item.name === basename(relPath));
      if (assets.source.audioPath) fail('Expected video', `${relPath} missing${skipped ? ` (${skipped.reason})` : ''}`);
      else warn('Expected video', `${relPath} skipped until audio exists`);
      continue;
    }
    const probe = await probeVideo(fullPath);
    const stream = probe?.streams?.[0];
    if (stream && (Number(stream.width) !== 1080 || Number(stream.height) !== 1920)) {
      fail('Video dimensions', `${relPath} is ${stream.width}x${stream.height}, expected 1080x1920`);
    } else if (stream) {
      pass('Video dimensions', `${relPath} 1080x1920`);
    } else {
      warn('Video dimensions', `${relPath} created, ffprobe unavailable or failed`);
    }
  }

  if (hook.hook_start_sec > 1) warn('Hook timing', `Hook starts at ${hook.hook_start_sec}s. First version should usually start immediately.`);
  else pass('Hook timing', `Starts at ${hook.hook_start_sec}s`);

  const allCaptions = [
    ...(captionResult.instagram || []),
    ...(captionResult.tiktok || []),
    ...Object.values(captionResult.variants || {}),
  ].join('\n');
  if (containsForbiddenCopy(allCaptions)) fail('Captions', 'Captions contain forbidden prompt/markdown artifacts.');
  else pass('Captions', 'No bracketed directions, markdown artifacts, or production cues found.');

  const report = {
    song_id: assets.songId,
    generated_at: new Date().toISOString(),
    passed: failures.length === 0,
    failures,
    warnings,
    checks,
  };

  fs.writeFileSync(join(assets.outputDir, 'marketing-qa-report.json'), JSON.stringify(report, null, 2));
  return report;
}
