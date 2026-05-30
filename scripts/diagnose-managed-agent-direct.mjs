#!/usr/bin/env node
/**
 * Diagnose the managed-agent DIRECT (noTools) call path used by album generation.
 *
 * This deliberately drives the EXACT same helper the album orchestrator uses
 * (`runAgent` + `ALBUM_ORCHESTRATOR_DEF`) instead of a hand-written Anthropic
 * SDK call, so whatever breaks album generation breaks here too — and the
 * improved nested-cause diagnostics in managed-agent.js print the real reason
 * behind a generic "Connection error." / "fetch failed".
 *
 * Secrets are never printed: only key presence, base-URL presence/value (only
 * if explicitly set), and a redacted request-option summary.
 *
 * Run:  node scripts/diagnose-managed-agent-direct.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load .env the same way the web server / orchestrator do (override shell env),
// BEFORE importing managed-agent so the singleton client sees the real key.
const dotenv = require('dotenv');
dotenv.config({ path: join(__dirname, '../.env'), override: true });

const {
  runAgent,
  buildDirectMessagesPayload,
  summarizeRequestOptions,
  getManagedAgentDiagnostics,
  describeErrorChain,
} = await import('../src/shared/managed-agent.js');
const { ALBUM_ORCHESTRATOR_DEF } = await import('../src/agents/album-orchestrator.js');

const MODEL = ALBUM_ORCHESTRATOR_DEF.model || 'claude-sonnet-4-6';
const MAX_TOKENS = ALBUM_ORCHESTRATOR_DEF.maxTokens || 16000;

const PROMPTS = [
  { label: 'tiny', task: 'ping' },
  { label: 'album-like', task: 'Design a cohesive 6-track album plan for the active brand. Return concise JSON only.' },
];

function hr(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function printEnvAndClientState(when) {
  const d = getManagedAgentDiagnostics();
  console.log(`[${when}] api_key_present=${d.apiKeyPresent}`);
  console.log(`[${when}] base_url_configured=${d.baseURLConfigured}` + (d.baseURLConfigured ? ` base_url=${d.baseURL}` : ''));
  console.log(`[${when}] singleton_client_instantiated=${d.clientInstantiated}` +
    (d.clientInstantiated
      ? ` (client_base_url=${d.clientBaseURL} timeout_ms=${d.clientTimeoutMs} client_max_retries=${d.clientMaxRetries})`
      : ' (will be newly created on first call)'));
  console.log(`[${when}] default_direct_max_tokens=${d.defaultDirectMaxTokens} default_retry_delay_ms=${d.defaultDirectRetryDelayMs}`);
  return d;
}

async function runOne({ label, task }) {
  hr(`PROMPT: ${label}`);

  // Faithful copy of the payload runAgentDirect builds, summarized w/ secrets redacted.
  const payload = buildDirectMessagesPayload({ model: MODEL, maxTokens: MAX_TOKENS, system: ALBUM_ORCHESTRATOR_DEF.system, task });
  console.log('request_options (redacted):', JSON.stringify(summarizeRequestOptions(payload), null, 2));
  console.log('app-level timeout/AbortController/signal: none set in app code (SDK client defaults apply)');

  const before = getManagedAgentDiagnostics().clientInstantiated;
  try {
    // EXACT album-generation path: noTools def → runAgentDirect, same { maxTokens } as generateAlbumPlan.
    const result = await runAgent('album-orchestrator', ALBUM_ORCHESTRATOR_DEF, task, { maxTokens: MAX_TOKENS });
    const after = getManagedAgentDiagnostics().clientInstantiated;
    console.log(`\nRESULT: OK — ${result.usage?.inputTokens ?? '?'}in/${result.usage?.outputTokens ?? '?'}out tokens, ${result.runtimeSeconds?.toFixed?.(1) ?? '?'}s`);
    console.log(`client_singleton: ${before ? 'reused existing' : 'newly created this call'} (instantiated_after=${after})`);
    console.log('first 200 chars of text:', JSON.stringify(String(result.text || '').slice(0, 200)));
    return { label, ok: true };
  } catch (err) {
    const after = getManagedAgentDiagnostics().clientInstantiated;
    console.log(`\nRESULT: FAILED — ${err.message}`);
    console.log(`client_singleton: ${before ? 'reused existing' : 'newly created this call'} (instantiated_after=${after})`);
    console.log('full nested cause chain (secrets redacted):');
    console.log(JSON.stringify(describeErrorChain(err), null, 2));
    return { label, ok: false, error: err.message };
  }
}

async function main() {
  hr('MANAGED-AGENT DIRECT-CALL DIAGNOSTIC');
  console.log(`model=${MODEL} max_tokens=${MAX_TOKENS} provider=anthropic tools=none (noTools)`);
  printEnvAndClientState('before');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\nANTHROPIC_API_KEY is not present after loading .env — cannot run live calls. Fix .env first.');
    process.exitCode = 2;
    return;
  }

  const results = [];
  for (const prompt of PROMPTS) {
    results.push(await runOne(prompt));
  }

  hr('SUMMARY');
  printEnvAndClientState('after');
  for (const r of results) {
    console.log(`- ${r.label}: ${r.ok ? 'OK' : `FAILED (${r.error})`}`);
  }
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
}

main().catch(err => {
  console.error('diagnostic harness crashed:', err?.message);
  console.error(JSON.stringify(describeErrorChain(err), null, 2));
  process.exitCode = 3;
});
