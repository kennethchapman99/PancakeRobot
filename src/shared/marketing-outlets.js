import { getOutreachEvents } from './marketing-outreach-db.js';

export const OUTREACH_REASON_CODES = [
  'requires_payment',
  'paid_submission_only',
  'paid_membership_required',
  'ai_music_banned',
  'no_contact_method',
  'dead_site',
  'not_relevant',
  'do_not_contact',
  'duplicate',
  'adult_or_not_family_safe',
  'brand_mismatch',
  'unclear_policy_needs_review',
];

export function normalizeOutletForApp(row, options = {}) {
  const raw = parseObject(row?.raw_json);
  const pitchPrefs = parseObject(row?.pitch_preferences);
  const outreachHistory = Array.isArray(options.outreachHistory)
    ? [...options.outreachHistory].sort((a, b) => compareIsoDatesDesc(a.contacted_at, b.contacted_at))
    : [];
  const aiMusicStance = raw.ai_music_stance || pitchPrefs.ai_music_stance || {};
  const priority = raw.priority || pitchPrefs.priority || null;
  const category = raw.category || pitchPrefs.category || row.type || null;
  const internalTest = looksLikeTestDemo(row, raw);
  const doNotContact = row?.status === 'do_not_contact' || ['suppressed', 'do_not_contact'].includes(row?.suppression_status) || raw.do_not_contact === true || internalTest;

  const costPolicy = normalizeCostPolicy(row, raw);
  const aiPolicyDetails = normalizeAiPolicyDetails(row, raw, aiMusicStance);
  const contactability = normalizeContactability(row, raw);
  const outreachEligibility = normalizeOutreachEligibility(row, {
    costPolicy,
    aiPolicyDetails,
    contactability,
    doNotContact,
  });
  const lastContact = buildLastContact(outreachHistory);

  return {
    id: row.id,
    name: row.name,
    brand_profile_id: row.brand_profile_id,
    status: row.status,
    suppression_status: row.suppression_status || 'none',
    suppression_reason: row.suppression_reason || null,
    suppression_source: row.suppression_source || null,
    recommendation: row.recommendation,
    priority,
    category,
    type: row.type,
    platforms: raw.platforms || splitCsv(row.platform),
    fit_score: row.fit_score,
    url: row.official_website_url || raw.url || row.source_url,
    source_url: row.source_url,
    official_website_url: row.official_website_url || raw.url || row.source_url,
    contact_page_url: row.contact_page_url || raw.contact_page_url || null,
    public_email: row.public_email || row.contact_email || raw.contact?.email || null,
    submission_form_url: row.submission_form_url || raw.submission_form_url || null,
    instagram_url: row.instagram_url || raw.instagram_url || null,
    tiktok_url: row.tiktok_url || raw.tiktok_url || null,
    youtube_url: row.youtube_url || raw.youtube_url || null,
    facebook_url: row.facebook_url || raw.facebook_url || null,
    twitter_url: row.twitter_url || raw.twitter_url || raw.x_url || null,
    threads_url: row.threads_url || raw.threads_url || null,
    playlist_link_url: row.playlist_link_url || raw.playlist_link_url || null,
    best_free_contact_method: row.best_free_contact_method || raw.best_free_contact_method || null,
    backup_contact_method: row.backup_contact_method || raw.backup_contact_method || null,
    contact: {
      email: row.contact_email || row.public_email || raw.contact?.email || null,
      method: row.contact_method || raw.contact?.submission_path || null,
      handle: row.handle || null,
      status: contactability.status,
    },
    contact_status: contactability.status,
    contactability,
    cost_policy: costPolicy,
    cost_status: summarizeCost(costPolicy),
    ai_policy: aiPolicyDetails.status,
    ai_policy_details: aiPolicyDetails,
    ai_risk_score: row.ai_risk_score,
    ai_risk_level: aiMusicStance.risk_level || riskLevelFromScore(row.ai_risk_score),
    ai_music_stance: aiMusicStance,
    outreach_eligibility: outreachEligibility,
    eligible: outreachEligibility.eligible,
    outreach_allowed: outreachEligibility.eligible,
    do_not_contact: doNotContact,
    internal_test: internalTest,
    last_contact: lastContact,
    last_contact_at: row.last_contact_at || lastContact?.contacted_at || null,
    last_contact_release_marketing_id: row.last_contact_release_marketing_id || null,
    last_contact_release_title: row.last_contact_release_title || lastContact?.release_title || null,
    last_contact_subject: row.last_contact_subject || null,
    last_contact_body_preview: row.last_contact_body_preview || lastContact?.message_preview || null,
    last_outcome: row.last_outcome || lastContact?.status || null,
    outreach_history: outreachHistory,
    recommended_pitch_type: raw.recommended_pitch_type || pitchPrefs.recommended_pitch_type || null,
    sample_pitch_hook: raw.sample_pitch_hook || row.outreach_angle || null,
    best_angles: raw.best_pancake_robot_angles || pitchPrefs.best_angles || [],
    assets_to_send: raw.assets_to_send || pitchPrefs.assets_to_send || [],
    outreach_sequence: raw.outreach_sequence || pitchPrefs.outreach_sequence || [],
    research_summary: row.research_summary,
    outreach_angle: row.outreach_angle,
    raw_json: raw,
  };
}

