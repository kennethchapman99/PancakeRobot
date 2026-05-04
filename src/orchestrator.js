/**
 * Music Pipeline — Master Orchestrator
 *
 * Commands:
 *   node src/orchestrator.js --setup                         First-time setup
 *   node src/orchestrator.js --new "topic: ..."              Full pipeline for new song
 *   node src/orchestrator.js --research                      Research only
 *   node src/orchestrator.js --report                        Financial report
 *   node src/orchestrator.js --approve <song-id>             Approve a song
 *   node src/orchestrator.js --reject <song-id> "reason"     Reject a song
 *   node src/orchestrator.js --suggest                       Suggest next song topic
 *   node src/orchestrator.js --schedule                      Start recurring scheduler
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../.env'), override: true });

import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';

import { upsertSong, getSong, getAllSongs } from './shared/db.js';
import { approveSong } from './shared/approval-gate.js';
import { formatCost } from './shared/costs.js';
import { loadBrandProfile } from './shared/brand-profile.js';
import { runSuggestPipeline } from './shared/suggest.js';

import { runResearcher, loadResearchReport } from './agents/researcher.js';
import { buildBrand, reviewSong, loadBrandBible } from './agents/brand-manager.js';
import { writeLyrics } from './agents/lyricist.js';
import { researchDistribution, generateMetadata } from './agents/product-manager.js';
import { researchServices, updateFinancialReport, generateFullReport } from './agents/financial-manager.js';
import { generateThumbnails } from './agents/creative-manager.js';
import { runQAChecklist, generateHumanTasks, startScheduler } from './agents/ops-manager.js';
import { generateMusic } from './agents/music-generator.js';

const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const APP_TITLE = BRAND_PROFILE.app_title || BRAND_NAME;
const AUDIENCE_DESCRIPTION = BRAND_PROFILE.audience.description;
const DEFAULT_DISTRIBUTOR = BRAND_PROFILE.distribution.default_distributor;

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function generateSongId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SONG_${ts}_${rand}`;
}

function printBanner() {
  console.log(chalk.bgYellow.black('\n ══════════════════════════════════════════ '));
  console.log(chalk.bgYellow.black(` ${APP_TITLE.toUpperCase()} — Autonomous Music Pipeline `));
  console.log(chalk.bgYellow.black(' ══════════════════════════════════════════ \n'));
}

function printUsage() {
  console.log(chalk.bold('Usage:'));
  console.log('  node src/orchestrator.js --setup                       First-time setup');
  console.log('  node src/orchestrator.js --new "song topic here"       New song pipeline');
  console.log('  node src/orchestrator.js --research                    Run researcher only');
  console.log('  node src/orchestrator.js --report                      Generate financial report');
  console.log('  node src/orchestrator.js --approve <song-id>           Approve a song');
  console.log('  node src/orchestrator.js --reject <song-id> "reason"   Reject a song');
  console.log('  node src/orchestrator.js --suggest                     Suggest next song topic');
  console.log('  node src/orchestrator.js --schedule                    Start recurring scheduler');
  console.log('  node src/orchestrator.js --list                        List all songs');
  console.log('');
}

function validateEnv() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red('ERROR: ANTHROPIC_API_KEY not set in .env'));
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
    console.error(chalk.red('ERROR: ANTHROPIC_API_KEY looks invalid (should start with sk-ant-)'));
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// SETUP PIPELINE
// ─────────────────────────────────────────────────────────────

async function runSetup() {
  printBanner();
  console.log(chalk.bold.cyan('SETUP MODE — Building brand, research, and distribution config\n'));

  // Step 1: Research FIRST — brand builder will use these findings as context
  const researchPath = join(__dirname, '../output/research/research-report.json');
  const researchFresh = fs.existsSync(researchPath) && (() => {
    try {
      const r = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
      return (r.top_topics?.length > 0 || r.raw_text?.length > 200);
    } catch { return false; }
  })();
  if (researchFresh) {
    console.log(chalk.green('✓ Research already exists — skipping'));
  } else {
    console.log(chalk.bold(`\n📌 Step 1/4: Researching music trends for ${AUDIENCE_DESCRIPTION}...\n`));
    await runResearcher();
    console.log(chalk.green('\n✓ Research complete'));
  }

  // Step 2: Build optional human-readable brand bible from the active profile
  const brandBiblePath = join(__dirname, '../output/brand/brand-bible.md');
  const brandBibleExists = fs.existsSync(brandBiblePath) && fs.statSync(brandBiblePath).size > 500;
  if (brandBibleExists) {
    console.log(chalk.green('✓ Brand bible already exists — skipping brand bible builder'));
    console.log(chalk.dim('  (Active brand truth still comes from config/brand-profile*.json)\n'));
  } else {
    console.log(chalk.bold(`\n📌 Step 2/4: Building ${BRAND_NAME} brand bible from active profile...\n`));
    await buildBrand();
    console.log(chalk.green('\n✓ Brand created and saved'));
  }

  // Step 3: Distribution research
  const distPath = join(__dirname, '../output/distribution/distribution-research.json');
  const distFresh = fs.existsSync(distPath) && (() => {
    try {
      const d = JSON.parse(fs.readFileSync(distPath, 'utf8'));
      return !d.parse_error && !d.raw_text?.length === 0;
    } catch { return false; }
  })();
  if (distFresh) {
    console.log(chalk.green('✓ Distribution research already exists — skipping'));
  } else {
    console.log(chalk.bold('\n📌 Step 3/4: Researching distribution services...\n'));
    await new Promise(r => setTimeout(r, 3000));
    await researchDistribution();
    console.log(chalk.green('\n✓ Distribution research complete'));
  }

  // Step 4: Service cost research
  console.log(chalk.bold('\n📌 Step 4/4: Researching music generation services...\n'));
  await new Promise(r => setTimeout(r, 3000));
  await researchServices();
  console.log(chalk.green('\n✓ Service research complete'));

  // Generate initial financial report
  await generateFullReport();

  console.log(chalk.bgGreen.black('\n ✓ SETUP COMPLETE \n'));
  console.log('Next steps:');
  console.log('  1. Review output/brand/brand-bible.md');
  console.log('  2. Review output/research/research-report.json');
  console.log('  3. Review output/distribution/distribution-research.md');
  console.log('  4. Run: node src/orchestrator.js --new "song topic here"');
}

// ─────────────────────────────────────────────────────────────
// NEW SONG PIPELINE
// ─────────────────────────────────────────────────────────────

async function runNewSongPipeline(topic, existingSongId = null) {
  if (!topic) {
    console.error(chalk.red('ERROR: Please provide a topic: --new "your topic here"'));
    process.exit(1);
  }

  printBanner();
  console.log(chalk.bold.green(`NEW SONG PIPELINE — Topic: "${topic}"\n`));

  const songId = existingSongId || generateSongId();
  const songDir = join(__dirname, `../output/songs/${songId}`);
  fs.mkdirSync(songDir, { recursive: true });

  let totalCost = 0;

  // Initialize song in DB (upsert preserves existing fields when reusing an ID)
  upsertSong({
    id: songId,
    topic,
    status: 'draft',
    distributor: DEFAULT_DISTRIBUTOR,
    total_cost_usd: 0,
  });

  // ─────────────────────────────
  // 1. Load or refresh research
  // ─────────────────────────────
  let researchReport = loadResearchReport(30);
  if (!researchReport) {
    console.log(chalk.bold('\n📌 Step 1/8: Running researcher (research is >30 days old)...\n'));
    researchReport = await runResearcher();
  } else {
    console.log(chalk.green('✓ Using cached research report\n'));
  }

  // ─────────────────────────────
  // 2. Write lyrics (with revision loop)
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 2/8: Writing lyrics...\n'));

  let lyricsResult;
  let brandReview;
  let revisionNotes = null;
  const MAX_REVISIONS = 3;

  for (let attempt = 1; attempt <= MAX_REVISIONS; attempt++) {
    if (attempt > 1) {
      console.log(chalk.yellow(`\n↺ Revision attempt ${attempt}/${MAX_REVISIONS}...\n`));
    }

    lyricsResult = await writeLyrics({
      songId,
      topic,
      researchReport,
      revisionNotes,
    });
    totalCost += lyricsResult.costUsd || 0;

    // ─────────────────────────────
    // 3. Brand review
    // ─────────────────────────────
    console.log(chalk.bold(`\n📌 Step 3/8: Brand review (attempt ${attempt})...\n`));

    brandReview = await reviewSong({
      songId,
      title: lyricsResult.title,
      topic,
      lyricsText: lyricsResult.lyricsText,
      audioPromptText: lyricsResult.audioPromptText,
    });
    totalCost += brandReview.costUsd || 0;

    const score = brandReview.scores?.overall || 0;
    console.log(`\nBrand Score: ${chalk.bold(score)}/100`);

    if (score >= 75) {
      console.log(chalk.green('✓ Brand review passed'));
      break;
    } else if (attempt < MAX_REVISIONS) {
      console.log(chalk.yellow(`✗ Score ${score} < 75 — sending revision notes to lyricist`));
      revisionNotes = brandReview.revision_notes;
    } else {
      console.log(chalk.red(`✗ Score ${score} < 75 after ${MAX_REVISIONS} attempts — escalating to human`));
      console.log(chalk.red('\nBrand review failed repeatedly. Review manually:'));
      console.log(chalk.red(`  output/songs/${songId}/brand-review.json`));
      console.log(chalk.red('  You can still proceed — the song needs your judgment.'));
    }
  }

  // Update song record
  upsertSong({
    id: songId,
    topic,
    title: lyricsResult.title,
    status: 'draft',
    lyrics_path: lyricsResult.lyricsPath,
    audio_prompt_path: lyricsResult.audioPromptPath,
    brand_score: brandReview.scores?.overall,
    total_cost_usd: totalCost,
  });

  // ─────────────────────────────
  // 4. Generate metadata
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 4/8: Generating metadata...\n'));
  const { metadata, metadataPath } = await generateMetadata({
    songId,
    title: lyricsResult.title,
    topic,
    lyrics: lyricsResult.lyricsText,
    bpm: lyricsResult.songData?.audio_prompt?.tempo_bpm,
    researchReport,
  });

  upsertSong({
    id: songId,
    topic,
    title: lyricsResult.title,
    status: 'draft',
    lyrics_path: lyricsResult.lyricsPath,
    audio_prompt_path: lyricsResult.audioPromptPath,
    metadata_path: metadataPath,
    brand_score: brandReview.scores?.overall,
    total_cost_usd: totalCost,
  });

  // ─────────────────────────────
  // 5. Generate music
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 5/8: Generating music...\n'));
  const musicResult = await generateMusic({
    songId,
    title: lyricsResult.title,
    lyricsText: lyricsResult.lyricsText,
    audioPromptData: lyricsResult.songData?.audio_prompt,
  });

  if (musicResult.audioFiles?.length > 0) {
    console.log(chalk.green(`✓ Music generated: ${musicResult.audioFiles.length} version(s)`));
  } else if (musicResult.skipped || musicResult.apiError) {
    // Music generation skipped or API unavailable — manual instructions saved, pipeline continues
    console.log(chalk.yellow('⚠ Music generation skipped — manual instructions saved to audio/MUSIC_GENERATION_INSTRUCTIONS.md'));
    if (musicResult.apiError) {
      console.log(chalk.dim(`  API error: ${musicResult.apiError.substring(0, 120)}`));
    }
  }

  // ─────────────────────────────
  // 6. Generate thumbnails
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 6/9: Generating thumbnails...\n'));
  const thumbnailResult = await generateThumbnails({
    songId,
    title: lyricsResult.title,
    topic,
    metadata,
  });

  // Block if thumbnails were skipped (no CF credentials)
  if (thumbnailResult.skipped) {
    const forceSkip = process.argv.includes('--force-skip-media');
    if (!forceSkip) {
      throw new Error(
        'Thumbnail generation skipped — CF_ACCOUNT_ID and CF_API_TOKEN are required.\n' +
        'Get them at https://dash.cloudflare.com → AI → Workers AI\n' +
        'To bypass during dev/testing: add --force-skip-media flag'
      );
    }
    console.log(chalk.yellow('⚠ Thumbnails skipped (--force-skip-media set)'));
  }

  upsertSong({
    id: songId,
    topic,
    title: lyricsResult.title,
    status: 'draft',
    lyrics_path: lyricsResult.lyricsPath,
    audio_prompt_path: lyricsResult.audioPromptPath,
    metadata_path: metadataPath,
    thumbnail_path: thumbnailResult.thumbDir,
    brand_score: brandReview.scores?.overall,
    total_cost_usd: totalCost,
  });

  // ─────────────────────────────
  // 7. OPS QA
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 7/9: Running QA checklist...\n'));
  const qaReport = runQAChecklist({
    songId,
    songDir,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    brandReview,
    metadata,
    thumbnails: thumbnailResult.generatedThumbnails,
  });

  // QA warnings shown, failures throw inside approval gate as second safety net
  if (qaReport.warnings.length > 0) {
    console.log(chalk.yellow('\n⚠ QA Warnings:'));
    qaReport.warnings.forEach(w => console.log(chalk.yellow(`  • ${w}`)));
  }
  if (qaReport.passed) {
    console.log(chalk.green('\n✓ QA passed — all checks green\n'));
  }

  // ─────────────────────────────
  // 8. Human approval gate
  // ─────────────────────────────
  console.log(chalk.bold('\n📌 Step 8/9: Human approval gate...\n'));
  const approval = await approveSong({
    songId,
    title: lyricsResult.title,
    topic,
    brandScore: brandReview.scores?.overall,
    costUsd: totalCost,
    lyricsPath: lyricsResult.lyricsPath,
    audioPromptPath: lyricsResult.audioPromptPath,
    qaReport,
    songDir,
  });

  if (approval.decision === 'yes') {
    upsertSong({
      id: songId,
      topic,
      title: lyricsResult.title,
      status: 'approved',
      lyrics_path: lyricsResult.lyricsPath,
      audio_prompt_path: lyricsResult.audioPromptPath,
      metadata_path: metadataPath,
      thumbnail_path: thumbnailResult.thumbDir,
      brand_score: brandReview.scores?.overall,
      total_cost_usd: totalCost,
    });

    // Build distribution package with active-profile metadata and upload instructions
    console.log(chalk.bold('\n📌 Step 9/9: Building distribution package...\n'));
    const { distDir } = await generateHumanTasks({
      songId,
      title: lyricsResult.title,
      topic,
      songDir,
      metadata,
      lyricsPath: lyricsResult.lyricsPath,
      audioPromptPath: lyricsResult.audioPromptPath,
      thumbnailDir: thumbnailResult.thumbDir,
      brandScore: brandReview.scores?.overall,
      totalCost,
    });

    console.log(chalk.bgGreen.black('\n ✓ SONG APPROVED — READY FOR DISTRIBUTION \n'));
    console.log(`  Distribution package: ${chalk.bold(distDir)}`);
    console.log(`  Open DISTRIBUTOR-UPLOAD.md for pre-filled upload values`);

  } else if (approval.decision === 'revise') {
    console.log(chalk.yellow('\n↺ Song sent for revision'));
    console.log('Re-running with revision notes...\n');

    // Re-run the pipeline with revision notes
    await runNewSongPipeline(`${topic} [REVISION: ${approval.notes}]`);
    return;

  } else {
    upsertSong({
      id: songId,
      topic,
      title: lyricsResult.title,
      status: 'rejected',
      lyrics_path: lyricsResult.lyricsPath,
      audio_prompt_path: lyricsResult.audioPromptPath,
      total_cost_usd: totalCost,
    });
    console.log(chalk.red('\n✗ Song rejected'));
  }

  // ─────────────────────────────
  // 8. Update financial report
  // ─────────────────────────────
  await updateFinancialReport({ songId, title: lyricsResult.title, totalCost });

  console.log(`\n${chalk.dim('Total pipeline cost:')} ${chalk.bold(formatCost(totalCost))}`);
  console.log(`${chalk.dim('Song ID:')} ${songId}\n`);
}

// ─────────────────────────────────────────────────────────────
// SUGGEST NEXT SONG
// ─────────────────────────────────────────────────────────────

async function suggestNextSong() {
  printBanner();
  console.log(chalk.bold.cyan(`SONG SUGGESTER — What should ${BRAND_NAME} make next?\n`));

  const suggestions = await runSuggestPipeline((msg) => console.log(msg));

  console.log(chalk.bold('\n🎵 Next Song Recommendations:\n'));
  for (const rec of suggestions.recommendations || []) {
    const urgencyColor = rec.urgency === 'trending' ? chalk.red : rec.urgency === 'seasonal' ? chalk.yellow : chalk.green;
    console.log(chalk.bold(`${rec.rank}. ${rec.title}`));
    console.log(`   Topic: ${chalk.cyan(rec.topic)}`);
    if (rec.why) console.log(`   ${rec.why}`);
    if (rec.hook_idea) console.log(`   Hook: ${chalk.italic(rec.hook_idea)}`);
    const detail = [rec.profile_specific_element, rec.bpm_target ? `${rec.bpm_target} BPM` : null, rec.urgency ? urgencyColor(rec.urgency) : null].filter(Boolean).join(' | ');
    if (detail) console.log(`   ${detail}`);
    console.log('');
  }

  if (suggestions.recommended_next) {
    console.log(chalk.bgCyan.black(' ▶ TOP PICK — run this command: '));
    console.log(chalk.bold(`\n  node src/orchestrator.js --new "${suggestions.recommended_next}"\n`));
  }
}

// ─────────────────────────────────────────────────────────────
// APPROVE / REJECT
// ─────────────────────────────────────────────────────────────

async function approveSongCommand(songId) {
  const song = getSong(songId);
  if (!song) {
    console.error(chalk.red(`Song not found: ${songId}`));
    process.exit(1);
  }

  upsertSong({ ...song, status: 'approved' });
  console.log(chalk.green(`✓ Song ${songId} approved`));

  // Generate human tasks if not already done
  const humanTaskPath = join(__dirname, `../output/human-tasks/${songId}-human-tasks.md`);
  if (!fs.existsSync(humanTaskPath)) {
    console.log('Generating human task instructions...');
    await generateHumanTasks({
      songId,
      title: song.title,
      topic: song.topic,
      songDir: join(__dirname, `../output/songs/${songId}`),
      metadata: null,
      lyricsPath: song.lyrics_path,
      audioPromptPath: song.audio_prompt_path,
      thumbnailDir: song.thumbnail_path,
      brandScore: song.brand_score,
      totalCost: song.total_cost_usd,
    });
  }

  console.log(`\nHuman tasks: output/human-tasks/${songId}-human-tasks.md`);
}

async function rejectSongCommand(songId, reason) {
  const song = getSong(songId);
  if (!song) {
    console.error(chalk.red(`Song not found: ${songId}`));
    process.exit(1);
  }

  upsertSong({ ...song, status: 'rejected' });
  console.log(chalk.red(`✗ Song ${songId} rejected. Reason: ${reason || 'none'}`));
}

// ─────────────────────────────────────────────────────────────
// LIST SONGS
// ─────────────────────────────────────────────────────────────

function verifySong(songId) {
  if (!songId) {
    console.error(chalk.red('Usage: --verify <song-id>'));
    process.exit(1);
  }

  const song = getSong(songId);
  const songDir = join(__dirname, `../output/songs/${songId}`);

  console.log(chalk.bold(`\nVerifying song: ${songId}\n`));

  const checks = [];

  // Lyrics
  const lyricsOk = fs.existsSync(join(songDir, 'lyrics.md'));
  checks.push({ label: 'Lyrics (lyrics.md)', ok: lyricsOk });

  // Audio prompt
  const promptOk = fs.existsSync(join(songDir, 'audio-prompt.md'));
  checks.push({ label: 'Audio prompt (audio-prompt.md)', ok: promptOk });

  // Audio file (mp3 or wav, pipeline folder or legacy root)
  const audioDir = join(songDir, 'audio');
  const hasAudioRoot = fs.existsSync(join(songDir, 'audio.mp3')) || fs.existsSync(join(songDir, 'audio.wav'));
  const hasAudioDir = fs.existsSync(audioDir) && fs.readdirSync(audioDir).some(f => f.endsWith('.mp3') || f.endsWith('.wav'));
  const audioOk = hasAudioRoot || hasAudioDir;
  checks.push({ label: 'Audio file (MP3/WAV)', ok: audioOk, warn: !audioOk });

  // Thumbnails
  const thumbDir = join(songDir, 'thumbnails');
  const pngs = fs.existsSync(thumbDir) ? fs.readdirSync(thumbDir).filter(f => f.endsWith('.png')) : [];
  const thumbOk = pngs.length >= 1;
  checks.push({ label: `Thumbnails (${pngs.length} PNG${pngs.length !== 1 ? 's' : ''})`, ok: thumbOk, warn: !thumbOk });

  // Metadata
  const metaOk = fs.existsSync(join(songDir, 'metadata.json'));
  checks.push({ label: 'Metadata (metadata.json)', ok: metaOk });

  // Brand review
  const reviewPath = join(songDir, 'brand-review.json');
  let score = song?.brand_score || null;
  if (!score && fs.existsSync(reviewPath)) {
    try { score = JSON.parse(fs.readFileSync(reviewPath, 'utf8')).scores?.overall; } catch {}
  }
  const scoreOk = score >= 75;
  checks.push({ label: `Brand score (${score || '?'}/100, min 75)`, ok: scoreOk });

  // Print results
  for (const c of checks) {
    const icon = c.ok ? chalk.green('✓') : c.warn ? chalk.yellow('⚠') : chalk.red('✗');
    console.log(`  ${icon} ${c.label}`);
  }

  const allCritical = checks.filter(c => !c.warn).every(c => c.ok);
  const status = song?.status || 'unknown';
  console.log(`\n  Status: ${chalk.bold(status)}`);
  console.log(`  Title:  ${song?.title || '—'}`);
  if (song?.total_cost_usd) {
    console.log(`  Cost:   ${formatCost(song.total_cost_usd)}`);
  }

  if (audioOk && thumbOk && allCritical) {
    console.log(chalk.green('\n✓ Ready for distribution\n'));
  } else {
    console.log(chalk.yellow('\n⚠ Not yet ready — see items above\n'));
  }
}

function listSongs() {
  const songs = getAllSongs();
  if (songs.length === 0) {
    console.log('No songs yet. Run: node src/orchestrator.js --new "your topic here"');
    return;
  }

  const statusColors = {
    draft: chalk.yellow,
    approved: chalk.green,
    rejected: chalk.red,
    published: chalk.blue,
  };

  console.log(chalk.bold('\nAll Songs:\n'));
  console.log(`${'ID'.padEnd(22)} ${'Title'.padEnd(30)} ${'Status'.padEnd(12)} ${'Score'.padEnd(6)} Cost`);
  console.log('─'.repeat(90));

  for (const song of songs) {
    const color = statusColors[song.status] || chalk.white;
    console.log(
      `${song.id.padEnd(22)} ` +
      `${(song.title || '—').substring(0, 28).padEnd(30)} ` +
      `${color(song.status.padEnd(12))} ` +
      `${(song.brand_score?.toString() || '—').padEnd(6)} ` +
      `${formatCost(song.total_cost_usd || 0)}`
    );
  }
  console.log('');
}

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

async function main() {
  validateEnv();

  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printBanner();
    printUsage();
    return;
  }

  switch (cmd) {
    case '--setup': {
      await runSetup();
      break;
    }

    case '--new': {
      const idFlagIdx = args.indexOf('--id');
      const existingSongId = idFlagIdx !== -1 ? args[idFlagIdx + 1] : null;
      const topicArgs = args.slice(1).filter((_, i) => (i + 1) !== idFlagIdx && (i + 1) !== idFlagIdx + 1);
      await runNewSongPipeline(topicArgs.join(' '), existingSongId);
      break;
    }

    case '--research': {
      printBanner();
      console.log(chalk.bold('Running researcher agent...\n'));
      await runResearcher();
      break;
    }

    case '--report': {
      printBanner();
      console.log(chalk.bold('Generating financial report...\n'));
      await generateFullReport();
      break;
    }

    case '--approve': {
      const songId = args[1];
      if (!songId) {
        console.error(chalk.red('Usage: --approve <song-id>'));
        process.exit(1);
      }
      await approveSongCommand(songId);
      break;
    }

    case '--reject': {
      const songId = args[1];
      const reason = args.slice(2).join(' ');
      if (!songId) {
        console.error(chalk.red('Usage: --reject <song-id> "reason"'));
        process.exit(1);
      }
      await rejectSongCommand(songId, reason);
      break;
    }

    case '--list': {
      listSongs();
      break;
    }

    case '--verify': {
      const songId = args[1];
      verifySong(songId);
      break;
    }

    case '--suggest': {
      await suggestNextSong();
      break;
    }

    case '--schedule': {
      printBanner();
      console.log(chalk.bold('Starting recurring task scheduler...\n'));
      startScheduler({
        onResearch: async () => { await runResearcher(); },
        onFinancialReport: async () => { await generateFullReport(); },
        onDistributionCheck: async () => { await researchDistribution(); },
      });
      // Keep process alive
      process.stdin.resume();
      break;
    }

    default: {
      console.error(chalk.red(`Unknown command: ${cmd}`));
      printUsage();
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(chalk.red('\nFatal error:'), err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
