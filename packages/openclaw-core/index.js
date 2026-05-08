export class WorkflowError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.context = context;
  }
}

export function createWorkflowRunId(prefix = 'RUN') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${ts}_${rand}`;
}

export function createIdempotencyKey(parts = []) {
  return parts
    .map(part => String(part ?? '').trim())
    .filter(Boolean)
    .join(':')
    .toLowerCase();
}

export class WorkflowEventEmitter {
  constructor({ onEvent } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.events = [];
  }

  async emit(event) {
    const normalized = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.events.push(normalized);
    if (this.onEvent) await this.onEvent(normalized);
    return normalized;
  }
}

export async function runWorkflow({
  name,
  input,
  steps,
  runId = createWorkflowRunId('WF'),
  onEvent,
  context = {},
}) {
  if (!name) throw new WorkflowError('Workflow name is required');
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new WorkflowError(`Workflow ${name} requires at least one step`);
  }

  const emitter = new WorkflowEventEmitter({ onEvent });
  const state = {
    runId,
    name,
    input,
    context,
    startedAt: new Date().toISOString(),
    status: 'running',
    stepResults: {},
  };

  await emitter.emit({ type: 'workflow_started', runId, workflow: name, input });

  try {
    for (const step of steps) {
      if (!step?.id || typeof step.run !== 'function') {
        throw new WorkflowError(`Workflow ${name} has an invalid step`, { step });
      }

      await emitter.emit({ type: 'step_started', runId, workflow: name, stepId: step.id, label: step.label || step.id });
      const result = await step.run({ state, emit: event => emitter.emit({ runId, workflow: name, ...event }) });
      state.stepResults[step.id] = result;
      await emitter.emit({ type: 'step_completed', runId, workflow: name, stepId: step.id, label: step.label || step.id, result });
    }

    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    await emitter.emit({ type: 'workflow_completed', runId, workflow: name, result: state.result || state.stepResults });
    return { ...state, events: emitter.events };
  } catch (error) {
    const enrichedError = enrichWorkflowError(error, { runId, workflow: name });
    state.status = 'failed';
    state.failedAt = new Date().toISOString();
    state.error = {
      name: enrichedError.name,
      message: enrichedError.message,
      context: enrichedError.context || {},
    };
    await emitter.emit({ type: 'workflow_failed', runId, workflow: name, error: state.error });
    throw enrichedError;
  }
}

function enrichWorkflowError(error, context) {
  if (!error.context || typeof error.context !== 'object') error.context = {};
  error.context = {
    ...context,
    ...error.context,
  };
  return error;
}
