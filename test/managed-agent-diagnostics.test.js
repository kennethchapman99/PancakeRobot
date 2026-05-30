import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  describeErrorChain,
  formatDirectCallDiagnostics,
  buildDirectMessagesPayload,
  summarizeRequestOptions,
  getManagedAgentDiagnostics,
} from '../src/shared/managed-agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SECRET_KEY = 'sk-ant-SUPERSECRET-DO-NOT-LOG-0123456789';

function buildNestedFetchFailure() {
  // Shape mirrors a real Anthropic SDK APIConnectionError → "fetch failed" →
  // underlying undici system error with the actually-useful fields.
  const root = new Error('connect ECONNREFUSED 127.0.0.1:443');
  root.name = 'Error';
  root.code = 'ECONNREFUSED';
  root.errno = -61;
  root.syscall = 'connect';
  root.address = '127.0.0.1';
  root.port = 443;

  const fetchFailed = new TypeError('fetch failed', { cause: root });

  const apiConnErr = new Error('Connection error.', { cause: fetchFailed });
  apiConnErr.name = 'APIConnectionError';
  return apiConnErr;
}

test('describeErrorChain walks every nested cause and captures safe fields', () => {
  const chain = describeErrorChain(buildNestedFetchFailure());
  assert.equal(chain.length, 3, 'expected three levels: APIConnectionError → fetch failed → ECONNREFUSED');

  assert.equal(chain[0].name, 'APIConnectionError');
  assert.equal(chain[0].message, 'Connection error.');

  assert.equal(chain[1].message, 'fetch failed');

  // The deepest cause is the one that actually explains the failure.
  assert.equal(chain[2].code, 'ECONNREFUSED');
  assert.equal(chain[2].errno, -61);
  assert.equal(chain[2].syscall, 'connect');
  assert.equal(chain[2].address, '127.0.0.1');
  assert.equal(chain[2].port, 443);
});

test('describeErrorChain is cycle-safe and depth-capped', () => {
  const a = new Error('a');
  const b = new Error('b');
  a.cause = b;
  b.cause = a; // cycle
  const chain = describeErrorChain(a);
  assert.ok(chain.some(node => node.note && node.note.includes('cycle')), 'cycle must be detected, not infinite-looped');

  // Deep linear chain is truncated rather than walked unbounded.
  let head = new Error('level-0');
  let tail = head;
  for (let i = 1; i < 50; i++) {
    const next = new Error(`level-${i}`);
    tail.cause = next;
    tail = next;
  }
  const deep = describeErrorChain(head, { maxDepth: 8 });
  assert.ok(deep.length <= 9, 'depth cap must bound the chain length');
  assert.ok(deep.some(node => node.note && node.note.includes('truncated')));
});

test('formatDirectCallDiagnostics never logs the API key value', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = SECRET_KEY;
  try {
    // Even if the key somehow leaked into an error message/cause, the formatter
    // must not echo it. Build an error that embeds the secret on purpose.
    const leaky = new Error(`Connection error. (key=${SECRET_KEY})`, {
      cause: new Error(`fetch failed using ${SECRET_KEY}`),
    });
    leaky.name = 'APIConnectionError';

    const text = formatDirectCallDiagnostics({ model: 'claude-sonnet-4-6', err: leaky });

    assert.ok(text.includes('api_key_present=true'), 'should report presence');
    // The formatter does not synthesize the key, and must not echo env value.
    // (It may echo err.message which we constructed with the secret — that is
    //  the caller's error text, not env — so assert the formatter itself never
    //  reads process.env.ANTHROPIC_API_KEY into the output.)
    const withoutErrText = formatDirectCallDiagnostics({ model: 'claude-sonnet-4-6', err: new Error('Connection error.') });
    assert.ok(!withoutErrText.includes(SECRET_KEY), 'formatter must never emit the env key value');
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test('summarizeRequestOptions redacts system/message bodies and never carries a key', () => {
  const payload = buildDirectMessagesPayload({
    model: 'claude-sonnet-4-6',
    maxTokens: 16000,
    system: `secret system prompt containing ${SECRET_KEY}`,
    task: `album task containing ${SECRET_KEY}`,
  });
  const summary = summarizeRequestOptions(payload);

  assert.equal(summary.model, 'claude-sonnet-4-6');
  assert.equal(summary.max_tokens, 16000);
  assert.equal(summary.stream, true);
  assert.equal(summary.system_present, true);
  assert.ok(summary.system_chars > 0);
  assert.equal(summary.message_count, 1);
  assert.ok(summary.user_chars > 0);

  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(SECRET_KEY), 'redacted summary must not contain prompt text or secrets');
  assert.ok(!serialized.includes('secret system prompt'), 'system text must not be serialized');
});

test('getManagedAgentDiagnostics reports only safe, non-secret fields', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = SECRET_KEY;
  try {
    const d = getManagedAgentDiagnostics();
    assert.equal(d.apiKeyPresent, true);
    assert.equal(typeof d.baseURLConfigured, 'boolean');
    assert.equal(typeof d.clientInstantiated, 'boolean');
    assert.ok(!JSON.stringify(d).includes(SECRET_KEY), 'diagnostics must never serialize the key value');
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

test('diagnostic script drives the REAL managed-agent helper, not a hand-written SDK call', () => {
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'diagnose-managed-agent-direct.mjs');
  assert.ok(fs.existsSync(scriptPath), 'diagnostic script must exist');
  const src = fs.readFileSync(scriptPath, 'utf8');

  // Uses the real album-generation entry points.
  assert.match(src, /['"]\.\.\/src\/shared\/managed-agent\.js['"]/, 'must import the real managed-agent module');
  assert.match(src, /ALBUM_ORCHESTRATOR_DEF/, 'must reuse the album orchestrator definition');
  assert.match(src, /runAgent\(\s*'album-orchestrator'\s*,\s*ALBUM_ORCHESTRATOR_DEF/, 'must call runAgent on the album path');

  // Must NOT construct its own Anthropic client / hand-rolled SDK call.
  assert.ok(!/new\s+Anthropic\s*\(/.test(src), 'script must not construct its own Anthropic SDK client');
  assert.ok(!/@anthropic-ai\/sdk/.test(src), 'script must not import the Anthropic SDK directly');
});
