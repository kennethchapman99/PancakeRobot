/**
 * Marketing Inbox Agent
 * Reads, classifies, and stores Gmail inbox messages.
 * Read-only. Never sends, archives, or deletes.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchInboxMessages } from '../marketing/gmail-reader.js';
import { upsertInboxMessage, getInboxSummary } from '../shared/marketing-inbox-db.js';
import { createMarketingAgentRun, logMarketingAgentRun, finishMarketingAgentRun, updateMarketingTarget } from '../shared/marketing-db.js';
import { getOutreachItems, updateOutreachItem } from '../shared/marketing-outreach-db.js';
import { transitionOutreachItem } from '../shared/marketing-outreach-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKETING_OUTPUT_DIR = join(__dirname, '../../output/marketing');
const SCAN_RESULTS_PATH = join(MARKETING_OUTPUT_DIR, 'gmail-scan-results.json');

function writeScanResults(messages) {
  fs.mkdirSync(MARKETING_OUTPUT_DIR, { recursive: true });
  const payload = {
    scannedAt: new Date().toISOString(),
    account: process.env.MARKETING_GMAIL_ACCOUNT || 'pancake.robot.music@gmail.com',
    messages: messages.map(m => ({
      from: m.from_email || '',
      subject: m.subject || '',
      classification: m.classification || 'unclassified',
      status: 'NEEDS-KEN',
      snippet: m.snippet || '',
      messageId: m.gmail_message_id || '',
      date: m.received_at || '',
    })),
  };
  fs.writeFileSync(SCAN_RESULTS_PATH, JSON.stringify(payload, null, 2));
}

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
    writeScanResults(messages);
    log('info', `Wrote scan results to ${SCAN_RESULTS_PATH}`);

    if (options.dryRun !== false && process.env.MARKETING_GMAIL_DRY_RUN !== 'false') {
      log('info', 'Dry run — printing classifications, not writing to DB');
      for (const m of messages) {
        log('info', `[${m.classification}${m.requires_ken ? ' NEEDS-KEN' : ''}] From: ${m.from_email} | Subject: ${m.subject}`);
      }
      const result = { status: 'done', dryRun: true, fetched: messages.length, messages: messages.map(m => ({ gmail_message_id: m.gmail_message_id, from_email: m.from_email, subject: m.subject, classification: m.classification, requires_ken: m.requires_ken })) };
      finishMarketingAgentRun(runId, 'done', result);
      return result;
    }

    const processed = processInboxMessages(messages, { log });
    const { saved, updated } = processed;

    const summary = getInboxSummary();
    log('info', `Inbox scan complete: ${saved} new, ${updated} existing. Needs Ken: ${summary.needs_ken}, DNC: ${summary.do_not_contact}`);
    const result = { status: 'done', dryRun: false, fetched: messages.length, saved, updated, summary };
    finishMarketingAgentRun(runId, 'done', result);
    return result;
  } catch (err) {
    log('error', `Inbox scan failed: ${err.message}`);
    finishMarketingAgentRun(runId, 'error', null, err.message);
    throw err;
  }
}

export function processInboxMessages(messages = [], options = {}) {
  let saved = 0;
  let updated = 0;
  for (const m of messages) {
    const linked = linkInboxMessageToOutreach(m);
    const result = upsertInboxMessage({ ...m, ...linked });
    if (linked.target_id) applyInboxMessageState(linked, m);
    if (result.isNew) saved++;
    else updated++;
    if (options.log) options.log('info', `[${m.classification}] ${m.from_email} — ${m.subject}${result.isNew ? ' [new]' : ' [existing]'}`);
  }
  return { saved, updated };
}

function linkInboxMessageToOutreach(message) {
  const items = getOutreachItems({});
  const normalizedFrom = String(message.from_email || '').trim().toLowerCase();
  const linkedItem = items.find(item =>
    (message.gmail_thread_id && item.gmail_thread_id && message.gmail_thread_id === item.gmail_thread_id)
    || ((item.outlet_context?.contact_email || item.outlet_context?.contact?.email || '').trim().toLowerCase() === normalizedFrom),
  );

  if (!linkedItem) return {};
  return {
    campaign_id: linkedItem.campaign_id,
    release_marketing_id: linkedItem.release_marketing_id || null,
    outreach_item_id: linkedItem.id,
    target_id: linkedItem.target_id,
    result_status: classificationToResultStatus(message.classification),
  };
}

function applyInboxMessageState(linked, message) {
  const item = linked.outreach_item_id ? getOutreachItems({}).find(entry => entry.id === linked.outreach_item_id) : null;
  if (!item) return;

  const classification = message.classification;
  const replyClassifications = new Set(['safe_reply_candidate', 'playlist_reply', 'blog_media_reply', 'creator_reply', 'opportunity', 'needs_ken', 'do_not_contact']);

  if (replyClassifications.has(classification) && item.status !== 'replied') {
    transitionOutreachItem(item.id, 'mark_replied', {
      actor: 'marketing-inbox-agent',
      fields: { replied_at: message.received_at || new Date().toISOString() },
      message: `Inbox classification: ${classification}`,
      metadata: { gmail_message_id: message.gmail_message_id },
    });
  } else if (classification === 'submission_confirmation') {
    updateOutreachItem(item.id, { safety_notes: appendNote(item.safety_notes, `Inbox confirmation: ${message.subject || message.gmail_message_id}`) });
  }

  if (classification === 'do_not_contact') {
    updateMarketingTarget(item.target_id, {
      suppression_status: 'do_not_contact',
      suppression_reason: message.subject || 'Inbox opt-out',
      suppression_source: 'gmail_inbox_scan',
      last_outcome: 'do_not_contact',
    });
  } else if (classification === 'opportunity') {
    updateMarketingTarget(item.target_id, { last_outcome: 'opportunity' });
  } else if (classification === 'safe_reply_candidate') {
    updateMarketingTarget(item.target_id, { last_outcome: 'replied' });
  }
}

function classificationToResultStatus(classification) {
  if (classification === 'do_not_contact') return 'suppressed';
  if (classification === 'opportunity') return 'opportunity';
  if (['safe_reply_candidate', 'playlist_reply', 'blog_media_reply', 'creator_reply'].includes(classification)) return 'replied';
  if (classification === 'submission_confirmation') return 'confirmed';
  return classification || null;
}

function appendNote(existing, next) {
  return [existing, next].filter(Boolean).join('\n');
}
