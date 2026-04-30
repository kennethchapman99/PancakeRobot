import fs from 'fs';
import path from 'path';
import {
  createMarketingAgentRun,
  finishMarketingAgentRun,
  logMarketingAgentRun,
  upsertMarketingTarget,
} from '../shared/marketing-db.js';

/**
 * Thin-slice marketing research importer.
 *
 * This intentionally does not fabricate targets. It imports only real records from
 * MARKETING_RESEARCH_SOURCE_PATH, which should be produced by OpenClaw/Firecrawl
 * or by manual research. Every imported target must include at least:
 *   - name
 *   - type
 *   - source_url
 */
export async function runMarketingResearchImport({ sourcePath = process.env.MARKETING_RESEARCH_SOURCE_PATH } = {}) {
  const runId = createMarketingAgentRun({
    agentName: 'marketing-manager',
    runType: 'target_research_import',
    input: { sourcePath: sourcePath || null },
  });

  try {
    logMarketingAgentRun(runId, 'info', 'Marketing research import started.');

    if (!sourcePath || !String(sourcePath).trim()) {
      const message = 'No MARKETING_RESEARCH_SOURCE_PATH configured. Refusing to create placeholder targets.';
      logMarketingAgentRun(runId, 'blocked', message, {
        requiredEnv: 'MARKETING_RESEARCH_SOURCE_PATH',
        expectedFormat: 'JSON array or { "targets": [...] } with name, type, and source_url for each target.',
      });
      finishMarketingAgentRun(runId, 'blocked_missing_source', { imported: 0, skipped: 0 }, message);
      return { runId, status: 'blocked_missing_source', imported: 0, skipped: 0 };
    }

    const resolvedPath = path.resolve(sourcePath);
    if (!fs.existsSync(resolvedPath)) {
      const message = `Configured research source file does not exist: ${resolvedPath}`;
      logMarketingAgentRun(runId, 'blocked', message);
      finishMarketingAgentRun(runId, 'blocked_missing_file', { imported: 0, skipped: 0, resolvedPath }, message);
      return { runId, status: 'blocked_missing_file', imported: 0, skipped: 0 };
    }

    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    const targets = Array.isArray(parsed) ? parsed : Array.isArray(parsed.targets) ? parsed.targets : [];

    if (!targets.length) {
      const message = 'Research source contained no targets. Nothing imported.';
      logMarketingAgentRun(runId, 'warn', message, { resolvedPath });
      finishMarketingAgentRun(runId, 'done', { imported: 0, skipped: 0, resolvedPath });
      return { runId, status: 'done', imported: 0, skipped: 0 };
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const [index, target] of targets.entries()) {
      try {
        const id = upsertMarketingTarget({
          ...target,
          status: target.status || 'needs_review',
          recommendation: target.recommendation || 'manual_review',
          raw_json: target,
        });
        imported += 1;
        logMarketingAgentRun(runId, 'info', `Imported target: ${target.name}`, { id, source_url: target.source_url });
      } catch (error) {
        skipped += 1;
        const detail = { index, error: error.message, target };
        errors.push(detail);
        logMarketingAgentRun(runId, 'warn', `Skipped unsourced or invalid target at index ${index}: ${error.message}`, detail);
      }
    }

    const status = errors.length ? 'done_with_skips' : 'done';
    const output = { imported, skipped, errors, resolvedPath };
    finishMarketingAgentRun(runId, status, output);
    logMarketingAgentRun(runId, 'info', `Marketing research import finished. Imported=${imported}, skipped=${skipped}.`);
    return { runId, status, imported, skipped, errors };
  } catch (error) {
    logMarketingAgentRun(runId, 'error', error.message, { stack: error.stack });
    finishMarketingAgentRun(runId, 'error', null, error.message);
    return { runId, status: 'error', imported: 0, skipped: 0, error: error.message };
  }
}
