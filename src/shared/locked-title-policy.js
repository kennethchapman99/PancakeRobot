import { loadBrandProfile } from './brand-profile.js';

const DEFAULT_POLICY = {
  enabled: false,
  instruction: '',
  preferred_usage: [],
  render_safety_prompts: [],
  qa_checks: {
    require_in_lyrics: false,
    require_in_opening: false,
    require_in_chorus: false,
  },
};

export function getLockedTitlePolicy(profile = loadBrandProfile()) {
  const policy = profile.songwriting?.locked_title_policy || {};
  return {
    ...DEFAULT_POLICY,
    ...policy,
    preferred_usage: Array.isArray(policy.preferred_usage) ? policy.preferred_usage.filter(Boolean) : [],
    render_safety_prompts: Array.isArray(policy.render_safety_prompts) ? policy.render_safety_prompts.filter(Boolean) : [],
    qa_checks: {
      ...DEFAULT_POLICY.qa_checks,
      ...(policy.qa_checks || {}),
    },
  };
}

export function shouldUseLockedTitlePolicy(profile = loadBrandProfile()) {
  return Boolean(getLockedTitlePolicy(profile).enabled);
}

export function buildLockedTitleRequestLines(title, profile = loadBrandProfile()) {
  const policy = getLockedTitlePolicy(profile);
  const cleanTitle = cleanValue(title);
  if (!cleanTitle) return [];

  const lines = [
    `title: ${cleanTitle}`,
    `locked_title: ${cleanTitle}`,
  ];

  if (policy.enabled && policy.instruction) {
    lines.push(`title_policy: ${renderPolicyTemplate(policy.instruction, cleanTitle)}`);
  }

  if (policy.enabled && policy.preferred_usage.length) {
    lines.push(`title_preferred_usage: ${policy.preferred_usage.map(item => renderPolicyTemplate(item, cleanTitle)).join('; ')}`);
  }

  return lines;
}

export function buildLockedTitlePromptLines(title, profile = loadBrandProfile()) {
  const policy = getLockedTitlePolicy(profile);
  const cleanTitle = cleanValue(title);
  if (!cleanTitle || !policy.enabled) return [];

  return [
    `exact song title: "${cleanTitle}"`,
    policy.instruction ? renderPolicyTemplate(policy.instruction, cleanTitle) : '',
    ...policy.preferred_usage.map(item => renderPolicyTemplate(item, cleanTitle)),
    ...policy.render_safety_prompts.map(item => renderPolicyTemplate(item, cleanTitle)),
  ].filter(Boolean);
}

export function buildLockedTitleQaRequirements(title, profile = loadBrandProfile()) {
  const policy = getLockedTitlePolicy(profile);
  const cleanTitle = cleanValue(title);
  if (!cleanTitle || !policy.enabled) {
    return {
      enabled: false,
      title: cleanTitle,
      requireInLyrics: false,
      requireInOpening: false,
      requireInChorus: false,
      promptTerms: [],
    };
  }

  return {
    enabled: true,
    title: cleanTitle,
    requireInLyrics: Boolean(policy.qa_checks?.require_in_lyrics),
    requireInOpening: Boolean(policy.qa_checks?.require_in_opening),
    requireInChorus: Boolean(policy.qa_checks?.require_in_chorus),
    promptTerms: buildLockedTitlePromptLines(cleanTitle, profile),
  };
}

function renderPolicyTemplate(value, title) {
  return String(value || '').replaceAll('{{title}}', title);
}

function cleanValue(value = '') {
  return String(value || '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
