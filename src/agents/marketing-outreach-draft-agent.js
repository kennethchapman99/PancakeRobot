import { runAgent, parseAgentJson } from '../shared/managed-agent.js';
import { getAllSongs, getReleaseLinks } from '../shared/db.js';
import { getMarketingTargets } from '../shared/marketing-db.js';
import {
  getOutreachItem,
  getOutreachItems,
} from '../shared/marketing-outreach-db.js';
import { transitionOutreachItem } from '../shared/marketing-outreach-state.js';
import { getReleaseMarketingPack, getBundleMarketingPack } from '../shared/release-marketing-pack.js';
import { loadBrandProfile } from '../shared/brand-profile.js';
import { buildAttachmentPlanForOutreachItem, buildBrandSocialLinks } from '../shared/marketing-email-assets.js';

const BRAND_PROFILE = loadBrandProfile();

const AGENT_DEF = {
  name: 'Marketing Outreach Draft Agent',
  model: process.env.MARKETING_OUTREACH_MODEL || 'claude-haiku-4-5',
  noTools: true,
  maxTokens: 2500,
  system: `You write concise, honest outreach email drafts for a kids/family music brand.
Rules:
- Return ONLY valid JSON with keys: subject, body, safety_notes.
- Never claim human-made music if AI-assisted creation is disclosed or relevant.
- Never claim playlist placement, review, award, endorsement, child-development benefit, or guaranteed audience outcome.
- Never write to children; write to adult curators, creators, educators, or media.
- Keep the email short, specific, and natural.
- Use the outlet context and release assets provided. Do not invent links, stats, awards, or relationships.
- If AI disclosure is required or prudent, include one clear sentence: "The music is AI-assisted and human-directed."`
};

export async function generateDraftForOutreachItem(itemId, options = {}) {
  const item = getOutreachItem(itemId);
  if (!item) throw new Error(`Outreach item not found: ${itemId}`);

  const draft = await buildDraft(item, options);
  const safety = validateDraft(draft, item);

  const fields = {
    subject: draft.subject,
    body: draft.body,
    safety_status: safety.ok ? 'passed' : 'needs_review',
    safety_notes: [...(draft.safety_notes ? [draft.safety_notes] : []), ...safety.notes].join('\n'),
    generation_method: draft.generation_method,
    requires_ken: true,
  };

  if (safety.ok) {
    transitionOutreachItem(item.id, 'generate_draft', {
      actor: 'marketing-outreach-draft-agent',
      fields,
      message: 'Outreach draft generated',
      metadata: { generation_method: draft.generation_method },
    });
  } else {
    transitionOutreachItem(item.id, 'mark_needs_ken', {
      actor: 'marketing-outreach-draft-agent',
      fields,
      message: 'Outreach draft generated but needs review',
      metadata: { safety_notes: safety.notes },
    });
  }

  return { item_id: item.id, ...draft, safety };
}

export async function generateDraftsForCampaign(campaignId, options = {}) {
  const items = getOutreachItems({ campaign_id: campaignId })
    .filter(item => !['sent', 'replied', 'do_not_contact', 'gmail_draft_created', 'manual_submitted'].includes(item.status));

  const results = [];
  for (const item of items) {
    try {
      results.push(await generateDraftForOutreachItem(item.id, options));
    } catch (error) {
      try {
        transitionOutreachItem(item.id, 'mark_needs_ken', {
          actor: 'marketing-outreach-draft-agent',
          fields: { safety_status: 'error', safety_notes: error.message, requires_ken: true },
          message: 'Draft generation failed',
        });
      } catch {
        // Preserve original generation error in result.
      }
      results.push({ item_id: item.id, error: error.message });
    }
  }

  return { campaign_id: campaignId, generated: results.filter(r => !r.error).length, failed: results.filter(r => r.error).length, results };
}

