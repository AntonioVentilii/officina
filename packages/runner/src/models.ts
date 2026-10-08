/*
 * The one place that knows which model id stands behind each tier. Opus follows the newest
 * `claude-opus-*` the Models API lists, so a new Opus release reaches the agents on the next boot
 * without editing ids anywhere.
 */

export type ModelTier = 'opus';

/** Used when the Models API cannot be read or lists nothing for the tier. */
export const PINNED_MODELS: Readonly<Record<ModelTier, string>> = { opus: 'claude-opus-5-5' };

const TIER_PREFIX: Readonly<Record<ModelTier, string>> = { opus: 'claude-opus-' };

/** An explicit id here wins over the lookup, e.g. to hold a new release back while it is checked. */
export const MODEL_OVERRIDE_ENV: Readonly<Record<ModelTier, string>> = { opus: 'ANTHROPIC_MODEL' };

export interface ListedModel {
  readonly id: string;
  readonly createdAt: string;
}

export interface ResolvedModel {
  readonly id: string;
  readonly source: 'env' | 'models_api' | 'pinned';
}

export interface ModelResolver {
  resolve(tier: ModelTier): Promise<ResolvedModel>;
}

/** The most recently created model whose id starts with `prefix`, or null when none is listed. */
export const newestModel = (models: readonly ListedModel[], prefix: string): string | null => {
  let newest: { id: string; at: number } | null = null;
  for (const model of models) {
    const at = Date.parse(model.createdAt);
    if (!model.id.startsWith(prefix) || Number.isNaN(at)) continue;
    if (!newest || at > newest.at) newest = { id: model.id, at };
  }
  return newest?.id ?? null;
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/**
 * Resolves each tier once and keeps the answer for the life of the process, so every agent synced
 * by this process runs the same model even if a release lands while it is up.
 */
export const createModelResolver = (deps: {
  listModels: () => Promise<readonly ListedModel[]>;
  env?: Readonly<Partial<Record<string, string>>>;
  log?: (message: string, details?: Record<string, unknown>) => void;
  /** Kept short so an unreachable API costs seconds, not the client's full timeout and retries. */
  timeoutMs?: number;
}): ModelResolver => {
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const cache = new Map<ModelTier, Promise<ResolvedModel>>();

  const lookup = async (tier: ModelTier): Promise<ResolvedModel> => {
    const override = deps.env?.[MODEL_OVERRIDE_ENV[tier]];
    if (override) return { id: override, source: 'env' };
    try {
      const newest = newestModel(
        await withTimeout(deps.listModels(), timeoutMs),
        TIER_PREFIX[tier]
      );
      if (newest) return { id: newest, source: 'models_api' };
      log('models api listed no model for the tier, using the pinned one', { tier });
    } catch (error) {
      log('model lookup failed, using the pinned one', { tier, error: (error as Error).message });
    }
    return { id: PINNED_MODELS[tier], source: 'pinned' };
  };

  return {
    resolve(tier) {
      let pending = cache.get(tier);
      if (!pending) {
        pending = lookup(tier).then((model) => {
          log('model in use', { tier, model: model.id, source: model.source });
          return model;
        });
        cache.set(tier, pending);
      }
      return pending;
    }
  };
};
