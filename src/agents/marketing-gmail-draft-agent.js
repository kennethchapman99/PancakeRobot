import { createGmailDraft } from '../marketing/gmail-drafts.js';
import { buildAttachmentPlanForOutreachItem, buildHtmlBodyForOutreachItem } from '../shared/marketing-email-assets.js';
import {
  getOutreachItem,
  getOutreachItems,
} from '../shared/marketing-outreach-db.js';
import { transitionOutreachItem } from '../shared/marketing-outreach-state.js';

export async function createGmailDraftForOutreachItem(itemId, options = {}) {
  let item = getOutreachItem(itemId);
  if (!item) throw new Error(`Outreach item not found: ${itemId}`);

  if (options.forceRecreate === true && ['gmail_draft_created', 'manual_submitted'].includes(item.status)) {
    transitionOutreachItem(item.id, 'mark_needs_ken', {
      actor: 'marketing-gmail-draft-agent',
      fields: {
        gmail_draft_id: null,
        gmail_draft_url: null,
        gmail_message_id: null,
        gmail_thread_id: null,
        sent_at: null,
        last_error: null,
        safety_status: 'ready_for_regeneration',
        safety_notes: appendNote(item.safety_notes, 'Existing Gmail draft state cleared before force re-creation.'),
        requires_ken: true,
      },
      message: 'Reset existing Gmail draft state for force re-creation',
      metadata: { forceRecreate: true },
    });
    item = getOutreachItem(itemId);
  }

  const preflight = validateDraftableItem(item, options);
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

  if (options.dryRun === true) {
    transitionOutreachItem(item.id, 'mark_needs_ken', {
      actor: 'marketing-gmail-draft-agent',
      fields: {
        last_error: null,
        safety_status: 'dry_run_preview',
        safety_notes: appendNote(item.safety_notes, 'Dry run enabled - no Gmail drafts were created.'),
        requires_ken: true,
      },
      message: 'Dry run preview only',
      metadata: { dryRun: true },
    });
    return { item_id: item.id, ok: true, dryRun: true, preview_only: true, gmail_draft_id: null, gmail_draft_url: null };
  }

  const to = getPreferredOutletEmail(item);
  const attachmentPlan = buildAttachmentPlanForOutreachItem(item);
  const result = await createGmailDraft({
    to,
    subject: item.subject,
    body: item.body,
    bodyHtml: buildHtmlBodyForOutreachItem(item),
    attachments: attachmentPlan.attachments,
    inlineImages: attachmentPlan.inlineImages,
    dryRun: options.dryRun === true,
  });

  transitionOutreachItem(item.id, 'create_gmail_draft', {
    actor: 'marketing-gmail-draft-agent',
    fields: {
      gmail_draft_id: result.gmail_draft_id,
      gmail_draft_url: result.gmail_draft_url,
      gmail_message_id: result.gmail_message_id,
      gmail_thread_id: result.gmail_thread_id,
      last_error: null,
      safety_status: 'gmail_draft_created',
      safety_notes: appendNote(
        item.safety_notes,
        `${result.dryRun ? 'Dry-run Gmail draft simulated' : `Gmail draft created: ${result.gmail_draft_id}`}${attachmentPlan.heroImage ? `; inline image ${attachmentPlan.heroImage.label || 'added'}` : ''}${attachmentPlan.attachedLabels.length ? `; attached ${attachmentPlan.attachedLabels.join(', ')}` : ''}`,
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
    .filter(item => {
      if (['sent', 'replied', 'do_not_contact'].includes(item.status)) return false;
      if (options.forceRecreate === true) return true;
      return !['gmail_draft_created', 'manual_submitted'].includes(item.status);
    });

  const results = [];
  for (const item of items) {
    try {
      results.push(await createGmailDraftForOutreachItem(item.id, options));
    } catch (error) {
      const friendlyError = normalizeGmailDraftError(error);
      try {
        transitionOutreachItem(item.id, 'block_gmail_draft', {
          actor: 'marketing-gmail-draft-agent',
          fields: {
            safety_status: 'gmail_draft_error',
            safety_notes: appendNote(item.safety_notes, friendlyError),
            last_error: friendlyError,
            requires_ken: true,
          },
          message: 'Gmail draft creation failed',
        });
      } catch {
        // Preserve original error in result.
      }
      results.push({ item_id: item.id, ok: false, error: friendlyError });
    }
  }

  return {
    campaign_id: campaignId,
    created: results.filter(r => r.ok && !r.preview_only).length,
    previewed: results.filter(r => r.preview_only).length,
    blocked: results.filter(r => r.blocked).length,
    failed: results.filter(r => r.error).length,
    results,
  };
}

function validateDraftableItem(item, options = {}) {
  const notes = [];
  const email = getPreferredOutletEmail(item);

  if (!email) notes.push('No outlet email available; use manual/contact-form submission instead');
  if (!item.subject || !item.body) notes.push('No generated subject/body yet; generate outreach draft first');
  if (item.status === 'do_not_contact') notes.push('Item is do-not-contact');
  if (item.safety_status === 'blocked') notes.push('Item is blocked by safety status');
  if (item.outlet_context?.ai_policy === 'banned') notes.push('Outlet AI policy is banned');
  if (item.outlet_context?.outreach_allowed === false) notes.push('Outlet is not allowed for outreach');
  if (item.gmail_draft_id && options.forceRecreate !== true) notes.push(`Gmail draft already exists: ${item.gmail_draft_id}`);

  return { ok: notes.length === 0, notes };
}

function appendNote(existing, next) {
  return [existing, next].filter(Boolean).join('\n');
}

function getPreferredOutletEmail(item) {
  return item.outlet_context?.contact_email
    || item.outlet_context?.public_email
    || item.outlet_context?.contact?.email
    || null;
}

function normalizeGmailDraftError(error) {
  const message = String(error?.message || error || '').trim();
  const lowered = message.toLowerCase();
  if (lowered.includes('insufficient authentication scopes') || lowered.includes('insufficientpermissions')) {
    return 'Gmail authorization is missing draft-creation scopes. Re-run: npm run marketing:gmail:auth';
  }
  if (lowered.includes('gmail not authorized')) {
    return 'Gmail is not authorized. Run: npm run marketing:gmail:auth';
  }
  if (lowered.includes('token refresh failed') || lowered.includes('account does not match')) {
    return `${message} Re-run: npm run marketing:gmail:auth`;
  }
  return message || 'Unknown Gmail draft creation error';
}
