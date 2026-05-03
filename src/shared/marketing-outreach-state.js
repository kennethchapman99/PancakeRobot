import { getOutreachItem, updateOutreachItem } from './marketing-outreach-db.js';
import { logMarketingEvent } from './marketing-events-db.js';

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

  const fields = {
    ...payload.fields,
    status: transition.to,
  };

  updateOutreachItem(itemId, fields);

  const updated = getOutreachItem(itemId);
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

export function canTransitionOutreachItem(item, action) {
  const transition = TRANSITIONS[action];
  if (!transition) return false;
  return transition.from.includes(item?.status || 'queued');
}

export function listOutreachTransitions() {
  return TRANSITIONS;
}
