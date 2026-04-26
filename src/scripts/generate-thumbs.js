/**
 * Standalone thumbnail generation script — called by the web server as a child process.
 * Usage: node src/scripts/generate-thumbs.js <songId>
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

import { generateThumbnails } from '../agents/creative-manager.js';
import { getSong } from '../shared/db.js';

const songId = process.argv[2];
if (!songId) { console.error('Usage: generate-thumbs.js <songId>'); process.exit(1); }

const song = getSong(songId);
if (!song) { console.error(`Song not found: ${songId}`); process.exit(1); }

const songDir = join(__dirname, '../../output/songs', songId);
let metadataParsed = null;
try {
  const mPath = join(songDir, 'metadata.json');
  if (fs.existsSync(mPath)) metadataParsed = JSON.parse(fs.readFileSync(mPath, 'utf8'));
} catch {}

try {
  const result = await generateThumbnails({
    songId: song.id,
    title: song.title || song.topic,
    topic: song.topic || song.title,
    metadata: metadataParsed || {},
    brandData: {},
  });
  const count = result.generatedThumbnails?.length || 0;
  console.log(`\n✅ Generated ${count} thumbnail(s) successfully`);
  process.exit(0);
} catch (err) {
  console.error(`❌ Thumbnail generation failed: ${err.message}`);
  process.exit(1);
}
