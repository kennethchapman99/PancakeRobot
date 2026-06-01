/**
 * Single-song generation cost modes.
 *
 * Three tiers control which agents run, which model/token budget the lyricist
 * uses, and what hard budget caps apply per phase.  Album batches have their
 * own parallel config in album-batch-service.js; this module covers individual
 * song generation via magic-pipeline-service.js.
 *
 *   draft    — fast iteration; Haiku model, low token cap, skip optional agents
 *   standard — daily default; Sonnet with capped budget, all core agents
 *   premium  — final release candidate; full token budget, every agent
 */

export const SONG_GENERATION_MODES = Object.freeze({
  DRAFT: 'draft',
  STANDARD: 'standard',
  PREMIUM: 'premium',
});

const VALID_MODES = new Set(['draft', 'standard', 'premium']);

export function normalizeSongGenerationMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : 'standard';
}

/**
 * Per-mode configuration.
 *
 * lyricistMaxTokens    — hard cap on lyricist output tokens
 * lyricistModel        — Anthropic model for the lyricist agent
 * skipBrandReview      — skip the post-lyrics brand-consistency review
 * skipPerformanceBrief — skip the pre-lyrics performance brief agent
 * researchCacheMinutes — max age of research report before re-running researcher
 * phaseBudgetCapsUsd   — hard USD ceiling per pipeline phase (0 = no cap applied)
 * estimatedMaxCostUsd  — advertised worst-case cost shown in the UI before generation
 */
export const SONG_GENERATION_MODE_CONFIG = Object.freeze({
  draft: {
    label: 'Draft',
    description: 'Fast iteration — Haiku model, low token cap, brand review skipped',
    lyricistMaxTokens: 4000,
    lyricistModel: 'claude-haiku-4-5-20251001',
    skipBrandReview: true,
    skipPerformanceBrief: true,
    researchCacheMinutes: 1440,
    phaseBudgetCapsUsd: {
      brand_interpretation: 0,
      lyrics_generation: 0.05,
      orchestration: 0.05,
      music_generation: 0.20,
    },
    estimatedMaxCostUsd: 0.25,
  },
  standard: {
    label: 'Standard',
    description: 'Daily default — Sonnet with capped budget, brand review included',
    lyricistMaxTokens: 8000,
    lyricistModel: 'claude-sonnet-4-6',
    skipBrandReview: false,
    skipPerformanceBrief: false,
    researchCacheMinutes: 60,
    phaseBudgetCapsUsd: {
      brand_interpretation: 0.12,
      lyrics_generation: 0.20,
      orchestration: 0.20,
      music_generation: 0.20,
    },
    estimatedMaxCostUsd: 0.50,
  },
  premium: {
    label: 'Premium',
    description: 'Final release candidate — full token budget, every agent',
    lyricistMaxTokens: 20000,
    lyricistModel: 'claude-sonnet-4-6',
    skipBrandReview: false,
    skipPerformanceBrief: false,
    researchCacheMinutes: 30,
    phaseBudgetCapsUsd: {
      brand_interpretation: 0.30,
      lyrics_generation: 0.60,
      orchestration: 0.60,
      music_generation: 0.20,
    },
    estimatedMaxCostUsd: 1.50,
  },
});

export function getSongGenerationModeConfig(mode) {
  return SONG_GENERATION_MODE_CONFIG[normalizeSongGenerationMode(mode)];
}

/**
 * Check whether a phase cost has overrun its budget cap.
 * Returns null when no cap is configured (cap === 0).
 */
export function checkPhaseBudget(mode, phase, actualCostUsd) {
  const config = getSongGenerationModeConfig(mode);
  const cap = config.phaseBudgetCapsUsd[phase];
  if (!cap) return null;
  if (actualCostUsd > cap) {
    return { overrun: true, cap, actual: actualCostUsd, excess: actualCostUsd - cap };
  }
  return { overrun: false, cap, actual: actualCostUsd };
}
