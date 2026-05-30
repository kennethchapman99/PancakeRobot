import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  BROWSY_AUTH_PREFLIGHT_DEFAULT_RULES,
  classifyBrowsyAuthPreflight,
  runBrowsyAuthPreflight,
} from '../src/shared/browsy-client.js';

// ── Pure offline classifier (no Browsy needed) ────────────────────────────────

test('authenticated DistroKid target URL passes preflight', () => {
  const verdict = classifyBrowsyAuthPreflight({
    finalUrl: 'https://distrokid.com/new/',
    title: 'Upload your music - DistroKid',
    bodyText: 'Upload a new release. Album title, artwork, tracks…',
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, 'authenticated');
  assert.equal(verdict.matchedRule, null);
});

test('Google "this browser or app may not be secure" returns auth_rejected', () => {
  const verdict = classifyBrowsyAuthPreflight({
    finalUrl: 'https://accounts.google.com/v3/signin/rejected',
    title: "Couldn't sign you in",
    bodyText: 'This browser or app may not be secure. Try using a different browser.',
  });
  assert.equal(verdict.ok, false);
  // accounts.google.com matches the url rule first → auth_required; the rejection
  // text rule is auth_rejected. Either way the operator is steered to Open Auth
  // Browser, but the verdict must be a non-authenticated code.
  assert.ok(['auth_required', 'auth_rejected'].includes(verdict.code));
});

test('the secure-browser text alone is classified auth_rejected', () => {
  const verdict = classifyBrowsyAuthPreflight({
    finalUrl: 'https://distrokid.com/new/',
    title: 'DistroKid',
    bodyText: 'This browser or app may not be secure.',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'auth_rejected');
});

test('redirect to a /signin URL returns auth_required', () => {
  const verdict = classifyBrowsyAuthPreflight({
    finalUrl: 'https://distrokid.com/signin?next=/new/',
    title: 'Sign in',
    bodyText: 'Please sign in to continue.',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'auth_required');
  assert.equal(verdict.matchedRule.value, '/signin');
});

test('redirect to a /login URL returns auth_required', () => {
  const verdict = classifyBrowsyAuthPreflight({
    finalUrl: 'https://distrokid.com/login',
    title: 'Log in',
    bodyText: 'Log in to DistroKid.',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'auth_required');
});

test('default rules are exported and frozen', () => {
  assert.ok(BROWSY_AUTH_PREFLIGHT_DEFAULT_RULES.length >= 4);
  assert.equal(Object.isFrozen(BROWSY_AUTH_PREFLIGHT_DEFAULT_RULES), true);
});

// ── HTTP relay normalization against a mock Browsy ────────────────────────────

function startMockBrowsy(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      handler(req, res, body ? JSON.parse(body) : {});
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('runBrowsyAuthPreflight relays an authenticated verdict', async () => {
  const { server, baseUrl } = await startMockBrowsy((req, res, body) => {
    assert.equal(req.url, '/api/auth-profiles/preflight');
    assert.equal(body.targetUrl, 'https://distrokid.com/new/');
    assert.ok(Array.isArray(body.rules) && body.rules.length);
    res.end(JSON.stringify({
      ok: true,
      preflight: { mode: 'auth_preflight', ok: true, code: 'authenticated', finalUrl: 'https://distrokid.com/new/', message: 'Authenticated session detected — preflight passed.' },
    }));
  });
  try {
    const result = await runBrowsyAuthPreflight({
      appId: 'pancake-robot',
      authProfileId: 'distrokid',
      targetUrl: 'https://distrokid.com/new/',
      rules: BROWSY_AUTH_PREFLIGHT_DEFAULT_RULES,
      config: { baseUrl, appId: 'pancake-robot', timeoutMs: 5000 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reachable, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.code, 'authenticated');
  } finally {
    server.close();
  }
});

test('runBrowsyAuthPreflight relays a not-authenticated verdict', async () => {
  const { server, baseUrl } = await startMockBrowsy((req, res) => {
    res.end(JSON.stringify({
      ok: true,
      preflight: { mode: 'auth_preflight', ok: false, code: 'auth_required', finalUrl: 'https://accounts.google.com/signin', message: 'Target requires authentication.' },
    }));
  });
  try {
    const result = await runBrowsyAuthPreflight({
      appId: 'pancake-robot',
      authProfileId: 'distrokid',
      targetUrl: 'https://distrokid.com/new/',
      config: { baseUrl, appId: 'pancake-robot', timeoutMs: 5000 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reachable, true);
    assert.equal(result.authenticated, false);
    assert.equal(result.code, 'auth_required');
    assert.equal(result.finalUrl, 'https://accounts.google.com/signin');
  } finally {
    server.close();
  }
});

test('runBrowsyAuthPreflight reports unreachable Browsy without fabricating auth', async () => {
  const result = await runBrowsyAuthPreflight({
    appId: 'pancake-robot',
    authProfileId: 'distrokid',
    targetUrl: 'https://distrokid.com/new/',
    // Nothing is listening on this port.
    config: { baseUrl: 'http://127.0.0.1:9', appId: 'pancake-robot', timeoutMs: 1000 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reachable, false);
  assert.equal(result.authenticated, false);
});
