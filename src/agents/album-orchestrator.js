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
  system: `You are an album orchestrator. Given a brand profile and high-level intent, design a cohesive multi-song plan. Return valid JSON only, no markdown fences. The plan must hold together as one body of work and give each track a distinct emotional role and concrete lyric direction.`,
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

  return `Design a cohesive ${numberOfSongs}-track album plan for the active brand.

${cohesiveThemeNote}

RELEASE INTENT: ${releaseIntent || 'unspecified — choose based on brand profile and track count.'}
EXTRA NOTES FROM USER: ${notes || '(none)'}

BRAND PROFILE (source of truth):
${JSON.stringify(brandProfile, null, 2)}

REQUIREMENTS:
- Produce exactly ${numberOfSongs} tracks.
- Tracks must form a coherent listening order; vary the emotional role across the album.
- Each track gets a working title, a one-paragraph concept, an emotional role (e.g. "opener", "anthem", "soft middle", "closer"), a music_style_prompt aligned with the brand's default style but with track-specific texture, a concrete lyric_direction, and a short provider_prompt_seed that the per-track lyricist will expand on.
- music_style_prompt must stay inside the brand's allowed style; do not import forbidden elements.
- lyric_direction must be specific enough that a per-track lyricist can write the song without rerunning brand interpretation.
- album_title, album_theme, release_positioning, and sonic_palette must hold across all tracks.
- lyrical_rules is a short list of hard rules every track must follow (tone, forbidden elements, required closing, etc) that captures the brand profile in summary form.

OUTPUT JSON SHAPE (return exactly this shape, no extra fields, no markdown fences):
{
  "album_title": "string",
  "album_theme": "string",
  "release_positioning": "string",
  "sonic_palette": "string",
  "lyrical_rules": ["string", "string"],
  "track_count": ${numberOfSongs},
  "tracks": [
    {
      "track_number": 1,
      "title": "string",
      "concept": "string",
      "emotional_role": "string",
      "music_style_prompt": "string",
      "lyric_direction": "string",
      "provider_prompt_seed": "string"
    }
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

export function normalizeAlbumPlan(plan, expectedTrackCount) {
  const tracks = (plan.tracks || []).slice(0, expectedTrackCount).map((track, idx) => ({
    track_number: Number.isFinite(Number(track.track_number)) ? Number(track.track_number) : idx + 1,
    title: String(track.title || `Track ${idx + 1}`).trim(),
    concept: String(track.concept || '').trim(),
    emotional_role: String(track.emotional_role || '').trim(),
    music_style_prompt: String(track.music_style_prompt || '').trim(),
    lyric_direction: String(track.lyric_direction || '').trim(),
    provider_prompt_seed: String(track.provider_prompt_seed || '').trim(),
  }));
  return {
    plan_version: ALBUM_PLAN_VERSION,
    album_title: String(plan.album_title || '').trim(),
    album_theme: String(plan.album_theme || '').trim(),
    release_positioning: String(plan.release_positioning || '').trim(),
    sonic_palette: String(plan.sonic_palette || '').trim(),
    lyrical_rules: Array.isArray(plan.lyrical_rules) ? plan.lyrical_rules.map(rule => String(rule)).filter(Boolean) : [],
    track_count: tracks.length,
    tracks,
  };
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
