import { createGmailDraft } from '../marketing/gmail-drafts.js';
import { buildAttachmentPlanForOutreachItem } from '../shared/marketing-email-assets.js';
import {
  getOutreachItem,
  getOutreachItems,
} from '../shared/marketing-outreach-db.js';
import { transitionOutreachItem } from '../shared/marketing-outreach-state.js';

export async function createGmailDraftForOutreachItem(itemId, options = {}) {
  const item = getOutreachItem(itemId);
  if (!item) throw new Error(`Outreach item not found: ${itemId}`);

  const preflight = validateDraftableItem(item);
  if (!preflight.ok) {
    transitionOutreachItem(item.id, 'block_gmail_draft', {
      actor: 'marketing-gmail-draft-agent',
      fields: {
        safety_status: 'gmail_draft_blocked',
        safety_notes: preflight.notes.join('\n'),
        requires_ken: true,
      },
      message: 'Gmail draft blocked by preflight',
      metadata: { notes: preflight.notes },
    });
    return { item_id: item.id, ok: false, blocked: true, notes: preflight.notes };
  }

  const to = item.outlet_context?.contact_email || item.outlet_context?.contact?.email || null;
  const attachmentPlan = buildAttachmentPlanForOutreachItem(item);
  const result = await createGmailDraft({
    to,
    subject: item.subject,
    body: item.body,
    attachments: attachmentPlan.attachments,
    dryRun: options.dryRun === true,
  });

  transitionOutreachItem(item.id, 'create_gmail_draft', {
    actor: 'marketing-gmail-draft-agent',
    fields: {
      gmail_draft_id: result.gmail_draft_id,
      gmail_draft_url: result.gmail_draft_url,
      gmail_message_id: result.gmail_message_id,
      gmail_thread_id: result.gmail_thread_id,
      safety_status: 'gmail_draft_created',
      safety_notes: appendNote(
        item.safety_notes,
        `${result.dryRun ? 'Dry-run Gmail draft simulated' : `Gmail draft created: ${result.gmail_draft_id}`}${attachmentPlan.attachedLabels.length ? `; attached ${attachmentPlan.attachedLabels.join(', ')}` : ''}`,
      ),
      requires_ken: true,
    },
    message: 'Gmail draft created',
    metadata: result,
  });

  return { item_id: item.id, ok: true, ...result };
}

export async function createGmailDraftsForCampaign(campaignId, options = {}) {
  const items = getOutreachItems({ campaign_id: campaignId })
    .filter(item => !['sent', 'replied', 'do_not_contact', 'gmail_draft_created', 'manual_submitted'].includes(item.status));

  const results = [];
  for (const item of items) {
    try {
      results.push(await createGmailDraftForOutreachItem(item.id, options));
    } catch (error) {
      try {
        transitionOutreachItem(item.id, 'block_gmail_draft', {
          actor: 'marketing-gmail-draft-agent',
          fields: {
            safety_status: 'gmail_draft_error',
            safety_notes: appendNote(item.safety_notes, error.message),
            requires_ken: true,
          },
          message: 'Gmail draft creation failed',
        });
      } catch {
        // Preserve original error in result.
      }
      results.push({ item_id: item.id, ok: false, error: error.message });
    }
  }

  return {
    campaign_id: campaignId,
    created: results.filter(r => r.ok).length,
    blocked: results.filter(r => r.blocked).length,
    failed: results.filter(r => r.error).length,
    results,
  };
}

function validateDraftableItem(item) {
  const notes = [];
  const email = item.outlet_context?.contact_email || item.outlet_context?.contact?.email || null;

  if (!email) notes.push('No outlet email available; use manual/contact-form submission instead');
  if (!item.subject || !item.body) notes.push('No generated subject/body yet; generate outreach draft first');
  if (item.status === 'do_not_contact') notes.push('Item is do-not-contact');
  if (item.safety_status === 'blocked') notes.push('Item is blocked by safety status');
  if (item.outlet_context?.ai_policy === 'banned') notes.push('Outlet AI policy is banned');
  if (item.outlet_context?.outreach_allowed === false) notes.push('Outlet is not allowed for outreach');
  if (item.gmail_draft_id) notes.push(`Gmail draft already exists: ${item.gmail_draft_id}`);

  return { ok: notes.length === 0, notes };
}

function appendNote(existing, next) {
  return [existing, next].filter(Boolean).join('\n');
}
