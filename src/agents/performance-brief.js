/**
 * Performance Brief Agent
 *
 * Produces a hidden per-song performance brief that must be resolved before
 * lyrics or an audio prompt are written. The brief captures vocal conceit,
 * flow movement, hook behavior, adlib personality, sonic oddity, emotional
 * contradiction, and what this song must avoid versus previous tracks.
 *
 * It is "hidden" in the sense that it never appears in listener-facing copy —
 * it is a production brief for the generator, persisted to the song dir so
 * reviewers can inspect it.
 *
 * When the active brand profile has no enriched performance fields
 * (vocal_performance_engine, performance_conceit_bank, album_mode_lanes)
 * this module returns null so legacy profiles are completely unaffected.
 */

import { runAgent, parseAgentJson } from '../shared/managed-agent.js';

export const PERFORMANCE_BRIEF_DEF = {
  name: 'Performance Brief',
  noTools: true,
  maxTokens: 4000,
  maxRetries: 1,
  system: `You are a music production director. Given an artist's performance identity, an album lane, prior track summaries, and a song topic, design a concise hidden performance brief for one track. Return valid JSON only, no markdown fences.`,
};

export const PERFORMANCE_BRIEF_REQUIRED_FIELDS = [
  'vocal_conceit',
  'flow_movement',
  'hook_behavior',
  'adlib_personality',
  'sonic_oddity',
  'emotional_contradiction',
  'avoid_vs_previous_tracks',
];

export function buildPerformanceBriefTask({
  brandProfile,
  albumContext = null,
  priorTracks = [],
  topic,
}) {
  const sw = brandProfile.songwriting || {};
  const vpe = sw.vocal_performance_engine || {};
  const conceitBank = sw.performance_conceit_bank || [];
  const diffRules = sw.song_differentiation_rules || [];
  const antiGeneric = sw.anti_generic_rules || [];
  const doNotRepeat = sw.do_not_repeat_across_album || [];
  const hiddenBriefReqs = sw.hidden_brief_requirements || PERFORMANCE_BRIEF_REQUIRED_FIELDS;

  const laneSection = albumContext
    ? `\nALBUM LANE SELECTION:\n${JSON.stringify(albumContext, null, 2)}`
    : '';

  const priorSection = priorTracks.length > 0
    ? `\nPRIOR TRACKS ON THIS ALBUM (avoid repeating their conceits):\n${JSON.stringify(priorTracks, null, 2)}`
    : '\nPRIOR TRACKS: None (this is the first or only track).';

  const conceitBankSection = conceitBank.length > 0
    ? `\nPERFORMANCE CONCEIT BANK (pick ONE that has not been used on this album yet):\n${conceitBank.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';

  return `Design a hidden performance brief for one song.

SONG TOPIC: "${topic}"

BRAND PROFILE — CHARACTER:
Brand: ${brandProfile.brand_name}
Character: ${brandProfile.character?.name}
Core concept: ${brandProfile.character?.core_concept}

VOCAL PERFORMANCE ENGINE:
${vpe.priority ? `Priority: ${vpe.priority}\n` : ''}${JSON.stringify(vpe, null, 2)}
${conceitBankSection}${laneSection}${priorSection}

SONG DIFFERENTIATION RULES:
${diffRules.length ? diffRules.map(r => `- ${r}`).join('\n') : '(none — use best judgment)'}

ANTI-GENERIC RULES:
${antiGeneric.length ? antiGeneric.map(r => `- ${r}`).join('\n') : '(none)'}

DO NOT REPEAT ACROSS ALBUM:
${doNotRepeat.length ? doNotRepeat.map(r => `- ${r}`).join('\n') : '(none)'}

REQUIRED BRIEF FIELDS: ${JSON.stringify(hiddenBriefReqs)}

OUTPUT JSON (exactly these fields, concise strings, no markdown fences):
{
  "vocal_conceit": "the one specific vocal trick that defines this track's sound (e.g. bored delivery that snaps into double-time every 4 bars)",
  "flow_movement": "how the flow changes across the song (e.g. behind-beat swagger that jumps ahead before punchlines)",
  "hook_behavior": "how the hook works — texture, delivery style, repetition pattern (e.g. built from clipped breath fragments, not a smooth chorus)",
  "adlib_personality": "the adlib character and placement rules (e.g. self-interrupting, argues with lead vocal, dry one-word insults)",
  "sonic_oddity": "the one strange production/vocal choice that makes this track recognizable in 10 seconds",
  "emotional_contradiction": "the underlying tension the song embodies (e.g. hard exterior / exposed crack of vulnerability at bar 12)",
  "avoid_vs_previous_tracks": "specific elements NOT to repeat from prior tracks on this album"
}`;
}

export function validatePerformanceBrief(brief) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    return ['performance brief is not an object'];
  }
  const missing = PERFORMANCE_BRIEF_REQUIRED_FIELDS.filter(f => !brief[f] || typeof brief[f] !== 'string' || !brief[f].trim());
  return missing.map(f => `missing/empty field: ${f}`);
}

export function normalizePerformanceBrief(brief) {
  const normalized = {};
  for (const field of PERFORMANCE_BRIEF_REQUIRED_FIELDS) {
    normalized[field] = typeof brief[field] === 'string' ? brief[field].trim() : '';
  }
  return normalized;
}

export async function generatePerformanceBrief({
  brandProfile,
  albumContext = null,
  priorTracks = [],
  topic,
  runner = runAgent,
}) {
  const task = buildPerformanceBriefTask({ brandProfile, albumContext, priorTracks, topic });
  const result = await runner('performance-brief', PERFORMANCE_BRIEF_DEF, task, {
    maxTokens: PERFORMANCE_BRIEF_DEF.maxTokens,
  });
  const parsed = parseAgentJson(result.text);
  const failures = validatePerformanceBrief(parsed);
  if (failures.length > 0) {
    throw new Error(`Performance brief returned invalid shape: ${failures.join('; ')}`);
  }
  return {
    brief: normalizePerformanceBrief(parsed),
    costUsd: result.costUsd || 0,
    runId: result.runId || null,
  };
}

export function checkAlbumConceitVariety(trackBriefs = []) {
  const warnings = [];
  const vocals = trackBriefs.map(b => b?.vocal_conceit?.toLowerCase().trim() || '').filter(Boolean);
  const hooks = trackBriefs.map(b => b?.hook_behavior?.toLowerCase().trim() || '').filter(Boolean);

  const seenVocals = new Set();
  const seenHooks = new Set();

  for (const v of vocals) {
    const key = v.slice(0, 40);
    if (seenVocals.has(key)) warnings.push(`Duplicate vocal conceit pattern detected: "${key}..."`);
    seenVocals.add(key);
  }
  for (const h of hooks) {
    const key = h.slice(0, 40);
    if (seenHooks.has(key)) warnings.push(`Duplicate hook behavior pattern detected: "${key}..."`);
    seenHooks.add(key);
  }

  return { passed: warnings.length === 0, warnings };
}
