import { createOutreachEvent, getOutreachItem, updateOutreachItem } from './marketing-outreach-db.js';
import { logMarketingEvent } from './marketing-events-db.js';
import { updateMarketingTarget } from './marketing-db.js';
import { updateSongLastOutreach } from './song-marketing-kit.js';

const TRANSITIONS = {
  queue: {
    from: ['queued', 'needs_ken'],
    to: 'queued',
  },
  mark_needs_ken: {
    from: ['queued', 'draft_generated', 'ready_for_gmail_draft', 'gmail_draft_created', 'manual_submitted', 'needs_ken'],
    to: 'needs_ken',
  },
  generate_draft: {
    from: ['queued', 'needs_ken', 'draft_generated', 'ready_for_gmail_draft'],
    to: 'draft_generated',
  },
  mark_ready_for_gmail_draft: {
    from: ['draft_generated', 'needs_ken'],
    to: 'ready_for_gmail_draft',
  },
  create_gmail_draft: {
    from: ['draft_generated', 'ready_for_gmail_draft', 'needs_ken'],
    to: 'gmail_draft_created',
  },
  block_gmail_draft: {
    from: ['queued', 'draft_generated', 'ready_for_gmail_draft', 'needs_ken'],
    to: 'needs_ken',
  },
  mark_manual_submitted: {
    from: ['queued', 'draft_generated', 'ready_for_gmail_draft', 'needs_ken'],
    to: 'manual_submitted',
  },
  mark_sent: {
    from: ['gmail_draft_created'],
    to: 'sent',
  },
  mark_replied: {
    from: ['gmail_draft_created', 'manual_submitted', 'sent', 'needs_ken'],
    to: 'replied',
  },
  suppress: {
    from: ['queued', 'needs_ken', 'draft_generated', 'ready_for_gmail_draft', 'gmail_draft_created', 'manual_submitted'],
    to: 'do_not_contact',
  },
  cancel: {
    from: ['queued', 'needs_ken', 'draft_generated', 'ready_for_gmail_draft'],
    to: 'cancelled',
  },
};

export function transitionOutreachItem(itemId, action, payload = {}) {
  const item = getOutreachItem(itemId);
  if (!item) throw new Error(`Outreach item not found: ${itemId}`);

  const transition = TRANSITIONS[action];
  if (!transition) throw new Error(`Unknown outreach transition action: ${action}`);

  const current = item.status || 'queued';
  if (!transition.from.includes(current)) {
    throw new Error(`Invalid outreach transition: ${current} -> ${transition.to} via ${action}`);
  }

  const now = new Date().toISOString();
  const fields = {
    ...payload.fields,
    status: transition.to,
  };
  if (action === 'mark_manual_submitted' || action === 'mark_sent') {
    fields.sent_at = fields.sent_at || item.sent_at || now;
  }
  if (action === 'mark_replied') {
    fields.replied_at = fields.replied_at || item.replied_at || now;
  }

  updateOutreachItem(itemId, fields);

  const updated = getOutreachItem(itemId);
  maybeCreateOutreachHistoryEvent(updated, action, payload);
  logMarketingEvent({
    event_type: `outreach_${action}`,
    actor: payload.actor || 'system',
    campaign_id: updated.campaign_id,
    outreach_item_id: updated.id,
    target_id: updated.target_id,
    song_id: updated.song_id,
    message: payload.message || `${current} -> ${transition.to}`,
    payload: {
      from_status: current,
      to_status: transition.to,
      action,
      fields,
      metadata: payload.metadata || {},
    },
  });

  return updated;
}

function maybeCreateOutreachHistoryEvent(item, action, payload) {
  if (!['mark_manual_submitted', 'mark_sent', 'mark_replied'].includes(action)) return;

  const release = Array.isArray(item.release_context) && item.release_context.length ? item.release_context[0] : {};
  const outlet = item.outlet_context || {};
  const recipientEmail = outlet.public_email || outlet.contact_email || outlet.contact?.email || null;
  const recipientHandle = outlet.contact?.handle || outlet.handle || null;
  const channel = outlet.contactability?.best_channel
    || (recipientEmail ? 'email' : outlet.submission_form_url || outlet.contact?.method ? 'contact_form' : 'unknown');
  const eventStatus = action === 'mark_replied' ? 'replied' : 'sent';

  createOutreachEvent({
    outreach_item_id: item.id,
    campaign_id: item.campaign_id,
    target_id: item.target_id,
    song_id: item.song_id,
    release_id: release.id || item.song_id,
    release_title: release.title || item.song_id,
    channel,
    recipient_name: outlet.contact?.name || outlet.name || item.outlet_name || null,
    recipient_email: recipientEmail,
    recipient_handle: recipientHandle,
    subject: item.subject || null,
    message_body: item.body || null,
    status: eventStatus,
    gmail_message_id: item.gmail_message_id || null,
    gmail_thread_id: item.gmail_thread_id || null,
    contacted_at: item.sent_at || payload.fields?.sent_at || new Date().toISOString(),
    replied_at: eventStatus === 'replied' ? (item.replied_at || new Date().toISOString()) : null,
    notes: payload.message || null,
    raw_json: {
      action,
      outlet_context: outlet,
      release_context: release,
    },
  });

  updateMarketingTarget(item.target_id, {
    last_contact_at: item.sent_at || payload.fields?.sent_at || new Date().toISOString(),
    last_contact_release_marketing_id: item.release_marketing_id || release.id || item.song_id,
    last_contact_release_title: release.title || item.song_id,
    last_contact_subject: item.subject || null,
    last_contact_body_preview: String(item.body || '').slice(0, 240) || null,
    last_outcome: eventStatus,
  });
  updateSongLastOutreach(item.song_id, {
    datetime: item.sent_at || payload.fields?.sent_at || new Date().toISOString(),
    release_id: item.release_marketing_id || release.id || item.song_id,
    release_title: release.title || item.song_id,
    message_summary: item.subject || null,
    recipient_count: 1,
  });
}

export function canTransitionOutreachItem(item, action) {
  const transition = TRANSITIONS[action];
  if (!transition) return false;
  return transition.from.includes(item?.status || 'queued');
}

export function listOutreachTransitions() {
  return TRANSITIONS;
}
