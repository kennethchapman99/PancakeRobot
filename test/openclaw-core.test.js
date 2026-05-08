import assert from 'node:assert/strict';
import test from 'node:test';

import { runWorkflow, WorkflowError } from '../packages/openclaw-core/index.js';

test('runWorkflow executes steps and returns state', async () => {
  const events = [];
  const state = await runWorkflow({
    name: 'test_workflow',
    input: { theme: 'test' },
    runId: 'WF_TEST',
    onEvent: event => events.push(event),
    steps: [
      {
        id: 'first',
        run: async ({ state }) => {
          state.context.value = 1;
          return { ok: true };
        },
      },
      {
        id: 'second',
        run: async ({ state }) => {
          return { value: state.context.value + 1 };
        },
      },
    ],
  });

  assert.equal(state.status, 'completed');
  assert.equal(state.runId, 'WF_TEST');
  assert.deepEqual(state.stepResults.first, { ok: true });
  assert.deepEqual(state.stepResults.second, { value: 2 });
  assert.equal(events[0].type, 'workflow_started');
  assert.equal(events.at(-1).type, 'workflow_completed');
});

test('runWorkflow enriches errors with run context', async () => {
  await assert.rejects(
    () => runWorkflow({
      name: 'failing_workflow',
      input: {},
      runId: 'WF_FAIL',
      steps: [
        {
          id: 'fail',
          run: async () => {
            throw new WorkflowError('boom', { stage: 'fail' });
          },
        },
      ],
    }),
    error => {
      assert.equal(error.message, 'boom');
      assert.equal(error.context.runId, 'WF_FAIL');
      assert.equal(error.context.workflow, 'failing_workflow');
      assert.equal(error.context.stage, 'fail');
      return true;
    }
  );
});
