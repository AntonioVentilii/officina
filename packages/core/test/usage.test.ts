import { describe, expect, test } from 'bun:test';
import { NO_TOKENS, addTokens } from '../src/usage';

describe('run usage', () => {
  test('tokens add up kind by kind, and a run with none adds nothing', () => {
    const build = { input: 164, output: 72_500, cacheRead: 13_700_000, cacheWrite: 269_000 };
    const review = { input: 20, output: 14_300, cacheRead: 1_600_000, cacheWrite: 88_000 };
    expect(addTokens(addTokens(NO_TOKENS, build), review)).toEqual({
      input: 184,
      output: 86_800,
      cacheRead: 15_300_000,
      cacheWrite: 357_000
    });
    expect(addTokens(build, null)).toEqual(build);
  });
});
