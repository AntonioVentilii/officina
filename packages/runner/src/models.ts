/*
 * The one place that knows which model id stands behind each tier. Each tier follows the newest
 * model of its family the Models API lists, so a new release reaches the agents on the next boot
 * without editing ids anywhere. The engine picks a tier for each step; Haiku also runs the reading
 * worker the builder and the correctness reviewer hand exploration to.
 */

import type { ModelTier } from '@officina/core';

/** Used when the Models API cannot be read or lists nothing for the tier. */
export const PINNED_MODELS: Readonly<Record<ModelTier, string>> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5'
};

const TIER_PREFIX: Readonly<Record<ModelTier, string>> = {
  haiku: 'claude-haiku-',
  sonnet: 'claude-sonnet-',
  opus: 'claude-opus-'
};

/** An explicit id here wins over the lookup, e.g. to hold a new release back while it is checked. */
export const MODEL_OVERRIDE_ENV: Readonly<Record<ModelTier, string>> = {
  haiku: 'ANTHROPIC_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_SONNET_MODEL',
  opus: 'ANTHROPIC_MODEL'
};

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

/** The id of every tier, for the agents a sync writes. */
export type TierModels = Readonly<Record<ModelTier, string>>;

/** A resolver that never asks: every tier is its pinned id, for tests and local runs. */
export const PINNED_RESOLVER: ModelResolver = {
  resolve: async (tier) => ({ id: PINNED_MODELS[tier], source: 'pinned' })
};

/** Every tier's id, resolved through `resolver`. */
export const resolveTiers = async (resolver: ModelResolver): Promise<TierModels> => {
  const [haiku, sonnet, opus] = await Promise.all([
    resolver.resolve('haiku'),
    resolver.resolve('sonnet'),
    resolver.resolve('opus')
  ]);
  return { haiku: haiku.id, sonnet: sonnet.id, opus: opus.id };
};

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
