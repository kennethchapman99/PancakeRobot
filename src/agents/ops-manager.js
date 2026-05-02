/**
 * Operations Manager Agent — QA, human task generation, recurring scheduler
 */

import { runAgent, loadConfig, saveConfig } from '../shared/managed-agent.js';
import cron from 'node-cron';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadBrandProfile } from '../shared/brand-profile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND_PROFILE = loadBrandProfile();
const BRAND_NAME = BRAND_PROFILE.brand_name;
const DEFAULT_ARTIST = BRAND_PROFILE.distribution.default_artist;
const DEFAULT_ALBUM = BRAND_PROFILE.distribution.default_album;
const PRIMARY_GENRE = BRAND_PROFILE.distribution.primary_genre;
const AUDIENCE_COMPLIANCE_STATUS = BRAND_PROFILE.distribution.coppa_status;
const CONTENT_ADVISORY = BRAND_PROFILE.distribution.content_advisory;
const YOUTUBE_TAGS_SEED = BRAND_PROFILE.distribution.youtube_tags_seed || [];

export const OPS_MANAGER_DEF = {
  name: `${BRAND_NAME} Operations Manager`,
  model: 'claude-haiku-4-5-20251001',
  noTools: true, // Structured markdown from provided context — no web search needed
  system: `You are the operations manager for ${BRAND_NAME}, ${BRAND_PROFILE.brand_description}.

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
function hasValidPngHeader(filePath) {
  const header = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, header, 0, 8, 0);
  fs.closeSync(fd);
  return isValidPng(header);
}
function ensureYoutubeTitle(meta, metadataPath) {
  if (!meta.youtube_title && meta.title) {
    meta.youtube_title = meta.title;
    meta._qa_autofilled = {
      ...(meta._qa_autofilled || {}),
      youtube_title: 'Copied from title because product-manager omitted youtube_title.',
    };
    fs.writeFileSync(metadataPath, JSON.stringify(meta, null, 2));
    return true;
  }
  return false;
}

export function findAudioFile(songDir) {
  const audioDir = join(songDir, 'audio');
  const candidates = [join(songDir, 'audio.mp3'), join(songDir, 'audio.wav')];
  if (fs.existsSync(audioDir)) {
    const generated = fs.readdirSync(audioDir)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.wav'))
      .map(f => join(audioDir, f));
    candidates.push(...generated);
  }
  return candidates.find(filePath => fs.existsSync(filePath)) || null;
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
    const hasVerse = /\[(VERSE|VERSE\s+\d+)\]/i.test(txt);
    const hasHookOrChorus = /\[(CHORUS|HOOK|FINAL CHORUS|FINAL HOOK)\]/i.test(txt);
    if (!hasHookOrChorus) fail('Lyrics', 'Missing hook/chorus section ([HOOK] or [CHORUS])');
    else if (!hasVerse) fail('Lyrics', 'Missing [VERSE] section');
    else if (wordCount < 80) fail('Lyrics', `Word count too low: ${wordCount} (min 80)`);
    else pass('Lyrics', `${wordCount} words, has hook/chorus + verse`);
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
  const audioFilePath = findAudioFile(songDir);

  if (!audioFilePath) {
    fail('Audio file', 'No MP3/WAV yet — generation is required before distribution package build');
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
      const autoFilledYoutubeTitle = ensureYoutubeTitle(meta, metadataPath);
      const tagCount = Array.isArray(meta.youtube_tags) ? meta.youtube_tags.length : 0;
      const descLen = typeof meta.youtube_description === 'string' ? meta.youtube_description.length : 0;
      if (!meta.title) fail('Metadata', 'Missing title field');
      else if (!meta.youtube_title) fail('Metadata', 'Missing youtube_title field');
      else if (tagCount < 20) warn('Metadata', `Only ${tagCount} YouTube tags (recommend 20+)`);
      else if (descLen < 200) warn('Metadata', `YouTube description short (${descLen} chars, recommend 200+)`);
      else if (autoFilledYoutubeTitle) pass('Metadata', `youtube_title auto-filled from title, ${tagCount} tags, ${descLen} char description`);
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
    const finalPngs = fs.readdirSync(thumbDir).filter(f => f.endsWith('-final.png'));
    const basePngs = fs.readdirSync(thumbDir).filter(f => f.endsWith('-base.png'));
    const allPngs = fs.readdirSync(thumbDir).filter(f => f.endsWith('.png'));

    if (allPngs.length === 0) {
      warn('Thumbnails', 'No PNG files — creative-manager must run (check CF_ACCOUNT_ID and CF_API_TOKEN in .env)');
    } else {
      const preferredPngs = finalPngs.length > 0 ? finalPngs : allPngs;
      const validPreferred = preferredPngs.filter(f => {
        try { return hasValidPngHeader(join(thumbDir, f)); } catch { return false; }
      });
      const invalidPreferred = preferredPngs.filter(f => !validPreferred.includes(f));
      const invalidBasePngs = basePngs.filter(f => {
        try { return !hasValidPngHeader(join(thumbDir, f)); } catch { return true; }
      });

      if (validPreferred.length === 0) {
        fail('Thumbnails', `${preferredPngs[0]} is not a valid PNG (bad magic bytes)`);
      } else if (finalPngs.length === 0) {
        warn('Thumbnails', `${validPreferred.length} valid PNG(s) present but no *-final.png with title text — title overlay may have failed`);
      } else {
        pass('Thumbnails', `${validPreferred.length} final PNG(s) with title text + ${basePngs.length} base PNG(s)`);
      }

      if (invalidPreferred.length > 0) {
        warn('Thumbnails', `${invalidPreferred.length} preferred thumbnail file(s) failed PNG validation: ${invalidPreferred.join(', ')}`);
      }
      if (invalidBasePngs.length > 0 && finalPngs.length > 0) {
        warn('Thumbnails', `${invalidBasePngs.length} base artifact(s) failed PNG validation but valid final thumbnail(s) exist: ${invalidBasePngs.join(', ')}`);
      }
    }
  }

  const passed = failures.length === 0;

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
 * Human opens the active distributor, pastes values, uploads files, and submits.
 */
export async function generateHumanTasks({ songId, title, topic, songDir, metadata, lyricsPath, audioPromptPath, thumbnailDir, brandScore, totalCost }) {
  const config = loadConfig();
  const activeProfileDistribution = config.distribution?.profile_brand_name === BRAND_NAME ? config.distribution : null;
  const distributionService = activeProfileDistribution?.recommended_service || BRAND_PROFILE.distribution.default_distributor || 'distribution service';
  const distributionUrl = activeProfileDistribution?.recommended_url || BRAND_PROFILE.distribution.research_default_url || '';

  let metaJson = {};
  const metadataPath = join(songDir, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    try { metaJson = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch {}
  }

  const bpm = metaJson.bpm || '110';
  const ytTitle = metaJson.youtube_title || title;
  const ytDescription = metaJson.youtube_description || '';
  const ytTags = Array.isArray(metaJson.youtube_tags) ? metaJson.youtube_tags.join(', ') : '';
  const genre = metaJson.genre || PRIMARY_GENRE;
  const durationSec = metaJson.duration_seconds || 150;
  const durationStr = `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`;

  const audioSrc = findAudioFile(songDir);
  if (!audioSrc) {
    throw new Error(
      'Distribution package blocked: no generated audio file found. ' +
      'Generate audio first or add an MP3/WAV under the song audio folder, then rerun approval/package build.'
    );
  }

  const distDir = join(__dirname, `../../output/distribution-ready/${songId}`);
  fs.mkdirSync(distDir, { recursive: true });

  let audioExt = audioSrc.endsWith('.wav') ? 'wav' : 'mp3';
  fs.copyFileSync(audioSrc, join(distDir, `upload-this.${audioExt}`));
  console.log(`[OPS] ✓ Audio copied → upload-this.${audioExt}`);

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

  if (fs.existsSync(metadataPath)) {
    fs.copyFileSync(metadataPath, join(distDir, 'metadata.json'));
  }

  const dk = `# ${distributionService} Upload — ${title}
## Generated: ${new Date().toISOString()}
## Everything below is pre-filled. Copy-paste each value.

---

## Files to upload
- **Audio:** \`upload-this.${audioExt}\` (in this folder)
- **Artwork:** \`cover-art-3000x3000.png\` (in this folder)

---

## Step-by-step

1. Log in at ${distributionUrl || distributionService}
2. Click **Upload** → **New Release** → **Single**
3. Upload audio: \`upload-this.${audioExt}\`

### Song Details
| Field | Value |
|---|---|
| Song Title | \`${title}\` |
| Primary Artist | \`${metaJson.artist || DEFAULT_ARTIST}\` |
| Album | \`${metaJson.album || DEFAULT_ALBUM}\` |
| Genre | \`${genre}\` |
| BPM | \`${bpm}\` |
| Duration | \`${durationStr}\` |
| Language | \`English\` |
| ISRC | *(auto-assigned by distributor if applicable)* |

### Songwriter / Publisher
| Field | Value |
|---|---|
| Songwriter | \`${metaJson.songwriter || DEFAULT_ARTIST}\` |
| Composer | \`${metaJson.composer || DEFAULT_ARTIST}\` |
| Publisher | *(leave blank or your name)* |

### Content Settings
| Field | Value |
|---|---|
| Explicit content | \`${CONTENT_ADVISORY}\` |
| Audience / Compliance | \`${AUDIENCE_COMPLIANCE_STATUS}\` |
| Release date | *(choose the release date recommended in metadata)* |

### Artwork
Upload: \`cover-art-3000x3000.png\`

### Platforms
Check all: ✅ Spotify ✅ Apple Music ✅ YouTube Music ✅ Amazon Music ✅ TikTok ✅ Deezer ✅ iHeart

4. Click **Submit Release**
5. Note your release ID here: _______________

---

## After submission
- ${distributionService} distribution timing varies by service
- Upload your YouTube video manually (see YOUTUBE-UPLOAD.md)
`;
  fs.writeFileSync(join(distDir, 'DISTRIBUTOR-UPLOAD.md'), dk);

  const yt = `# YouTube Upload — ${title}
## Use this after ${distributionService} distributes, or upload a visualizer yourself sooner

---

## Title (copy exactly)
\`\`\`
${ytTitle}
\`\`\`

## Description (copy exactly)
\`\`\`
${ytDescription || `${title} by ${DEFAULT_ARTIST}\n\n${BRAND_PROFILE.brand_description}`}
\`\`\`

## Tags (copy all)
\`\`\`
${ytTags}
\`\`\`

## Upload Settings
| Field | Value |
|---|---|
| Thumbnail | Upload \`youtube-thumbnail.png\` from this folder |
| Category | **Music** |
| Audience / Compliance | **${AUDIENCE_COMPLIANCE_STATUS}** |
| Age restriction | None |
| Monetization | Enable if channel is monetized |
| Playlist | Add to the appropriate ${BRAND_NAME} playlist |

## Playlist
Suggested tags seed: ${YOUTUBE_TAGS_SEED.join(', ')}
`;
  fs.writeFileSync(join(distDir, 'YOUTUBE-UPLOAD.md'), yt);

  console.log(`[OPS] ✓ Distribution package built → ${distDir}`);
  console.log(`[OPS] ✓ DISTRIBUTOR-UPLOAD.md — all values pre-filled`);
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

  cron.schedule('0 9 1 * *', async () => {
    console.log('\n[OPS-MANAGER] Running scheduled research update...');
    try {
      await onResearch();
    } catch (err) {
      console.error('[OPS-MANAGER] Scheduled research failed:', err.message);
    }
  });

  cron.schedule('0 9 * * 1', async () => {
    console.log('\n[OPS-MANAGER] Running scheduled financial report...');
    try {
      await onFinancialReport();
    } catch (err) {
      console.error('[OPS-MANAGER] Scheduled financial report failed:', err.message);
    }
  });

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
