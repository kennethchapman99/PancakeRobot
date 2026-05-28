import { join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function buildDistroKidUploadInvocation({
  manifestPath,
  mode = 'preview',
  interactivePreview = false,
  authConfirmed = false,
  artworkPath = '',
} = {}) {
  const resolvedMode = mode === 'live' ? 'live' : 'preview';
  const args = [
    join(REPO_ROOT, 'scripts/distrokid/upload-release.mjs'),
    '--manifest',
    manifestPath,
  ];
  if (artworkPath) args.push('--artwork-path', artworkPath);
  if (!(interactivePreview && !authConfirmed && resolvedMode === 'preview')) args.push('--no-pause');
  if (resolvedMode === 'live') args.push('--live-submit', '--confirm-live-submit');
  else args.push('--dry-run');
  return {
    args,
    authConfirmed,
    interactivePreview,
    command: `${process.execPath} ${args.map(arg => String(arg).includes(' ') ? JSON.stringify(arg) : arg).join(' ')}`,
  };
}