async function buildDraft(item, options = {}) {
  const context = buildContext(item);

  if (!process.env.ANTHROPIC_API_KEY || options.deterministic === true) {
    return deterministicDraft(context, 'deterministic_fallback');
  }

  const task = `Write one outreach email draft for this release/outlet context.\n\n${JSON.stringify(context, null, 2)}`;

  try {
    const response = await runAgent('marketing-outreach-draft', AGENT_DEF, task, { maxRetries: 0 });
    const parsed = parseAgentJson(response.text);
    if (!parsed.subject || !parsed.body) throw new Error('LLM response missing subject/body');
    return ensureDraftHasReleaseLinks({
      subject: String(parsed.subject).trim(),
      body: String(parsed.body).trim(),
      safety_notes: parsed.safety_notes ? String(parsed.safety_notes).trim() : '',
      generation_method: 'llm',
    }, context);
  } catch (error) {
    const fallback = deterministicDraft(context, 'deterministic_after_llm_error');
    fallback.safety_notes = `LLM failed; deterministic fallback used: ${error.message}`;
    return fallback;
  }
}

function buildContext(item) {
  const songs = getAllSongs();
  const targets = getMarketingTargets({});
  const outlet = targets.find(target => target.id === item.target_id) || {};
  const releaseSongs = item.outreach_mode === 'bundle'
    ? item.bundle_song_ids.map(id => songs.find(song => song.id === id)).filter(Boolean)
    : [songs.find(song => song.id === item.song_id)].filter(Boolean);

  const releaseLinks = Object.fromEntries(
    releaseSongs.map(song => [song.id, getReleaseLinks(song.id)])
  );

  const marketingPack = item.outreach_mode === 'bundle'
    ? getBundleMarketingPack(releaseSongs.map(song => song.id))
    : releaseSongs[0] ? getReleaseMarketingPack(releaseSongs[0].id) : null;

  return {
    item: {
      id: item.id,
      song_id: item.song_id,
      outreach_mode: item.outreach_mode,
      bundle_song_ids: item.bundle_song_ids || [],
      release_context: item.release_context || [],
    },
    brand: {
      name: BRAND_PROFILE.brand_name || 'Pancake Robot',
      description: BRAND_PROFILE.description || BRAND_PROFILE.brand_description || '',
      audience: BRAND_PROFILE.audience || {},
      social: BRAND_PROFILE.social || {},
      social_links: buildBrandSocialLinks({ releaseLinks: Object.values(releaseLinks).flat() }),
      disclosure: 'AI-assisted and human-directed music project',
    },
    outreach_mode: item.outreach_mode,
    releases: releaseSongs.map(song => ({
      id: song.id,
      title: song.title,
      topic: song.topic,
      concept: song.concept,
      status: song.status,
      release_date: song.release_date,
      distributor: song.distributor,
      links: releaseLinks[song.id] || [],
    })),
    marketing_pack: marketingPack,
    outlet: {
      id: outlet.id || item.target_id,
      name: outlet.name || item.outlet_name,
      type: outlet.type,
      platform: outlet.platform,
      contact_method: outlet.contact_method,
      contact_email: outlet.contact_email,
      ai_policy: outlet.ai_policy,
      ai_risk_score: outlet.ai_risk_score,
      research_summary: outlet.research_summary,
      outreach_angle: outlet.outreach_angle,
      pitch_preferences: safeParse(outlet.pitch_preferences),
      raw_json: safeParse(outlet.raw_json),
    },
    selected_assets: item.selected_assets || [],
    safety_requirements: {
      requires_ken_review: true,
      no_auto_send: true,
      include_ai_disclosure: ['disclosure_required', 'likely_hostile', 'unclear'].includes(outlet.ai_policy),
      do_not_contact_if_policy_banned: true,
    },
  };
}

