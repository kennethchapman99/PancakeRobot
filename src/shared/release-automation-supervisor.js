import { DISTROKID_RUN_EVENT_PREFIX } from '../../scripts/distrokid/lib.mjs';

export function createReleaseAutomationSupervisor({
  child,
  runId,
  action,
  command,
  script,
  releaseType,
  releaseId,
  logEvent,
  logPath = '',
  onFinalized = null,
}) {
  const state = {
    runId,
    action,
    command,
    script,
    releaseType,
    releaseId,
    blocked: false,
    blockedCode: '',
    blockedMessage: '',
    cancelRequested: false,
    finalized: false,
    exitCode: null,
    signal: null,
    logPath,
  };

  let stdoutBuffer = '';
  let stderrBuffer = '';

  const basePayload = (extra = {}) => ({
    runId,
    command,
    script,
    entityType: releaseType,
    releaseId,
    latest_run_log_path: state.logPath || '',
    ...extra,
  });

  const emit = (status, message, payload = {}) => {
    logEvent(status, message, basePayload(payload));
  };

  const handleEventLine = (line) => {
    const parsed = parseReleaseAutomationEvent(line);
    if (!parsed) return;
    if (parsed.latest_run_log_path) state.logPath = parsed.latest_run_log_path;
    if (parsed.status === 'blocked') {
      state.blocked = true;
      state.blockedCode = parsed.code || '';
      state.blockedMessage = parsed.message || '';
      emit('blocked', parsed.message || 'Automation blocked.', {
        active: true,
        code: parsed.code || '',
        event: parsed,
      });
    }
  };

  const drain = (chunk, source) => {
    const text = chunk.toString();
    if (source === 'stdout') stdoutBuffer += text;
    else stderrBuffer += text;
    const buffer = source === 'stdout' ? stdoutBuffer : stderrBuffer;
    const lines = buffer.split(/\r?\n/);
    const remainder = lines.pop() || '';
    for (const line of lines) handleEventLine(line);
    if (source === 'stdout') stdoutBuffer = remainder;
    else stderrBuffer = remainder;
  };

  child.stdout?.on('data', chunk => drain(chunk, 'stdout'));
  child.stderr?.on('data', chunk => drain(chunk, 'stderr'));

  child.on('error', error => {
    finalize('failed', error.message || 'Automation process failed to start.', {
      error: error.message || 'Automation process failed to start.',
    });
  });

  child.on('exit', (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
  });

  child.on('close', (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
    if (stdoutBuffer) handleEventLine(stdoutBuffer);
    if (stderrBuffer) handleEventLine(stderrBuffer);

    if (state.cancelRequested) {
      finalize('cancelled', 'Automation run cancelled.', {
        exitCode: code,
        signal,
      });
      return;
    }

    if (state.blocked) {
      finalize('blocked', state.blockedMessage || 'Automation blocked.', {
        exitCode: code,
        signal,
        code: state.blockedCode || '',
      });
      return;
    }

    if (code === 0) {
      finalize('complete', 'Automation process complete.', {
        exitCode: code,
        signal,
      });
      return;
    }

    finalize('failed', `Automation exited unexpectedly${formatExitSuffix(code, signal)}.`, {
      exitCode: code,
      signal,
      blocked: state.blocked,
      code: state.blockedCode || '',
    });
  });

  const finalize = (status, message, payload = {}) => {
    if (state.finalized) return;
    state.finalized = true;
    emit(status, message, {
      active: false,
      exitCode: state.exitCode,
      signal: state.signal,
      ...payload,
    });
    onFinalized?.({ ...state, status, message, payload });
  };

  return {
    state,
    cancel() {
      state.cancelRequested = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    },
  };
}

export function parseReleaseAutomationEvent(line) {
  const text = String(line || '').trim();
  if (!text.startsWith(DISTROKID_RUN_EVENT_PREFIX)) return null;
  try {
    return JSON.parse(text.slice(DISTROKID_RUN_EVENT_PREFIX.length));
  } catch {
    return null;
  }
}

function formatExitSuffix(code, signal) {
  if (signal) return ` (signal ${signal})`;
  if (code !== null && code !== undefined) return ` (exit ${code})`;
  return '';
}
