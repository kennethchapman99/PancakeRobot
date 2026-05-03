/**
 * Gmail OAuth2 authentication helper.
 * Reads inbox messages and creates Gmail drafts.
 * Never sends, archives, or deletes messages.
 * Account is verified against MARKETING_GMAIL_ACCOUNT env var.
 */

import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

function getCredentialsPath() {
  const raw = process.env.MARKETING_GMAIL_CREDENTIALS_PATH || '~/.pancake-robot/gmail_credentials.json';
  return raw.startsWith('~') ? path.join(process.env.HOME || process.env.USERPROFILE || '.', raw.slice(2)) : raw;
}

function getTokenPath() {
  const raw = process.env.MARKETING_GMAIL_TOKEN_PATH || '~/.pancake-robot/gmail_token.json';
  return raw.startsWith('~') ? path.join(process.env.HOME || process.env.USERPROFILE || '.', raw.slice(2)) : raw;
}

function loadCredentials() {
  const credPath = getCredentialsPath();
  if (!fs.existsSync(credPath)) {
    throw new Error(
      `Gmail credentials not found at: ${credPath}\n` +
      'Download OAuth2 credentials from Google Cloud Console and save them there.\n' +
      'See: https://developers.google.com/gmail/api/quickstart/nodejs'
    );
  }
  const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const creds = raw.installed || raw.web;
  if (!creds) throw new Error('Invalid credentials.json — must have "installed" or "web" key');
  return creds;
}

export function getOAuth2Client() {
  const creds = loadCredentials();
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:3838');
}

export function loadSavedToken(oauth2Client) {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) return false;
  try {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oauth2Client.setCredentials(token);
    return true;
  } catch {
    return false;
  }
}

export function saveToken(oauth2Client) {
  const tokenPath = getTokenPath();
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(oauth2Client.credentials, null, 2));
}

export async function authorizeInteractive() {
  const oauth2Client = getOAuth2Client();

  if (loadSavedToken(oauth2Client)) {
    console.log('[GMAIL-AUTH] Existing token loaded — verifying account…');
    const verified = await verifyAccount(oauth2Client);
    if (verified) {
      console.log('[GMAIL-AUTH] Account verified. Auth is ready.');
      console.log('[GMAIL-AUTH] If draft creation fails with insufficient permissions, delete the token file and re-run auth.');
      return oauth2Client;
    }
    console.warn('[GMAIL-AUTH] Token present but account mismatch — re-authorizing…');
  }

  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  console.log('\n[GMAIL-AUTH] Opening browser for Gmail authorization…');
  console.log('[GMAIL-AUTH] Scopes:', SCOPES.join(', '));
  console.log('[GMAIL-AUTH] URL:', authUrl);

  const code = await waitForOAuthCode(oauth2Client, authUrl);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const verified = await verifyAccount(oauth2Client);
  if (!verified) {
    throw new Error('[GMAIL-AUTH] Authorized account does not match MARKETING_GMAIL_ACCOUNT — aborting');
  }

  saveToken(oauth2Client);
  console.log('[GMAIL-AUTH] Token saved. Auth complete.');
  return oauth2Client;
}

export async function getAuthorizedClient() {
  const oauth2Client = getOAuth2Client();
  if (!loadSavedToken(oauth2Client)) {
    throw new Error('Gmail not authorized. Run: npm run marketing:gmail:auth');
  }
  // Refresh if needed
  try {
    await oauth2Client.getAccessToken();
    saveToken(oauth2Client);
  } catch (err) {
    throw new Error(`Gmail token refresh failed: ${err.message}. Re-run: npm run marketing:gmail:auth`);
  }
  const verified = await verifyAccount(oauth2Client);
  if (!verified) {
    throw new Error('Authorized Gmail account does not match MARKETING_GMAIL_ACCOUNT. Re-run: npm run marketing:gmail:auth');
  }
  return oauth2Client;
}

async function verifyAccount(oauth2Client) {
  const expected = process.env.MARKETING_GMAIL_ACCOUNT;
  if (!expected) {
    console.warn('[GMAIL-AUTH] MARKETING_GMAIL_ACCOUNT not set — skipping account verification');
    return true;
  }
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const actual = profile.data.emailAddress;
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      console.error(`[GMAIL-AUTH] Account mismatch: expected ${expected}, got ${actual}`);
      return false;
    }
    console.log(`[GMAIL-AUTH] Verified account: ${actual}`);
    return true;
  } catch (err) {
    console.warn(`[GMAIL-AUTH] Could not verify account: ${err.message}`);
    return false;
  }
}

function waitForOAuthCode(oauth2Client, authUrl) {
  return new Promise((resolve, reject) => {
    const port = 3838;
    let resolved = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        res.end(`<html><body><h2>Auth failed: ${error}</h2></body></html>`);
        if (!resolved) { resolved = true; server.close(); reject(new Error(`OAuth error: ${error}`)); }
        return;
      }
      if (code) {
        res.end('<html><body><h2>Authorization successful — you can close this tab.</h2></body></html>');
        server.close();
        if (!resolved) { resolved = true; resolve(code); }
      }
    });
    server.listen(port, () => {
      console.log(`[GMAIL-AUTH] Listening on http://localhost:${port} for OAuth callback`);
      // Try to open browser (best-effort — user can open the URL manually)
      import('child_process').then(({ exec }) => {
        exec(`open "${authUrl}" || xdg-open "${authUrl}" || start "${authUrl}"`);
      }).catch(() => {});
    });
    server.on('error', reject);
    setTimeout(() => { if (!resolved) { resolved = true; server.close(); reject(new Error('Auth timeout — no callback received')); } }, 120_000);
  });
}
