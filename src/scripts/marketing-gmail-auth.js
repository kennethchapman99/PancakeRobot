/**
 * Run Gmail OAuth2 authorization flow.
 * Usage: npm run marketing:gmail:auth
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
dotenv.config({ path: join(__dirname, '../../.env'), override: true });

import { authorizeInteractive } from '../marketing/gmail-auth.js';

console.log('[GMAIL-AUTH] Starting Gmail authorization…');
console.log('[GMAIL-AUTH] Scopes: https://www.googleapis.com/auth/gmail.readonly');
if (process.env.MARKETING_GMAIL_ACCOUNT) {
  console.log(`[GMAIL-AUTH] Expected account: ${process.env.MARKETING_GMAIL_ACCOUNT}`);
}

try {
  await authorizeInteractive();
  console.log('[GMAIL-AUTH] Authorization complete.');
  process.exit(0);
} catch (err) {
  console.error(`[GMAIL-AUTH] Failed: ${err.message}`);
  process.exit(1);
}
