/**
 * Lightweight hook finder for social clips.
 * Starts deterministic, then can be upgraded with beat/chorus analysis later.
 */

import fs from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function commandWorks(command, args = ['-version']) {
  try {
    await execFileAsync(command, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function getAudioDurationSeconds(audioPath) {
  if (!audioPath || !await commandWorks('ffprobe')) return null;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ], { timeout: 10000 });
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function findMarketingHook(assets, options = {}) {
  const metadata = assets.metadata || {};
  const defaultDuration = Number(options.durationSec || process.env.MARKETING_HOOK_SECONDS || 15);
  const minDuration = Number(options.minDurationSec || 8);
  const maxDuration = Number(options.maxDurationSec || 20);

  let start = firstNumber(
    metadata.hook_start_sec,
    metadata.social_hook_start_sec,
    metadata.chorus_start_sec,
    metadata.vocals_start_sec,
    0
  );
  let duration = firstNumber(
    metadata.hook_duration_sec,
    metadata.social_hook_duration_sec,
    defaultDuration
  );

  start = Math.max(0, start || 0);
  duration = Math.min(maxDuration, Math.max(minDuration, duration || defaultDuration));

  const audioDuration = await getAudioDurationSeconds(assets.source.audioPath);
  const warnings = [];

  if (!assets.source.audioPath) {
    warnings.push('No final audio found yet. Video MP4 exports will be skipped until audio exists.');
  }

  if (audioDuration) {
    if (start >= audioDuration) start = 0;
    if (start + duration > audioDuration) {
      duration = Math.max(3, audioDuration - start);
    }
    if (duration < minDuration && audioDuration >= minDuration) {
      start = Math.max(0, audioDuration - minDuration);
      duration = minDuration;
    }
  }

  const hook = {
    hook_start_sec: Number(start.toFixed(2)),
    hook_end_sec: Number((start + duration).toFixed(2)),
    hook_duration_sec: Number(duration.toFixed(2)),
    source: metadata.hook_start_sec || metadata.social_hook_start_sec || metadata.chorus_start_sec ? 'metadata' : 'default',
    audio_duration_sec: audioDuration ? Number(audioDuration.toFixed(2)) : null,
    rationale: metadata.hook_start_sec || metadata.social_hook_start_sec || metadata.chorus_start_sec
      ? 'Used available metadata hook/chorus timing.'
      : 'Defaulted to the first social-ready clip window. Upgrade later with chorus/beat detection.',
    warnings,
  };

  fs.mkdirSync(assets.dirs.workingDir, { recursive: true });
  fs.writeFileSync(join(assets.dirs.workingDir, 'hook.json'), JSON.stringify(hook, null, 2));

  return hook;
}
