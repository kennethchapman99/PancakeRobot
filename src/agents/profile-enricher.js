/**
 * Profile Enricher Agent
 *
 * LLM-based enrichment for brand profiles. Generates the 7 performance-identity
 * fields (vocal_performance_engine, performance_conceit_bank, album_mode_lanes,
 * song_differentiation_rules, anti_generic_rules, do_not_repeat_across_album,
 * hidden_brief_requirements) tailored to the specific artist and any user notes.
 *
 * This is the primary enrichment path. The deterministic enrichProfileProposal()
 * in profile-enrichment.js is kept as --offline fallback.
 */

import { runAgent, parseAgentJson } from '../shared/managed-agent.js';

export const PROFILE_ENRICHER_DEF = {
  name: 'Profile Enricher',
  noTools: true,
  maxTokens: 8000,
  maxRetries: 1,
  system: `You are a creative director specializing in AI music generation. Your job is to write a detailed performance-identity enrichment for a brand profile used by an AI music and lyric generator.

The fields you write are embedded in a JSON profile and fed directly to LLM generators. They shape every song this brand ever makes.

Rules:
1. Every field must be SPECIFIC to this artist's voice, genre, and emotional world — no generic genre advice.
2. Every item must be ACTIONABLE — written as an instruction the generator can follow directly.
3. Do NOT include any real artist names. Describe traits and sounds without naming any real musician, band, or producer.
4. hidden_brief_requirements must be full sentences describing what the per-song brief must address — NOT field name strings. Example: "The brief must specify a vocal conceit unique to this track, not repeated from any prior track on this album" NOT "vocal_conceit".
5. Output valid JSON only — no markdown fences, no preamble, no commentary.`,
};

export const ENRICHER_OUTPUT_FIELDS = [
  'vocal_performance_engine',
  'performance_conceit_bank',
  'album_mode_lanes',
  'song_differentiation_rules',
  'anti_generic_rules',
  'do_not_repeat_across_album',
  'hidden_brief_requirements',
];

export function buildEnrichmentTask(profile, userNotes = '') {
  const sw = profile.songwriting || {};
  const music = profile.music || {};
  const character = profile.character || {};
  const audience = profile.audience || {};

  const context = {
    brand_name: profile.brand_name,
    display_name: profile.display_name,
    character: {
      name: character.name,
      core_concept: character.core_concept,
      backstory: character.backstory,
    },
    music: {
      default_style: music.default_style,
      default_prompt: music.default_prompt,
      default_bpm: music.default_bpm,
    },
    audience: {
      guardrail: audience.guardrail,
      explicitness: audience.explicitness,
    },
    songwriting: {
      song_type: sw.song_type,
      primary_emotional_goal: sw.primary_emotional_goal,
      voice_perspective: sw.voice_perspective,
      character_voice: sw.character_voice,
      song_family_types: sw.song_family_types,
      tempo_energy_lanes: sw.tempo_energy_lanes,
      forbidden_elements: sw.forbidden_elements,
      required_elements: sw.required_elements,
      anti_repetition_rules: sw.anti_repetition_rules,
      hook_design_rules: sw.hook_design_rules,
      lyrical_angle_variation_rules: sw.lyrical_angle_variation_rules,
      arrangement_variation_rules: sw.arrangement_variation_rules,
      earworm_stack: sw.earworm_stack,
      energy_arc: sw.energy_arc,
    },
  };

  const notesSection = userNotes.trim()
    ? `\n\nNOTES FROM PROFILE OWNER (incorporate these directly — they describe real preferences for this artist):\n${userNotes.trim()}`
    : '';

  return `Write a performance-identity enrichment for this brand profile.

EXISTING PROFILE:
${JSON.stringify(context, null, 2)}${notesSection}

CONSTRAINTS (apply to every field you write):
- Do not include any real artist names — describe traits and sounds without naming any real musician, band, or producer.
- Every item must be specific to THIS character — not generic genre advice that could apply to any act in this style.
- hidden_brief_requirements must be full requirement sentences, not bare field name strings.

OUTPUT — valid JSON with exactly these 7 keys (no others, no markdown fences):
{
  "vocal_performance_engine": {
    "priority": "one sentence about what makes this character's vocal non-replaceable",
    "vocal_textures": ["4-6 specific texture descriptions unique to this character"],
    "timing_behaviors": ["3-5 specific timing/rhythm behaviors this character uses"],
    "adlib_behaviors": ["3-5 adlib personality traits specific to this character"],
    "avoid": ["3-5 things that would make this character sound generic or wrong"]
  },
  "performance_conceit_bank": [
    "5-8 strings — each is a specific vocal/delivery conceit. Not genre clichés. Each describes a concrete trick: what the voice does, when, and why it's surprising."
  ],
  "album_mode_lanes": [
    {"name": "short lane name", "description": "what makes this lane distinct for THIS character — not just genre labels"}
  ],
  "song_differentiation_rules": [
    "4-6 strings — rules for ensuring consecutive tracks sound different FROM EACH OTHER, written for this character's specific tendencies and failure modes"
  ],
  "anti_generic_rules": [
    "5-8 strings — rules that prevent the generator from defaulting to generic output for this style. Name THIS character's specific failure modes."
  ],
  "do_not_repeat_across_album": [
    "6-10 strings — specific production/vocal elements to rotate, written for what THIS character tends to do repeatedly"
  ],
  "hidden_brief_requirements": [
    "4-6 strings — each is a full sentence requirement for what the per-song hidden brief must address for this artist. Example: 'The brief must specify how adlib placement on this track differs from the prior track.' NOT field name strings."
  ]
}`;
}