function deterministicDraft(context, generationMethod) {
  const brandName = context.brand.name || 'Pancake Robot';
  const outletName = context.outlet.name || 'there';
  const releases = context.releases || [];
  const isBundle = releases.length > 1;
  const title = isBundle
    ? `${releases.length} new ${brandName} songs`
    : (releases[0]?.title || releases[0]?.topic || `new ${brandName} song`);
  const primaryLinks = releases.flatMap(song => song.links || []).filter(link => link?.url);
  const linkLines = primaryLinks.length
    ? primaryLinks.map(link => `${link.platform}: ${link.url}`).join('\n')
    : '[Add public streaming / preview links before sending]';
  const socialLines = (context.brand.social_links || []).map(link => `${link.label}: ${link.url}`).join('\n');
  const attachmentPlan = buildAttachmentPlanForOutreachItem(context.item || {});
  const linkBlock = attachmentPlan.outreachLinkBlock || '';
  const angle = context.outlet.outreach_angle || context.outlet.research_summary || '';
  const needsDisclosure = context.safety_requirements.include_ai_disclosure;

  const subject = isBundle
    ? `${brandName}: ${releases.length} new songs for families/kids`
    : `${brandName}: ${title}`;

  const body = [
    `Hi ${outletName},`,
    '',
    `I wanted to share ${isBundle ? `a small bundle of new ${brandName} songs` : `a new ${brandName} release`} that may be a fit for your audience.`,
    angle ? `\nWhy I thought of you: ${firstSentence(angle)}` : '',
    '',
    `${brandName} makes upbeat, silly music for kids and families — built around catchy hooks, playful topics, and easy singalong energy.`,
    needsDisclosure ? '\nThe music is AI-assisted and human-directed.' : '',
    '',
    `Release${isBundle ? 's' : ''}:`,
    ...releases.map(song => `- ${song.title || song.topic || song.id}`),
    '',
    linkBlock ? 'Links:' : '',
    linkBlock || linkLines,
    socialLines ? `\nArtist links:\n${socialLines}` : '',
    '',
    'Happy to share anything else that helps.',
    '',
    `Best,\nKen (${brandName})`,
  ].filter(line => line !== '').join('\n');

  return ensureDraftHasReleaseLinks(
    { subject, body, safety_notes: 'Deterministic draft generated; review before use.', generation_method: generationMethod },
    context,
  );
}

function validateDraft(draft, item) {
  const notes = [];
  const combined = `${draft.subject || ''}\n${draft.body || ''}`.toLowerCase();
  const blocked = [
    'guaranteed',
    'award-winning',
    'endorsed by',
    'proven to improve',
    'clinically proven',
    'human-made',
    'not ai',
  ];

  for (const phrase of blocked) {
    if (combined.includes(phrase)) notes.push(`Potentially unsafe phrase: ${phrase}`);
  }

  if (!draft.subject || !draft.body) notes.push('Missing subject or body');
  if ((draft.subject || '').length > 90) notes.push('Subject may be too long');
  if (item.safety_status === 'blocked') notes.push('Item was previously blocked');

  return { ok: notes.length === 0, notes };
}

function firstSentence(text) {
  return String(text || '').split(/[.!?]\s/)[0].slice(0, 220);
}

function ensureDraftHasReleaseLinks(draft, context) {
  const releaseLines = (context.releases || [])
    .flatMap(release => (release.links || []).filter(link => link?.url).map(link => `${link.platform}: ${link.url}`));
  const body = String(draft.body || '');
  const attachmentPlan = buildAttachmentPlanForOutreachItem(context.item || {});
  const socialLines = (context.brand.social_links || []).map(link => `${link.label}: ${link.url}`);
  const outreachLinkBlock = attachmentPlan.outreachLinkBlock || '';
  const missingReleaseLines = releaseLines.filter(line => !body.includes(line.split(': ').slice(1).join(': ')));
  const missingSocialLines = socialLines.filter(line => !body.includes(line.split(': ').slice(1).join(': ')));
  const missingOutreachBlock = outreachLinkBlock && !body.includes(outreachLinkBlock.split('\n')[0]);

  if (!missingReleaseLines.length && !missingSocialLines.length && !missingOutreachBlock) return draft;

  const addendum = [];
  if (missingOutreachBlock) addendum.push(outreachLinkBlock, '');
  if (missingReleaseLines.length) addendum.push('Links:', ...missingReleaseLines, '');
  if (missingSocialLines.length) addendum.push('Artist links:', ...missingSocialLines, '');

  return {
    ...draft,
    body: `${body.trim()}${addendum.length ? `\n\n${addendum.join('\n')}` : ''}`.trim(),
  };
}

function safeParse(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
