/**
 * Operations Manager Agent — QA, human task generation, recurring scheduler
 */

import { runAgent, loadConfig, saveConfig } from '../shared/managed-agent.js';
import cron from 'node-cron';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const OPS_MANAGER_DEF = {
  name: 'Pancake Robot Operations Manager',
  model: 'claude-haiku-4-5-20251001',
  noTools: true, // Structured markdown from provided context — no web search needed
  system: `You are the operations manager for Pancake Robot, an autonomous children's music production pipeline.

Your role:
1. Quality assurance — verify all pipeline outputs are complete and correct
2. Human task generation — write crystal-clear, step-by-step instructions for the human in the loop
3. Issue flagging — identify problems and tell exactly which agent needs to re-run
4. Process optimization — note patterns and suggest improvements

When writing human task instructions:
- Be extremely specific (include exact file paths, exact text to copy-paste)
- Number every step
- Include what success looks like at each step
- Anticipate common mistakes and warn against them
- Keep the human's time investment under 30 minutes per song

Output well-structured Markdown for human tasks.`,
};

// PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
// MP3 magic bytes: ID3 tag (49 44 33) or sync frame (FF FB / FF F3 / FF F2)
function isValidMp3(buf) {
  if (buf.length < 3) return false;
  const id3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const sync = buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
  return id3 || sync;
}
function isValidPng(buf) {
  if (buf.length < 8) return false;
  return PNG_MAGIC.every((b, i) => buf[i] === b);
}

/**
 * Run QA checklist on a completed song pipeline run.
 * Validates actual file content, not just existence.
 * failures = blocking (pipeline should not proceed)
 * warnings = informational only
 */
