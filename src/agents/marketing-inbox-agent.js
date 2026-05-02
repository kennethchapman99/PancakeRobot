/**
 * Marketing Inbox Agent
 * Reads, classifies, and stores Gmail inbox messages.
 * Read-only. Never sends, archives, or deletes.
 */

import { fetchInboxMessages } from '../marketing/gmail-reader.js';
import { upsertInboxMessage, getInboxSummary } from '../shared/marketing-inbox-db.js';
import { createMarketingAgentRun, logMarketingAgentRun, finishMarketingAgentRun } from '../shared/marketing-db.js';

export async function runInboxScan(options = {}) {
  const runId = createMarketingAgentRun({ agentName: 'marketing-inbox-agent', runType: 'inbox_scan', input: options });
  const log = (level, msg) => { logMarketingAgentRun(runId, level, msg); if (options.logger) options.logger(`[${level}] ${msg}`); else console.log(`[INBOX-SCAN] ${msg}`); };

  try {
    log('info', 'Fetching inbox messages (read-only)…');

    const messages = await fetchInboxMessages({
      query: options.query || `newer_than:${options.days || 14}d`,
      maxResults: options.maxResults || 50,
      labelIds: options.labelIds || ['INBOX'],
    });

    log('info', `Fetched ${messages.length} messages`);

    if (options.dryRun !== false && process.env.MARKETING_GMAIL_DRY_RUN !== 'false') {
      log('info', 'Dry run — printing classifications, not writing to DB');
      for (const m of messages) {
        log('info', `[${m.classification}${m.requires_ken ? ' NEEDS-KEN' : ''}] From: ${m.from_email} | Subject: ${m.subject}`);
      }
      const result = { status: 'done', dryRun: true, fetched: messages.length, messages: messages.map(m => ({ gmail_message_id: m.gmail_message_id, from_email: m.from_email, subject: m.subject, classification: m.classification, requires_ken: m.requires_ken })) };
      finishMarketingAgentRun(runId, 'done', result);
      return result;
    }

    let saved = 0;
    for (const m of messages) {
      upsertInboxMessage(m);
      saved++;
      log('info', `[${m.classification}] ${m.from_email} — ${m.subject}`);
    }

    const summary = getInboxSummary();
    log('info', `Inbox scan complete: ${saved} saved. Needs Ken: ${summary.needs_ken}, DNC: ${summary.do_not_contact}`);
    const result = { status: 'done', dryRun: false, fetched: messages.length, saved, summary };
    finishMarketingAgentRun(runId, 'done', result);
    return result;
  } catch (err) {
    log('error', `Inbox scan failed: ${err.message}`);
    finishMarketingAgentRun(runId, 'error', null, err.message);
    throw err;
  }
}
