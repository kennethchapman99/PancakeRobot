/**
 * Song revision script — called by web server as a child process.
 * Usage: node src/scripts/revise-song.js <songId> <base64-encoded-feedback>
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);

const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { writeLyrics } from '../agents/lyricist.js';
import { getSong } from '../shared/db.js';
import { buildReleaseSelectionRevisionBrief } from '../lib/release-selection/regeneration-brief.js';

const [,, songId, feedbackB64] = process.argv;
if (!songId || !feedbackB64) {
  console.error('Usage: revise-song.js <songId> <base64-feedback>');
  process.exit(1);
}

const feedback = Buffer.from(feedbackB64, 'base64').toString('utf8');
const song = getSong(songId);
if (!song) { console.error(`Song not found: ${songId}`); process.exit(1); }
const combinedRevisionBrief = buildReleaseSelectionRevisionBrief(song, feedback);

console.log(`\n✍️  Revising: ${song.title || song.topic}`);
console.log(`📝 Feedback: ${feedback}\n`);
if (combinedRevisionBrief && combinedRevisionBrief !== feedback) {
  console.log('🧠 A&R guidance merged into revision brief\n');
}

// Load existing lyrics
const songDir = join(__dirname, '../../output/songs', songId);
const lyricsPath = join(songDir, 'lyrics.md');
let existingLyrics = null;
if (fs.existsSync(lyricsPath)) {
  existingLyrics = fs.readFileSync(lyricsPath, 'utf8');
  console.log(`📄 Loaded existing lyrics (${existingLyrics.split('\n').length} lines)`);
}
if (combinedRevisionBrief) {
  fs.writeFileSync(join(songDir, 'latest-regeneration-brief.md'), combinedRevisionBrief + '\n');
}

// Load research if available
let researchReport = null;
try {
  const rPath = join(__dirname, '../../output/research/research-report.json');
  if (fs.existsSync(rPath)) researchReport = JSON.parse(fs.readFileSync(rPath, 'utf8'));
} catch { /* continue without research */ }

try {
  console.log('\n🤖 Sending to lyricist agent...\n');
  const result = await writeLyrics({
    songId,
    topic: song.topic || song.title,
    researchReport,
    revisionNotes: combinedRevisionBrief || feedback,
    existingLyrics,
  });

  console.log(`\n✅ Lyrics revised successfully!`);
  if (result.title) console.log(`   Title: ${result.title}`);
  if (result.wordCount) console.log(`   Word count: ${result.wordCount}`);
  process.exit(0);
} catch (err) {
  console.error(`\n❌ Revision failed: ${err.message}`);
  process.exit(1);
}