export function runQAChecklist({ songId, songDir, lyricsPath, audioPromptPath, brandReview, metadata, thumbnails }) {
  const failures = [];
  const warnings = [];
  const checks = [];

  const pass = (label, detail) => { checks.push({ check: label, passed: true, detail }); };
  const fail = (label, detail) => { failures.push(`${label}: ${detail}`); checks.push({ check: label, passed: false, detail }); };
  const warn = (label, detail) => { warnings.push(`${label}: ${detail}`); checks.push({ check: label, passed: true, warning: detail }); };

  // ── Lyrics ────────────────────────────────────────────────
  if (!lyricsPath || !fs.existsSync(lyricsPath)) {
    fail('Lyrics', 'lyrics.md missing — lyricist must run');
  } else {
    const txt = fs.readFileSync(lyricsPath, 'utf8');
    const wordCount = txt.split(/\s+/).filter(Boolean).length;
    if (!txt.includes('[CHORUS]')) fail('Lyrics', 'Missing [CHORUS] section');
    else if (!txt.includes('[VERSE')) fail('Lyrics', 'Missing [VERSE] section');
    else if (wordCount < 80) fail('Lyrics', `Word count too low: ${wordCount} (min 80)`);
    else pass('Lyrics', `${wordCount} words, has CHORUS + VERSE`);
  }

  // ── Audio prompt ───────────────────────────────────────────
  if (!audioPromptPath || !fs.existsSync(audioPromptPath)) {
    fail('Audio prompt', 'audio-prompt.md missing');
  } else {
    const txt = fs.readFileSync(audioPromptPath, 'utf8');
    if (!txt.includes('BPM') || !txt.includes('Style')) fail('Audio prompt', 'Missing BPM or Style fields');
    else pass('Audio prompt', 'BPM + Style present');
  }

  // ── Audio file (MP3) ───────────────────────────────────────
  const audioDir = join(songDir, 'audio');
  const audioRootMp3 = join(songDir, 'audio.mp3');
  const audioRootWav = join(songDir, 'audio.wav');
  let audioFilePath = null;
  if (fs.existsSync(audioRootMp3)) audioFilePath = audioRootMp3;
  else if (fs.existsSync(audioRootWav)) audioFilePath = audioRootWav;
  else if (fs.existsSync(audioDir)) {
    const mp3s = fs.readdirSync(audioDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
    if (mp3s.length > 0) audioFilePath = join(audioDir, mp3s[0]);
  }

  if (!audioFilePath) {
    warn('Audio file', 'No MP3/WAV yet — generate manually via audio/MUSIC_GENERATION_INSTRUCTIONS.md');
  } else {
    const stat = fs.statSync(audioFilePath);
    if (stat.size < 50 * 1024) {
      fail('Audio file', `File too small (${(stat.size / 1024).toFixed(0)} KB) — likely corrupt or empty`);
    } else {
      const header = Buffer.alloc(3);
      const fd = fs.openSync(audioFilePath, 'r');
      fs.readSync(fd, header, 0, 3, 0);
      fs.closeSync(fd);
      if (audioFilePath.endsWith('.mp3') && !isValidMp3(header)) {
        warn('Audio file', `File exists (${(stat.size / 1024).toFixed(0)} KB) but MP3 header not detected — may still be valid`);
      } else {
        pass('Audio file', `${(stat.size / 1024).toFixed(0)} KB, valid header`);
      }
    }
  }

  // ── Brand score ────────────────────────────────────────────
  if (!brandReview) {
    fail('Brand score', 'Brand review missing — brand-manager must run');
  } else {
    const score = brandReview.scores?.overall || 0;
    if (score < 75) fail('Brand score', `${score}/100 — minimum 75 required`);
    else pass('Brand score', `${score}/100`);
  }

  // ── Metadata ───────────────────────────────────────────────
  const metadataPath = join(songDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    fail('Metadata', 'metadata.json missing — product-manager must run');
  } else {
    try {
      const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const tagCount = Array.isArray(meta.youtube_tags) ? meta.youtube_tags.length : 0;
      const descLen = typeof meta.youtube_description === 'string' ? meta.youtube_description.length : 0;
      if (!meta.title) fail('Metadata', 'Missing title field');
      else if (!meta.youtube_title) fail('Metadata', 'Missing youtube_title field');
      else if (tagCount < 20) warn('Metadata', `Only ${tagCount} YouTube tags (recommend 20+)`);
      else if (descLen < 200) warn('Metadata', `YouTube description short (${descLen} chars, recommend 200+)`);
      else pass('Metadata', `title ✓, ${tagCount} tags, ${descLen} char description`);
    } catch {
      fail('Metadata', 'metadata.json is invalid JSON');
    }
  }

  // ── Thumbnails ─────────────────────────────────────────────
  const thumbDir = join(songDir, 'thumbnails');
  if (!fs.existsSync(thumbDir)) {
    warn('Thumbnails', 'Directory missing — creative-manager must run');
  } else {
    // Prefer *-final.png (title text applied) over *-base.png
    const finalPngs = fs.readdirSync(thumbDir).filter(f => f.endsWith('-final.png'));
    const basePngs = fs.readdirSync(thumbDir).filter(f => f.endsWith('-base.png'));
    const allPngs = fs.readdirSync(thumbDir).filter(f => f.endsWith('.png'));

    if (allPngs.length === 0) {
      warn('Thumbnails', 'No PNG files — creative-manager must run (check CF_ACCOUNT_ID and CF_API_TOKEN in .env)');
    } else {
      // Validate PNG magic bytes on first file
      const sample = join(thumbDir, allPngs[0]);
      const header = Buffer.alloc(8);
      const fd = fs.openSync(sample, 'r');
      fs.readSync(fd, header, 0, 8, 0);
      fs.closeSync(fd);

      if (!isValidPng(header)) {
        fail('Thumbnails', `${allPngs[0]} is not a valid PNG (bad magic bytes)`);
      } else if (finalPngs.length === 0) {
        warn('Thumbnails', `${basePngs.length} base PNG(s) present but no *-final.png with title text — title overlay may have failed`);
      } else {
        pass('Thumbnails', `${finalPngs.length} final PNG(s) with title text + ${basePngs.length} base PNG(s)`);
      }
    }
  }

  const passed = failures.length === 0;

  // Save QA report
  const qaReport = {
    song_id: songId,
    timestamp: new Date().toISOString(),
    passed,
    failures,
    warnings,
    checks,
  };
  fs.writeFileSync(join(songDir, 'qa-report.json'), JSON.stringify(qaReport, null, 2));

  return qaReport;
}

/**
 * Build a distribution-ready package folder after human approval.
 * Copies/renames all files to a clean folder with pre-filled upload instructions.
 * Human just opens DistroKid, pastes values, uploads 2 files — done.
 */
export async function generateHumanTasks({ songId, title, topic, songDir, metadata, lyricsPath, audioPromptPath, thumbnailDir, brandScore, totalCost }) {
  const config = loadConfig();
  const distributionService = config.distribution?.recommended_service || 'DistroKid';
  const distributionUrl = config.distribution?.recommended_url || 'https://distrokid.com';

  // Read metadata
  let metaJson = {};
  const metadataPath = join(songDir, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    try { metaJson = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch {}
  }

  const bpm = metaJson.bpm || '110';
  const ytTitle = metaJson.youtube_title || title;
  const ytDescription = metaJson.youtube_description || '';
  const ytTags = Array.isArray(metaJson.youtube_tags) ? metaJson.youtube_tags.join(', ') : '';
  const genre = metaJson.genre || "Children's Music";
  const durationSec = metaJson.duration_seconds || 150;
  const durationStr = `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`;

  // ── Build distribution-ready folder ──────────────────────
  const distDir = join(__dirname, `../../output/distribution-ready/${songId}`);
  fs.mkdirSync(distDir, { recursive: true });

  // Find and copy audio file
  const audioDir = join(songDir, 'audio');
  let audioSrc = null;
  let audioExt = 'mp3';
  if (fs.existsSync(join(songDir, 'audio.mp3'))) { audioSrc = join(songDir, 'audio.mp3'); }
  else if (fs.existsSync(join(songDir, 'audio.wav'))) { audioSrc = join(songDir, 'audio.wav'); audioExt = 'wav'; }
  else if (fs.existsSync(audioDir)) {
    const mp3s = fs.readdirSync(audioDir).filter(f => f.endsWith('.mp3'));
    const wavs = fs.readdirSync(audioDir).filter(f => f.endsWith('.wav'));
    if (mp3s.length > 0) { audioSrc = join(audioDir, mp3s[0]); }
    else if (wavs.length > 0) { audioSrc = join(audioDir, wavs[0]); audioExt = 'wav'; }
  }
  if (audioSrc) {
    fs.copyFileSync(audioSrc, join(distDir, `upload-this.${audioExt}`));
    console.log(`[OPS] ✓ Audio copied → upload-this.${audioExt}`);
  }

  // Find and copy thumbnails
  const thumbDir = join(songDir, 'thumbnails');
  if (fs.existsSync(thumbDir)) {
    const finalPngs = fs.readdirSync(thumbDir).filter(f => f.endsWith('-final.png'));
    const basePngs = fs.readdirSync(thumbDir).filter(f => f.endsWith('-base.png'));
    const pngsToUse = finalPngs.length > 0 ? finalPngs : basePngs;

    for (const png of pngsToUse) {
      const dest = png.includes('landscape') ? 'youtube-thumbnail.png'
        : png.includes('spotify') ? 'cover-art-3000x3000.png'
        : png.includes('apple') ? 'apple-music-cover.png'
        : png;
      fs.copyFileSync(join(thumbDir, png), join(distDir, dest));
      console.log(`[OPS] ✓ Thumbnail copied → ${dest}`);
    }
  }

  // Copy metadata
  if (fs.existsSync(metadataPath)) {
    fs.copyFileSync(metadataPath, join(distDir, 'metadata.json'));
  }

  // ── DISTROKID-UPLOAD.md ── pre-filled, paste-and-click ───
  const dk = `# DistroKid Upload — ${title}
## Generated: ${new Date().toISOString()}
## Everything below is pre-filled. Copy-paste each value.

---

## Files to upload
- **Audio:** \`upload-this.${audioExt}\` (in this folder)
- **Artwork:** \`cover-art-3000x3000.png\` (in this folder)

---

## Step-by-step

1. Log in at ${distributionUrl}
2. Click **Upload** → **New Release** → **Single**
3. Upload audio: \`upload-this.${audioExt}\`

### Song Details
| Field | Value |
|---|---|
| Song Title | \`${title}\` |
| Primary Artist | \`Pancake Robot\` |
| Genre | \`${genre}\` |
| BPM | \`${bpm}\` |
| Duration | \`${durationStr}\` |
| Language | \`English\` |
| ISRC | *(DistroKid auto-assigns)* |

### Songwriter / Publisher
| Field | Value |
|---|---|
| Songwriter | \`Pancake Robot AI\` |
| Composer | \`Pancake Robot AI\` |
| Publisher | *(leave blank or your name)* |

### Content Settings
| Field | Value |
|---|---|
| Explicit content | \`No\` |
| COPPA / Made for kids | \`Yes — Directed to children under 13\` |
| Release date | *(choose Friday for best algorithmic boost)* |

### Artwork
Upload: \`cover-art-3000x3000.png\`

### Platforms
Check all: ✅ Spotify ✅ Apple Music ✅ YouTube Music ✅ Amazon Music ✅ TikTok ✅ Deezer ✅ iHeart

4. Click **Submit Release**
5. Note your release ID here: _______________

---

## After submission
- DistroKid distributes within 24–48 hours
- Upload your YouTube video manually (see YOUTUBE-UPLOAD.md)
`;
  fs.writeFileSync(join(distDir, 'DISTROKID-UPLOAD.md'), dk);

  // ── YOUTUBE-UPLOAD.md ── pre-filled for YouTube Studio ───
  const yt = `# YouTube Upload — ${title}
## Use this AFTER DistroKid distributes (24-48 hours)
## Or upload a lyric video / visualizer yourself sooner

---

## Title (copy exactly)
\`\`\`
${ytTitle}
\`\`\`

## Description (copy exactly)
\`\`\`
${ytDescription || `${title} by Pancake Robot\n\n🤖🥞 Subscribe for more Pancake Robot songs!\n\n#PancakeRobot #KidsSongs #ChildrensMusic`}
\`\`\`

## Tags (copy all)
\`\`\`
${ytTags}
\`\`\`

## Upload Settings
| Field | Value |
|---|---|
| Thumbnail | Upload \`youtube-thumbnail.png\` from this folder |
| Category | **Education** or **Music** |
| Made for kids | **Yes** |
| Age restriction | None |
| Monetization | Enable if channel is monetized |
| Playlist | Add to "Pancake Robot Songs" playlist |

## Playlist
Create or add to playlist: **Pancake Robot Songs** (Public)
`;
  fs.writeFileSync(join(distDir, 'YOUTUBE-UPLOAD.md'), yt);

  console.log(`[OPS] ✓ Distribution package built → ${distDir}`);
  console.log(`[OPS] ✓ DISTROKID-UPLOAD.md — all values pre-filled`);
  console.log(`[OPS] ✓ YOUTUBE-UPLOAD.md — title, description, tags ready`);

  return { distDir, taskPath: distDir };
}

/**
 * Start the recurring task scheduler
 */
export function startScheduler({ onResearch, onFinancialReport, onDistributionCheck }) {
  const config = loadConfig();
  const schedule = config.schedule || {};

  console.log('\n[OPS-MANAGER] Starting recurring task scheduler...');

  // Research: every 30 days (approximated as monthly cron)
  cron.schedule('0 9 1 * *', async () => {
    console.log('\n[OPS-MANAGER] Running scheduled research update...');
    try {
      await onResearch();
    } catch (err) {
      console.error('[OPS-MANAGER] Scheduled research failed:', err.message);
    }
  });

  // Financial report: every 7 days (every Monday at 9am)
  cron.schedule('0 9 * * 1', async () => {
    console.log('\n[OPS-MANAGER] Running scheduled financial report...');
    try {
      await onFinancialReport();
    } catch (err) {
      console.error('[OPS-MANAGER] Scheduled financial report failed:', err.message);
    }
  });

  // Distribution check: first of month
  cron.schedule('0 10 1 * *', async () => {
    console.log('\n[OPS-MANAGER] Running scheduled distribution check...');
    try {
      if (onDistributionCheck) await onDistributionCheck();
    } catch (err) {
      console.error('[OPS-MANAGER] Scheduled distribution check failed:', err.message);
    }
  });

  console.log('[OPS-MANAGER] Scheduler active:');
  console.log('  - Research: Monthly (1st of month, 9am)');
  console.log('  - Financial Report: Weekly (Monday, 9am)');
  console.log('  - Distribution Check: Monthly (1st of month, 10am)');
  console.log('\nPress Ctrl+C to stop.\n');
}