export function validateEnrichmentResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ['result is not an object'];
  }
  const missing = ENRICHER_OUTPUT_FIELDS.filter(k => !(k in parsed));
  if (missing.length > 0) {
    return [`missing required fields: ${missing.join(', ')}`];
  }
  const failures = [];
  const vpe = parsed.vocal_performance_engine;
  if (!vpe || typeof vpe !== 'object') {
    failures.push('vocal_performance_engine is not an object');
  } else {
    if (typeof vpe.priority !== 'string') failures.push('vocal_performance_engine.priority is not a string');
    if (!Array.isArray(vpe.vocal_textures) || vpe.vocal_textures.length === 0) failures.push('vocal_performance_engine.vocal_textures is empty or missing');
    if (!Array.isArray(vpe.avoid) || vpe.avoid.length === 0) failures.push('vocal_performance_engine.avoid is empty or missing');
  }
  if (!Array.isArray(parsed.performance_conceit_bank) || parsed.performance_conceit_bank.length < 3) {
    failures.push('performance_conceit_bank must have at least 3 items');
  }
  if (!Array.isArray(parsed.album_mode_lanes) || parsed.album_mode_lanes.length < 2) {
    failures.push('album_mode_lanes must have at least 2 items');
  }
  if (!Array.isArray(parsed.hidden_brief_requirements) || parsed.hidden_brief_requirements.length === 0) {
    failures.push('hidden_brief_requirements is empty or missing');
  } else {
    const fieldNameStrings = ['vocal_conceit', 'flow_movement', 'hook_behavior', 'adlib_personality', 'sonic_oddity', 'emotional_contradiction', 'avoid_vs_previous_tracks'];
    const bareFieldNames = parsed.hidden_brief_requirements.filter(r => fieldNameStrings.includes(r));
    if (bareFieldNames.length > 0) {
      failures.push(`hidden_brief_requirements contains bare field names instead of sentences: ${bareFieldNames.join(', ')}`);
    }
  }
  return failures;
}

export async function enrichProfileWithLLM(profile, { userNotes = '', runner = runAgent } = {}) {
  const task = buildEnrichmentTask(profile, userNotes);
  const result = await runner('profile-enricher', PROFILE_ENRICHER_DEF, task, {
    maxTokens: PROFILE_ENRICHER_DEF.maxTokens,
  });
  const parsed = parseAgentJson(result.text);
  const failures = validateEnrichmentResult(parsed);
  if (failures.length > 0) {
    throw new Error(`Profile enricher returned invalid result: ${failures.join('; ')}`);
  }
  // Strip any keys the LLM added beyond the 7 we asked for
  const songwriting = {};
  for (const key of ENRICHER_OUTPUT_FIELDS) {
    if (key in parsed) songwriting[key] = parsed[key];
  }
  return {
    songwriting,
    costUsd: result.costUsd || 0,
    runId: result.runId || null,
  };
}
