import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BrowsyClient,
  classifyBrowsyStatus,
  normalizeContractMode,
  resolveBrowsyBaseUrl,
} from '../src/shared/browsy-client.js';

function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    const handler = handlers(url, method, calls.length);
    const status = handler.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: handler.statusText || '',
      async text() {
        return typeof handler.json === 'string' ? handler.json : JSON.stringify(handler.json ?? {});
      },
    };
  };
  return { fetchImpl, calls };
}

test('resolveBrowsyBaseUrl prefers BROWSY_BASE_URL then falls back', () => {
  assert.equal(resolveBrowsyBaseUrl({ BROWSY_BASE_URL: 'http://a' }), 'http://a');
  assert.equal(resolveBrowsyBaseUrl({ PANCAKE_BROWSY_BASE_URL: 'http://b' }), 'http://b');
  assert.equal(resolveBrowsyBaseUrl({}), 'http://localhost:3001');
});

test('normalizeContractMode keeps dry_run distinct and rejects unknown modes', () => {
  assert.equal(normalizeContractMode('dry-run'), 'dry_run');
  assert.equal(normalizeContractMode('preview'), 'preview');
  assert.equal(normalizeContractMode('live'), 'live');
  assert.equal(normalizeContractMode(''), 'preview');
  assert.throws(() => normalizeContractMode('submit'), /Unsupported Browsy mode/);
});

test('classifyBrowsyStatus buckets terminal, approvable, human and transient states', () => {
  assert.equal(classifyBrowsyStatus('completed').terminal, true);
  assert.equal(classifyBrowsyStatus('waiting_for_approval_to_submit').autoApprovable, true);
  assert.equal(classifyBrowsyStatus('waiting_for_2fa').needsHuman, true);
  assert.equal(classifyBrowsyStatus('waiting_for_2fa').autoApprovable, false);
  assert.equal(classifyBrowsyStatus('running').transient, true);
});

test('getContract hits the documented contract endpoint and unwraps contract', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ json: { ok: true, contract: { contractVersion: '1.0.0', requiredPayloadFields: ['artist'] } } }));
  const client = new BrowsyClient({ baseUrl: 'http://browsy.local', appId: 'pancake-robot', fetchImpl });
  const contract = await client.getContract({ workflowId: 'distrokid-single-submit', version: '1.0.0' });
  assert.equal(contract.contractVersion, '1.0.0');
  assert.equal(calls[0].url, 'http://browsy.local/api/apps/pancake-robot/workflows/distrokid-single-submit/contract?version=1.0.0');
  assert.equal(calls[0].method, 'GET');
});

test('startRun posts to /api/apps/:appId/workflows/:workflowId/runs and returns runId', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ status: 201, json: { ok: true, runId: 'run_1', status: 'running', contractVersion: '1.0.0' } }));
  const client = new BrowsyClient({ baseUrl: 'http://browsy.local', appId: 'pancake-robot', fetchImpl });
  const result = await client.startRun({ workflowId: 'distrokid-single-submit', mode: 'dry_run', payload: { artist: 'Pancake Robot' } });
  assert.equal(result.runId, 'run_1');
  assert.equal(result.status, 'running');
  assert.equal(calls[0].url, 'http://browsy.local/api/apps/pancake-robot/workflows/distrokid-single-submit/runs');
  assert.equal(calls[0].body.mode, 'dry_run');
  assert.equal(calls[0].body.callerId, 'pancake-robot');
  assert.deepEqual(calls[0].body.payload, { artist: 'Pancake Robot' });
});

test('startRun refuses live mode without an approvalToken', async () => {
  const { fetchImpl } = makeFetch(() => ({ json: { ok: true, runId: 'x' } }));
  const client = new BrowsyClient({ fetchImpl });
  await assert.rejects(
    client.startRun({ workflowId: 'w', mode: 'live', payload: {} }),
    /live runs require an approvalToken/,
  );
});

test('startRun includes approvalToken for live runs', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ status: 201, json: { ok: true, runId: 'run_live' } }));
  const client = new BrowsyClient({ baseUrl: 'http://b', fetchImpl });
  await client.startRun({ workflowId: 'w', mode: 'live', payload: {}, approvalToken: 'tok-123' });
  assert.equal(calls[0].body.approvalToken, 'tok-123');
});

test('pollUntilDone polls through transient states until terminal', async () => {
  const statuses = ['running', 'running', 'completed'];
  const { fetchImpl } = makeFetch((url, method, callNo) => ({
    json: { ok: true, run: { runId: 'run_1' }, result: { runId: 'run_1', status: statuses[callNo - 1] } },
  }));
  const client = new BrowsyClient({ baseUrl: 'http://b', fetchImpl });
  const seen = [];
  const final = await client.pollUntilDone('run_1', {
    intervalMs: 0,
    sleep: async () => {},
    onStatus: snap => { seen.push(snap.status); },
  });
  assert.deepEqual(seen, ['running', 'running', 'completed']);
  assert.equal(final.terminal, true);
  assert.equal(final.status, 'completed');
});

test('pollUntilDone stops on a waiting status without looping forever', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({
    json: { ok: true, result: { status: 'waiting_for_2fa' } },
  }));
  const client = new BrowsyClient({ baseUrl: 'http://b', fetchImpl });
  const final = await client.pollUntilDone('run_1', { intervalMs: 0, sleep: async () => {} });
  assert.equal(final.waiting, true);
  assert.equal(final.needsHuman, true);
  assert.equal(calls.length, 1);
});

test('approve and cancel and getArtifacts hit their endpoints', async () => {
  const { fetchImpl, calls } = makeFetch((url) => {
    if (url.endsWith('/artifacts')) return { json: { ok: true, artifacts: [{ name: 'shot.png', path: '/tmp/shot.png', type: 'screenshot' }], files: [] } };
    return { json: { ok: true } };
  });
  const client = new BrowsyClient({ baseUrl: 'http://b', fetchImpl });

  await client.approve('run_1', { approvedBy: 'ken', note: 'go', approvalToken: 't' });
  await client.cancel('run_1', { reason: 'changed mind' });
  const artifacts = await client.getArtifacts('run_1');

  assert.equal(calls[0].url, 'http://b/api/runs/run_1/approve');
  assert.equal(calls[0].body.approvedBy, 'ken');
  assert.equal(calls[1].url, 'http://b/api/runs/run_1/cancel');
  assert.equal(calls[2].url, 'http://b/api/runs/run_1/artifacts');
  assert.equal(artifacts.artifacts[0].path, '/tmp/shot.png');
});

test('non-ok responses throw with the server error message', async () => {
  const { fetchImpl } = makeFetch(() => ({ status: 404, statusText: 'Not Found', json: { ok: false, error: 'workflow missing' } }));
  const client = new BrowsyClient({ baseUrl: 'http://b', fetchImpl });
  await assert.rejects(client.getContract({ workflowId: 'nope' }), /workflow missing/);
});
