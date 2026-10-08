import { describe, expect, test } from 'bun:test';
import { PINNED_MODELS, createModelResolver, newestModel, type ListedModel } from '../src';

const LISTED: ListedModel[] = [
  { id: 'claude-opus-5', createdAt: '2026-04-10T00:00:00Z' },
  { id: 'claude-sonnet-6', createdAt: '2026-12-01T00:00:00Z' },
  { id: 'claude-opus-6', createdAt: '2026-11-20T00:00:00Z' },
  { id: 'claude-opus-5-5', createdAt: '2026-08-15T00:00:00Z' }
];

const collect = () => {
  const lines: { message: string; details: Record<string, unknown> | undefined }[] = [];
  return {
    lines,
    log: (message: string, details?: Record<string, unknown>) => lines.push({ message, details })
  };
};

describe('newestModel', () => {
  test('picks the most recently created model of the tier, whatever the list order', () => {
    expect(newestModel(LISTED, 'claude-opus-')).toBe('claude-opus-6');
    expect(newestModel([...LISTED].reverse(), 'claude-opus-')).toBe('claude-opus-6');
  });

  test('returns null when nothing in the tier is listed', () => {
    expect(
      newestModel([{ id: 'claude-haiku-4-5', createdAt: '2025-10-01T00:00:00Z' }], 'claude-opus-')
    ).toBeNull();
  });
});

describe('createModelResolver', () => {
  test('resolves opus to the newest listed opus and logs it', async () => {
    const { lines, log } = collect();
    const resolver = createModelResolver({ listModels: async () => LISTED, env: {}, log });
    expect(await resolver.resolve('opus')).toEqual({ id: 'claude-opus-6', source: 'models_api' });
    expect(lines).toContainEqual({
      message: 'model in use',
      details: { tier: 'opus', model: 'claude-opus-6', source: 'models_api' }
    });
  });

  test('looks the model up once per process', async () => {
    let calls = 0;
    const resolver = createModelResolver({
      listModels: async () => {
        calls++;
        return LISTED;
      }
    });
    await Promise.all([resolver.resolve('opus'), resolver.resolve('opus')]);
    await resolver.resolve('opus');
    expect(calls).toBe(1);
  });

  test('falls back to the pinned opus when the lookup fails, and says so', async () => {
    const { lines, log } = collect();
    const resolver = createModelResolver({
      listModels: async () => {
        throw new Error('503 overloaded');
      },
      log
    });
    expect(await resolver.resolve('opus')).toEqual({ id: PINNED_MODELS.opus, source: 'pinned' });
    expect(PINNED_MODELS.opus).toBe('claude-opus-5-5');
    expect(lines.map((line) => line.message)).toEqual([
      'model lookup failed, using the pinned one',
      'model in use'
    ]);
  });

  test('falls back to the pinned opus when the Models API does not answer in time', async () => {
    const resolver = createModelResolver({
      listModels: () => new Promise(() => {}),
      timeoutMs: 5
    });
    expect(await resolver.resolve('opus')).toEqual({ id: PINNED_MODELS.opus, source: 'pinned' });
  });

  test('falls back to the pinned opus when no opus is listed', async () => {
    const resolver = createModelResolver({
      listModels: async () => [{ id: 'claude-sonnet-5-5', createdAt: '2026-08-15T00:00:00Z' }]
    });
    expect(await resolver.resolve('opus')).toEqual({ id: PINNED_MODELS.opus, source: 'pinned' });
  });

  test('an explicit ANTHROPIC_MODEL wins without calling the Models API', async () => {
    let called = false;
    const resolver = createModelResolver({
      listModels: async () => {
        called = true;
        return LISTED;
      },
      env: { ANTHROPIC_MODEL: 'claude-opus-5' }
    });
    expect(await resolver.resolve('opus')).toEqual({ id: 'claude-opus-5', source: 'env' });
    expect(called).toBe(false);
  });
});
