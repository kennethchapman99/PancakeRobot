import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOutletForApp } from '../src/shared/marketing-outlets.js';

test('paid membership outlets are marked ineligible', () => {
  const outlet = normalizeOutletForApp({
    id: 'kids_listen',
    name: 'Kids Listen',
    type: 'podcast',
    source_url: 'https://kidslisten.org/',
    raw_json: JSON.stringify({}),
    cost_policy_json: JSON.stringify({
      requires_payment: true,
      cost_type: 'membership',
      cost_amount: 100,
      cost_currency: 'USD',
      evidence_url: 'https://kidslisten.org/creator-membership',
      evidence_text: 'General Membership - $100/yr',
    }),
    ai_policy_details_json: JSON.stringify({ status: 'not_found' }),
    contactability_json: JSON.stringify({
      status: 'contactable',
      free_contact_method_found: true,
      best_channel: 'contact_form',
      contact_methods: [{ type: 'contact_form', value: 'https://kidslisten.org/contact', confidence: 'medium' }],
    }),
    outreach_eligibility_json: null,
  });

  assert.equal(outlet.eligible, false);
  assert.equal(outlet.cost_policy.requires_payment, true);
  assert.match(outlet.outreach_eligibility.reason_summary, /membership|required|payment/i);
});

test('banned AI policy outlets are marked ineligible', () => {
  const outlet = normalizeOutletForApp({
    id: 'ai_banned',
    name: 'Blocked Outlet',
    type: 'playlist',
    source_url: 'https://example.com',
    raw_json: JSON.stringify({}),
    cost_policy_json: JSON.stringify({ requires_payment: false, cost_type: 'free' }),
    ai_policy_details_json: JSON.stringify({ status: 'banned' }),
    contactability_json: JSON.stringify({
      status: 'contactable',
      free_contact_method_found: true,
      best_channel: 'email',
      contact_methods: [{ type: 'email', value: 'hello@example.com', confidence: 'high' }],
    }),
    outreach_eligibility_json: null,
  });

  assert.equal(outlet.eligible, false);
  assert.equal(outlet.ai_policy, 'banned');
  assert.ok(outlet.outreach_eligibility.reason_codes.includes('ai_music_banned'));
});

test('last_contact is derived from the newest outreach event', () => {
  const outlet = normalizeOutletForApp({
    id: 'history',
    name: 'History Outlet',
    type: 'blog',
    source_url: 'https://example.com',
    raw_json: JSON.stringify({}),
    cost_policy_json: JSON.stringify({ requires_payment: false, cost_type: 'free' }),
    ai_policy_details_json: JSON.stringify({ status: 'allowed' }),
    contactability_json: JSON.stringify({
      status: 'contactable',
      free_contact_method_found: true,
      best_channel: 'email',
      contact_methods: [{ type: 'email', value: 'hello@example.com', confidence: 'high' }],
    }),
  }, {
    outreachHistory: [
      {
        id: 'old',
        release_id: 'rel-old',
        release_title: 'Older Release',
        contacted_at: '2026-05-01T12:00:00.000Z',
        message_body: 'Older body',
        status: 'sent',
      },
      {
        id: 'new',
        release_id: 'rel-new',
        release_title: 'Newer Release',
        contacted_at: '2026-05-04T12:00:00.000Z',
        message_body: 'Newest body',
        status: 'sent',
      },
    ],
  });

  assert.equal(outlet.last_contact.release_id, 'rel-new');
  assert.equal(outlet.last_contact.outreach_id, 'new');
  assert.match(outlet.last_contact.message_preview, /Newest body/);
});
