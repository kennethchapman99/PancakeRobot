/**
 * Album Orchestrator Agent
 *
 * Produces a single structured album plan for a multi-song batch from one
 * shared call. The plan is then reused by every track-level generator so the
 * expensive "thinking" only runs once per album/batch.
 */

import { runAgent, parseAgentJson } from '../shared/managed-agent.js';

export const ALBUM_ORCHESTRATOR_DEF = {
  name: 'Album Orchestrator',
  noTools: true,
  maxTokens: 16000,
  maxRetries: 1,
  system: `You are an album orchestrator. Given a brand profile and high-level intent, design a cohesive multi-song plan. Return valid JSON only, no markdown fences. The plan must hold together as one body of work and give each track a distinct emotional role, concrete lyric direction, and — when the profile provides album_mode_lanes and performance_conceit_bank — a specific lane assignment and performance conceit per track that avoids repetition across the album.`,
};

export const ALBUM_PLAN_VERSION = 'album_plan/v1';

export function buildAlbumOrchestrationTask({
  brandProfile,
  numberOfSongs,
  albumTheme,
  releaseIntent,
  notes,
}) {
  const cohesiveThemeNote = albumTheme && albumTheme.trim()
    ? `EXPLICIT ALBUM THEME (use as-is): ${albumTheme.trim()}`
    : 'NO EXPLICIT THEME PROVIDED. Infer a cohesive album concept from the brand profile (character, music style, audience, lyrics direction). The inferred theme must be natural for this brand and must read as one body of work.';

  const sw = brandProfile.songwriting || {};
  const albumModeLanes = sw.album_mode_lanes;
  const conceitBank = sw.performance_conceit_bank;
  const doNotRepeat = sw.do_not_repeat_across_album;
  const antiGeneric = sw.anti_generic_rules;
  const diffRules = sw.song_differentiation_rules;

  const laneSection = albumModeLanes?.length > 0
    ? `\nALBUM MODE LANES (available for this album):
${JSON.stringify(albumModeLanes, null, 2)}

LANE SELECTION RULES:
- Choose one PRIMARY lane and one CONTAMINATING lane for this album.
- The contaminating lane bleeds influence into the primary lane without taking over.
- Each track may lean toward primary or contaminating — they should not all be identical.
- Assign the lane mix per track in the album_lane field.`
    : '';

  const conceitSection = conceitBank?.length > 0
    ? `\nPERFORMANCE CONCEIT BANK (assign one unique conceit per track, do not repeat):
${conceitBank.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';

  const doNotRepeatSection = doNotRepeat?.length > 0
    ? `\nDO NOT REPEAT ACROSS ALBUM:
${doNotRepeat.map(r => `- ${r}`).join('\n')}`
    : '';

  const antiGenericSection = antiGeneric?.length > 0
    ? `\nANTI-GENERIC RULES (apply to every track):
${antiGeneric.map(r => `- ${r}`).join('\n')}`
    : '';

  const diffRulesSection = diffRules?.length > 0
    ? `\nSONG DIFFERENTIATION RULES:
${diffRules.map(r => `- ${r}`).join('\n')}`
    : '';

  const hasEnrichedFields = !!(albumModeLanes?.length || conceitBank?.length);
  const trackShape = hasEnrichedFields
    ? `{
      "track_number": 1,
      "title": "string",
      "concept": "string",
      "emotional_role": "string",
      "music_style_prompt": "string",
      "lyric_direction": "string",
      "provider_prompt_seed": "string",
      "album_lane": "primary lane name (or primary+contaminating blend note)",
      "assigned_conceit": "the specific performance conceit selected for this track from the bank"
    }`
    : `{
      "track_number": 1,
      "title": "string",
      "concept": "string",
      "emotional_role": "string",
      "music_style_prompt": "string",
      "lyric_direction": "string",
      "provider_prompt_seed": "string"
    }`;

  const albumLevelShape = hasEnrichedFields
    ? `  "primary_lane": "string",
  "contaminating_lane": "string",
  `
    : '';

  return `Design a cohesive ${numberOfSongs}-track album plan for the active brand.

${cohesiveThemeNote}

RELEASE INTENT: ${releaseIntent || 'unspecified — choose based on brand profile and track count.'}
EXTRA NOTES FROM USER: ${notes || '(none)'}

BRAND PROFILE (source of truth):
${JSON.stringify(brandProfile, null, 2)}
${laneSection}${conceitSection}${doNotRepeatSection}${antiGenericSection}${diffRulesSection}

REQUIREMENTS:
- Produce exactly ${numberOfSongs} tracks.
- Tracks must form a coherent listening order; vary the emotional role across the album.
- Each track gets a working title, a one-paragraph concept, an emotional role (e.g. "opener", "anthem", "soft middle", "closer"), a music_style_prompt aligned with the brand's default style but with track-specific texture, a concrete lyric_direction, and a short provider_prompt_seed that the per-track lyricist will expand on.
- music_style_prompt must stay inside the brand's allowed style; do not import forbidden elements.
- lyric_direction must be specific enough that a per-track lyricist can write the song without rerunning brand interpretation.
- album_title, album_theme, release_positioning, and sonic_palette must hold across all tracks.
- lyrical_rules is a short list of hard rules every track must follow (tone, forbidden elements, required closing, etc) that captures the brand profile in summary form.
${hasEnrichedFields ? '- Each track must have a unique album_lane and assigned_conceit; do not reuse the same conceit on two tracks.\n- primary_lane and contaminating_lane must be set at the album level.' : ''}

OUTPUT JSON SHAPE (return exactly this shape, no extra fields, no markdown fences):
{
  "album_title": "string",
  "album_theme": "string",
  "release_positioning": "string",
  "sonic_palette": "string",
  ${albumLevelShape}"lyrical_rules": ["string", "string"],
  "track_count": ${numberOfSongs},
  "tracks": [
    ${trackShape}
  ]
}`;
}

export function validateAlbumPlan(plan, expectedTrackCount) {
  if (!plan || typeof plan !== 'object') return ['plan is not an object'];
  const failures = [];
  for (const field of ['album_title', 'album_theme', 'release_positioning', 'sonic_palette']) {
    if (typeof plan[field] !== 'string' || !plan[field].trim()) failures.push(`missing/empty field: ${field}`);
  }
  if (!Array.isArray(plan.lyrical_rules)) failures.push('lyrical_rules must be an array');
  if (!Array.isArray(plan.tracks)) failures.push('tracks must be an array');
  else if (plan.tracks.length !== expectedTrackCount) {
    failures.push(`expected ${expectedTrackCount} tracks but got ${plan.tracks.length}`);
  } else {
    plan.tracks.forEach((track, idx) => {
      for (const field of ['title', 'concept', 'emotional_role', 'music_style_prompt', 'lyric_direction', 'provider_prompt_seed']) {
        if (typeof track[field] !== 'string' || !track[field].trim()) failures.push(`tracks[${idx}].${field} missing/empty`);
      }
    });
  }
  return failures;
}

export function extractAlbumLaneContext(plan) {
  if (!plan) return null;
  if (!plan.primary_lane && !plan.contaminating_lane) return null;
  return {
    primary_lane: plan.primary_lane || null,
    contaminating_lane: plan.contaminating_lane || null,
  };
}

export function extractTrackAlbumContext(plan, track) {
  const laneCtx = extractAlbumLaneContext(plan);
  if (!laneCtx && !track.album_lane && !track.assigned_conceit) return null;
  return {
    primary_lane: laneCtx?.primary_lane || null,
    contaminating_lane: laneCtx?.contaminating_lane || null,
    track_lane: track.album_lane || null,
    assigned_conceit: track.assigned_conceit || null,
    track_number: track.track_number,
    track_count: plan.track_count,
  };
}

export function normalizeAlbumPlan(plan, expectedTrackCount) {
  const tracks = (plan.tracks || []).slice(0, expectedTrackCount).map((track, idx) => {
    const normalized = {
      track_number: Number.isFinite(Number(track.track_number)) ? Number(track.track_number) : idx + 1,
      title: String(track.title || `Track ${idx + 1}`).trim(),
      concept: String(track.concept || '').trim(),
      emotional_role: String(track.emotional_role || '').trim(),
      music_style_prompt: String(track.music_style_prompt || '').trim(),
      lyric_direction: String(track.lyric_direction || '').trim(),
      provider_prompt_seed: String(track.provider_prompt_seed || '').trim(),
    };
    if (track.album_lane) normalized.album_lane = String(track.album_lane).trim();
    if (track.assigned_conceit) normalized.assigned_conceit = String(track.assigned_conceit).trim();
    return normalized;
  });
  const normalized = {
    plan_version: ALBUM_PLAN_VERSION,
    album_title: String(plan.album_title || '').trim(),
    album_theme: String(plan.album_theme || '').trim(),
    release_positioning: String(plan.release_positioning || '').trim(),
    sonic_palette: String(plan.sonic_palette || '').trim(),
    lyrical_rules: Array.isArray(plan.lyrical_rules) ? plan.lyrical_rules.map(rule => String(rule)).filter(Boolean) : [],
    track_count: tracks.length,
    tracks,
  };
  if (plan.primary_lane) normalized.primary_lane = String(plan.primary_lane).trim();
  if (plan.contaminating_lane) normalized.contaminating_lane = String(plan.contaminating_lane).trim();
  return normalized;
}

export async function generateAlbumPlan({
  brandProfile,
  numberOfSongs,
  albumTheme = null,
  releaseIntent = null,
  notes = null,
  runner = runAgent,
}) {
  const task = buildAlbumOrchestrationTask({ brandProfile, numberOfSongs, albumTheme, releaseIntent, notes });
  const result = await runner('album-orchestrator', ALBUM_ORCHESTRATOR_DEF, task, {
    maxTokens: ALBUM_ORCHESTRATOR_DEF.maxTokens,
  });
  const parsed = parseAgentJson(result.text);
  const failures = validateAlbumPlan(parsed, numberOfSongs);
  if (failures.length > 0) {
    throw new Error(`Album orchestrator returned invalid plan: ${failures.join('; ')}`);
  }
  return {
    plan: normalizeAlbumPlan(parsed, numberOfSongs),
    costUsd: result.costUsd || 0,
    runId: result.runId || null,
  };
}
