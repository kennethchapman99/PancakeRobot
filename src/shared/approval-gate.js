/**
 * Human approval gate — shows full QA results before asking for human decision.
 * Pipeline must pass all QA checks before the human is even asked.
 *
 * When WEB_PIPELINE=1 env var is set (web-triggered runs), the gate is bypassed
 * and auto-approves so the web UI can handle the real approval on the song detail page.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Present QA results + song info, then ask human to approve/reject/revise.
 * Throws if QA has failures (pipeline should not reach this point with failures,
 * but this is a second safety net).
 */
export async function approveSong({
  songId, title, topic, brandScore, costUsd,
  lyricsPath, audioPromptPath, qaReport, songDir,
}) {
  // Web pipeline mode: auto-approve so all assets are generated, UI handles real approval
  if (process.env.WEB_PIPELINE === '1') {
    console.log('\n[WEB] Auto-approving — review the song in the web UI at /songs/' + songId);
    return { decision: 'yes' };
  }

  const resolvedSongDir = songDir || join(__dirname, `../../output/songs/${songId}`);

  console.log('\n' + chalk.bgCyan.black(' PANCAKE ROBOT — FINAL SONG REVIEW '));
  console.log('');

  // ── QA Results ────────────────────────────────────────────
  console.log(chalk.bold('  Quality Checks:'));
  if (qaReport?.checks) {
    for (const c of qaReport.checks) {
      const icon = c.passed
        ? (c.warning ? chalk.yellow('  ⚠') : chalk.green('  ✓'))
        : chalk.red('  ✗');
      const label = c.passed
        ? (c.warning ? chalk.yellow(c.check) : chalk.green(c.check))
        : chalk.red(c.check);
      const detail = c.detail || c.warning || '';
      console.log(`${icon} ${label}${detail ? chalk.dim(' — ' + detail) : ''}`);
    }
  }

  // Hard block — don't ask human if QA failed
  if (qaReport?.failures?.length > 0) {
    console.log('');
    console.log(chalk.red.bold('  ✗ QA FAILED — pipeline cannot proceed to human review'));
    for (const f of qaReport.failures) {
      console.log(chalk.red(`    • ${f}`));
    }
    console.log('');
    throw new Error(`QA failed with ${qaReport.failures.length} issue(s). Fix above and re-run.`);
  }

  console.log('');

  // ── Song Info ─────────────────────────────────────────────
  console.log(chalk.cyan('  ┌─────────────────────────────────────────┐'));
  console.log(chalk.cyan('  │') + chalk.bold(`  ${title || 'Untitled'}`.substring(0, 43).padEnd(43)) + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + `  Topic:  ${(topic || '').substring(0, 34)}`.padEnd(45) + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + `  Brand:  ${brandScore || '?'}/100  |  Cost: $${(costUsd || 0).toFixed(4)}`.padEnd(45) + chalk.cyan('│'));

  // Audio file info
  const audioDir = join(resolvedSongDir, 'audio');
  let audioInfo = 'not found';
  const checkAudio = (p) => fs.existsSync(p) ? `${p.split('/').pop()} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)` : null;
  audioInfo = checkAudio(join(resolvedSongDir, 'audio.mp3'))
    || checkAudio(join(resolvedSongDir, 'audio.wav'))
    || (fs.existsSync(audioDir) && fs.readdirSync(audioDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'))
        .map(f => checkAudio(join(audioDir, f))).find(Boolean))
    || 'not found';
  console.log(chalk.cyan('  │') + `  Audio:  ${audioInfo.substring(0, 34)}`.padEnd(45) + chalk.cyan('│'));

  // Thumbnail info
  const thumbDir = join(resolvedSongDir, 'thumbnails');
  const finalPngs = fs.existsSync(thumbDir)
    ? fs.readdirSync(thumbDir).filter(f => f.endsWith('-final.png'))
    : [];
  const thumbInfo = finalPngs.length > 0
    ? `${finalPngs.length} final PNG(s) with title text`
    : 'no thumbnails';
  console.log(chalk.cyan('  │') + `  Thumbs: ${thumbInfo.substring(0, 34)}`.padEnd(45) + chalk.cyan('│'));
  console.log(chalk.cyan('  └─────────────────────────────────────────┘'));
  console.log('');

  // ── Lyrics preview (auto-shown, no prompt needed) ─────────
  if (lyricsPath && fs.existsSync(lyricsPath)) {
    const lyrics = fs.readFileSync(lyricsPath, 'utf8');
    // Show the chorus for quick review
    const chorusMatch = lyrics.match(/\[CHORUS\]([\s\S]*?)(\[|$)/);
    if (chorusMatch) {
      console.log(chalk.green('  ── CHORUS ──────────────────────────────────'));
      console.log(chorusMatch[1].trim().split('\n').map(l => `  ${l}`).join('\n'));
      console.log(chalk.green('  ────────────────────────────────────────────'));
      console.log('');
    }

    const { previewFull } = await inquirer.prompt([
      { type: 'confirm', name: 'previewFull', message: 'Show full lyrics?', default: false },
    ]);
    if (previewFull) {
      console.log('\n' + chalk.green('  ── FULL LYRICS ─────────────────────────────'));
      console.log(lyrics.substring(0, 3000).split('\n').map(l => `  ${l}`).join('\n'));
      if (lyrics.length > 3000) console.log(chalk.dim('  ... (truncated)'));
      console.log(chalk.green('  ────────────────────────────────────────────\n'));
    }
  }

  // ── Decision ──────────────────────────────────────────────
  const { decision } = await inquirer.prompt([
    {
      type: 'list',
      name: 'decision',
      message: chalk.bold('All checks passed. APPROVE this song for distribution?'),
      choices: [
        { name: '✓ Yes — approve and build distribution package', value: 'yes' },
        { name: '↺ Revise — send back to lyricist with notes', value: 'revise' },
        { name: '✗ No — reject this song', value: 'no' },
      ],
    },
  ]);

  if (decision === 'revise') {
    const { notes } = await inquirer.prompt([
      { type: 'input', name: 'notes', message: 'Revision notes (what needs to change):' },
    ]);
    return { decision: 'revise', notes };
  }

  if (decision === 'no') {
    const { reason } = await inquirer.prompt([
      { type: 'input', name: 'reason', message: 'Rejection reason (optional):' },
    ]);
    return { decision: 'no', reason };
  }

  return { decision: 'yes' };
}
