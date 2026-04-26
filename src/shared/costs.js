/**
 * Cost tracking for Pancake Robot API calls
 * Sonnet 4.6: $3/MTok input, $15/MTok output
 */

// Pricing constants
export const PRICING = {
  INPUT_PER_TOKEN: 3 / 1_000_000,      // $3 per million input tokens
  OUTPUT_PER_TOKEN: 15 / 1_000_000,    // $15 per million output tokens
  CACHE_READ_PER_TOKEN: 0.30 / 1_000_000, // $0.30 per million cache read tokens (10% of input)
};

/**
 * Calculate cost for a given token usage
 */
export function calculateCost({ inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 }) {
  const inputCost = inputTokens * PRICING.INPUT_PER_TOKEN;
  const outputCost = outputTokens * PRICING.OUTPUT_PER_TOKEN;
  const cacheReadCost = cacheReadTokens * PRICING.CACHE_READ_PER_TOKEN;
  return inputCost + outputCost + cacheReadCost;
}

/**
 * Format cost as USD string
 */
export function formatCost(costUsd) {
  if (costUsd < 0.01) {
    return `$${(costUsd * 1000).toFixed(3)}m`; // millidollars
  }
  return `$${costUsd.toFixed(4)}`;
}

/**
 * Format token count with K/M suffix
 */
export function formatTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

/**
 * Generate a unique run ID
 */
export function generateRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
