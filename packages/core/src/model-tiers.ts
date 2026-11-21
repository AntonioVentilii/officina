/*
 * The model tiers an agent step runs on. The runner resolves each to a model id; the engine picks
 * one for each step by rule, and a maintainer may force one on a task, so the list lives here where
 * the task, the store and the runner all read it.
 */

/** The tiers from the cheapest to the strongest; a step escalates to the next one. */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Each tier as people read it on the board, in the CLI and in Claude. */
export const MODEL_TIER_LABELS: Readonly<Record<ModelTier, string>> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus'
};

export const isModelTier = (value: string): value is ModelTier =>
  (MODEL_TIERS as readonly string[]).includes(value);
