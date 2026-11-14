/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { latestOnly } from '../src/lib/latest';

describe('latestOnly', () => {
  test('a slow answer for a project no longer selected is dropped, the newest one lands', async () => {
    const begin = latestOnly();
    const shown: string[] = [];
    const load = async (project: string, answer: Promise<void>) => {
      const stale = begin();
      await answer;
      if (!stale()) shown.push(project);
    };
    let answerA = () => {};
    const slowA = load('a', new Promise<void>((resolve) => (answerA = resolve)));
    await load('b', Promise.resolve());
    answerA();
    await slowA;
    expect(shown).toEqual(['b']);
  });

  test('each counter has its own loads, so one never makes another stale', () => {
    const one = latestOnly();
    const other = latestOnly();
    const first = one();
    other();
    expect(first()).toBe(false);
    one();
    expect(first()).toBe(true);
  });
});
