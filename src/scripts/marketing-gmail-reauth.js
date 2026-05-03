/**
 * Force Gmail OAuth2 re-authorization.
 * Use this after Gmail scopes change, e.g. adding gmail.compose for draft creation.
 * Usage: npm run marketing:gmail:reauth
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import path from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { authorizeInteractive } from '../marketing/gmail-auth.js';

function getTokenPath() {
  const raw = process.env.MARKETING_GMAIL_TOKEN_PATH || '~/.pancake-robot/gmail_token.json';
  return raw.startsWith('~') ? path.join(process.env.HOME || process.env.USERPROFILE || '.', raw.slice(2)) : raw;
}

const tokenPath = getTokenPath();

try {
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
    console.log(`[GMAIL-REAUTH] Deleted old token: ${tokenPath}`);
  } else {
    console.log(`[GMAIL-REAUTH] No existing token found at: ${tokenPath}`);
  }

  console.log('[GMAIL-REAUTH] Starting fresh Gmail authorization with inbox-read + draft-compose access…');
  await authorizeInteractive();
  console.log('[GMAIL-REAUTH] Complete. Gmail draft creation should now work.');
  process.exit(0);
} catch (err) {
  console.error(`[GMAIL-REAUTH] Failed: ${err.message}`);
  process.exit(1);
}