export function hydrateOutletsWithHistory(rows, { onlyStatuses = ['manual_submitted', 'sent', 'replied'] } = {}) {
  const ids = [...new Set(rows.map(row => row?.id).filter(Boolean))];
  const historyByTargetId = getOutreachHistoryByTargetIds(ids, { statuses: onlyStatuses });
  return rows.map(row => normalizeOutletForApp(row, { outreachHistory: historyByTargetId.get(row.id) || [] }));
}

export function getOutreachHistoryByTargetIds(targetIds = [], filters = {}) {
  const ids = [...new Set(targetIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();

  const events = getOutreachEvents({
    ...filters,
    target_ids: ids,
  });
  const map = new Map(ids.map(id => [id, []]));

  for (const event of events) {
    const list = map.get(event.target_id) || [];
    list.push(normalizeOutreachEvent(event));
    map.set(event.target_id, list);
  }

  for (const [id, items] of map.entries()) {
    items.sort((a, b) => compareIsoDatesDesc(a.contacted_at, b.contacted_at));
    map.set(id, items);
  }

  return map;
}

export function normalizeOutreachEvent(event) {
  const messageBody = String(event.message_body || '').trim();
  return {
    ...event,
    message_body: messageBody,
    message_preview: event.message_preview || truncateMessage(messageBody),
  };
}

export function buildLastContact(outreachHistory = []) {
  if (!Array.isArray(outreachHistory) || !outreachHistory.length) return null;
  const latest = outreachHistory
    .map(normalizeOutreachEvent)
    .sort((a, b) => compareIsoDatesDesc(a.contacted_at, b.contacted_at))[0];

  return {
    contacted_at: latest.contacted_at,
    release_id: latest.release_id,
    release_title: latest.release_title,
    message_preview: latest.message_preview,
    outreach_id: latest.id,
    status: latest.status,
    channel: latest.channel,
  };
}

export function outletContactedForRelease(outlet, releaseId) {
  const normalizedReleaseId = String(releaseId || '').trim();
  if (!normalizedReleaseId) return false;
  return Array.isArray(outlet?.outreach_history)
    && outlet.outreach_history.some(event => String(event.release_id || '').trim() === normalizedReleaseId);
}

export function compareIsoDatesDesc(a, b) {
  return new Date(b || 0).getTime() - new Date(a || 0).getTime();
}

function normalizeCostPolicy(row, raw) {
  const stored = parseObject(row.cost_policy_json) || {};
  const base = raw.cost_policy && typeof raw.cost_policy === 'object' ? raw.cost_policy : {};
  if (row?.id === 'kids_listen' && !stored.evidence_url && !base.evidence_url) {
    return {
      requires_payment: true,
      cost_type: 'membership',
      cost_amount: 100,
      cost_currency: 'USD',
      evidence_url: 'https://kidslisten.org/creator-membership',
      evidence_text: 'General Membership - $100/yr',
      confidence: 'high',
    };
  }
  return {
    requires_payment: boolOrNull(stored.requires_payment ?? base.requires_payment) === true,
    cost_type: stored.cost_type || base.cost_type || 'free',
    cost_amount: toNumberOrNull(stored.cost_amount ?? base.cost_amount),
    cost_currency: stored.cost_currency || base.cost_currency || null,
    evidence_url: stored.evidence_url || base.evidence_url || null,
    evidence_text: stored.evidence_text || base.evidence_text || null,
    confidence: stored.confidence || base.confidence || null,
  };
}

function normalizeAiPolicyDetails(row, raw, aiMusicStance) {
  const stored = parseObject(row.ai_policy_details_json) || {};
  const sourceStatus = String(stored.status || row.ai_policy || aiMusicStance.status || '').toLowerCase();

  let status = 'not_found';
  if (sourceStatus === 'banned') status = 'banned';
  else if (sourceStatus === 'allowed') status = 'allowed';
  else if (sourceStatus.includes('disclosure')) status = 'allowed';
  else if (sourceStatus.includes('allow')) status = 'allowed';
  else if (sourceStatus.includes('ban') || sourceStatus.includes('reject')) status = 'banned';
  else if (sourceStatus.includes('unclear') || sourceStatus.includes('review')) status = 'unclear';
  else if (sourceStatus.includes('no_public_anti_ai_stance_found') || sourceStatus.includes('not_found')) status = 'not_found';
  else if (sourceStatus) status = 'unclear';

  return {
    status,
    evidence_url: stored.evidence_url || firstArrayValue(aiMusicStance.evidence_urls) || null,
    evidence_text: stored.evidence_text || aiMusicStance.notes || null,
    confidence: stored.confidence || confidenceFromRisk(aiMusicStance.risk_level),
  };
}

function normalizeContactability(row, raw) {
  const stored = parseObject(row.contactability_json) || {};
  const contact = raw.contact || {};
  const contactMethods = Array.isArray(stored.contact_methods) && stored.contact_methods.length
    ? stored.contact_methods
    : inferContactMethods(row, raw);
  const freeContactMethodFound = stored.free_contact_method_found !== undefined
    ? Boolean(stored.free_contact_method_found)
    : contactMethods.length > 0;

  let status = stored.status || null;
  if (!status) {
    if (contactMethods.some(method => method.type === 'email')) status = 'contactable';
    else if (isOwnedChannel(row, raw)) status = 'owned_action';
    else if (contactMethods.some(method => method.type === 'contact_form')) status = 'contactable_manual';
    else status = 'manual_research_needed';
  }
  if (status === 'needs_manual_review' || status === 'not_contactable') status = 'manual_research_needed';

  const bestChannel = stored.best_channel || contactMethods[0]?.type || inferBestChannel(row, raw);

  return {
    status,
    free_contact_method_found: freeContactMethodFound,
    best_channel: bestChannel || 'unknown',
    contact_methods: contactMethods,
    evidence_url: stored.evidence_url || row.contact_page_url || row.submission_form_url || row.source_url || null,
    notes: stored.notes || null,
  };
}

function normalizeOutreachEligibility(row, { costPolicy, aiPolicyDetails, contactability, doNotContact }) {
  const stored = parseObject(row.outreach_eligibility_json) || {};
  const computedReasonCodes = deriveReasonCodes({ costPolicy, aiPolicyDetails, contactability, doNotContact });
  const reasonCodes = [...new Set([...(Array.isArray(stored.reason_codes) ? stored.reason_codes : []), ...computedReasonCodes])];
  const eligible = (
    costPolicy.requires_payment !== true
    && aiPolicyDetails.status !== 'banned'
    && ['contactable', 'contactable_manual', 'owned_action'].includes(contactability.status)
    && contactability.free_contact_method_found === true
    && doNotContact !== true
    && !['paid_only', 'bounced', 'no_contact_method', 'ai_banned'].includes(row?.suppression_status)
  );

  return {
    eligible,
    reason_codes: reasonCodes,
    reason_summary: summarizeReasonCodes(reasonCodes),
    last_checked_at: stored.last_checked_at || row.last_verified_at || row.updated_at || row.created_at,
  };
}

function looksLikeTestDemo(row, raw) {
  if (raw?.internal_test === true) return true;
  const values = [
    row?.id,
    row?.name,
    row?.contact_email,
    row?.public_email,
    row?.source_url,
    row?.official_website_url,
    raw?.id,
    raw?.name,
    raw?.url,
    raw?.contact?.email,
    raw?.contact?.submission_path,
  ].filter(Boolean).map(value => String(value).toLowerCase());

  return values.some(value =>
    /\btest\b/.test(value)
    || value.endsWith('.example')
    || value.includes('.example/')
    || value.includes('.example?')
    || value.includes('example.com')
    || value.includes('example.test')
  );
}

function deriveReasonCodes({ costPolicy, aiPolicyDetails, contactability, doNotContact }) {
  const codes = [];
  if (costPolicy.requires_payment === true) {
    codes.push(costPolicy.cost_type === 'membership' || costPolicy.cost_type === 'paid_membership'
      ? 'paid_membership_required'
      : 'requires_payment');
  }
  if (aiPolicyDetails.status === 'banned') codes.push('ai_music_banned');
  if (contactability.free_contact_method_found !== true) codes.push('no_contact_method');
  if (contactability.status === 'manual_research_needed') codes.push('no_contact_method');
  if (doNotContact) codes.push('do_not_contact');
  return [...new Set(codes)];
}

function summarizeReasonCodes(reasonCodes = []) {
  if (!reasonCodes.length) return 'Eligible for outreach.';
  const labels = {
    requires_payment: 'Requires payment',
    paid_submission_only: 'Paid submission only',
    paid_membership_required: 'Paid membership required',
    ai_music_banned: 'AI music banned',
    no_contact_method: 'No free contact method found',
    dead_site: 'Dead site',
    not_relevant: 'Not relevant',
    do_not_contact: 'Do not contact',
    duplicate: 'Already contacted for this release',
    adult_or_not_family_safe: 'Adult or not family-safe',
    brand_mismatch: 'Brand mismatch',
    unclear_policy_needs_review: 'Policy needs review',
  };
  return reasonCodes.map(code => labels[code] || code).join('; ') + '.';
}

function summarizeCost(costPolicy) {
  if (costPolicy.requires_payment === true) return 'paid';
  if (costPolicy.cost_type === 'unclear') return 'unclear';
  return 'free';
}

function inferContactMethods(row, raw) {
  const methods = [];
  const contact = raw.contact || {};
  if (row.public_email || row.contact_email || contact.email) {
    methods.push({
      type: 'email',
      value: row.public_email || row.contact_email || contact.email,
      source_url: row.contact_page_url || row.source_url || raw.url || null,
      confidence: 'high',
    });
  }
  if (row.submission_form_url) {
    methods.push({
      type: 'contact_form',
      value: row.submission_form_url,
      source_url: row.submission_form_url,
      confidence: 'high',
    });
  } else if (row.contact_method || contact.submission_path) {
    methods.push({
      type: 'contact_form',
      value: row.contact_method || contact.submission_path,
      source_url: row.contact_page_url || row.source_url || raw.url || null,
      confidence: 'medium',
    });
  }

  const socials = [
    ['instagram_dm', row.instagram_url || raw.instagram_url],
    ['tiktok_dm', row.tiktok_url || raw.tiktok_url],
    ['youtube_about', row.youtube_url || raw.youtube_url],
    ['facebook', row.facebook_url || raw.facebook_url],
    ['x', row.twitter_url || raw.twitter_url || raw.x_url],
    ['threads', row.threads_url || raw.threads_url],
  ];
  for (const [type, value] of socials) {
    if (value) {
      methods.push({
        type,
        value,
        source_url: value,
        confidence: 'medium',
      });
    }
  }

  return methods;
}

function inferBestChannel(row, raw) {
  if (row.public_email || row.contact_email || raw.contact?.email) return 'email';
  if (isOwnedChannel(row, raw)) return 'owned_channel';
  if (row.submission_form_url || row.contact_method || raw.contact?.submission_path) return 'contact_form';
  if (row.instagram_url || raw.instagram_url) return 'instagram_dm';
  if (row.tiktok_url || raw.tiktok_url) return 'tiktok_dm';
  if (row.youtube_url || raw.youtube_url) return 'youtube_about';
  return 'unknown';
}

function isOwnedChannel(row, raw) {
  const category = String(raw.category || row.type || '').toLowerCase();
  const name = String(raw.name || row.name || '').toLowerCase();
  return category.includes('owned') || name.includes('owned ');
}

function confidenceFromRisk(riskLevel) {
  if (riskLevel === 'low') return 'high';
  if (riskLevel === 'medium') return 'medium';
  if (riskLevel === 'high' || riskLevel === 'avoid') return 'high';
  return 'low';
}

function riskLevelFromScore(score) {
  const n = Number(score || 0);
  if (n >= 85) return 'high';
  if (n >= 50) return 'medium';
  return 'low';
}

function truncateMessage(value, max = 160) {
  const singleLine = String(value || '').replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function splitCsv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function boolOrNull(value) {
  if (value === undefined || value === null) return null;
  return Boolean(value);
}

function firstArrayValue(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}
