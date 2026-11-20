/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { coalesce } from '../src/lib/coalesce';
import { latestOnly } from '../src/lib/latest';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('coalesce', () => {
  test('a burst of calls costs one run', async () => {
    let runs = 0;
    const soon = coalesce(() => runs++, 5);
    soon();
    soon();
    soon();
    await wait(20);
    expect(runs).toBe(1);
  });

  test('calls during a run wait for it, then run once more', async () => {
    let running = 0;
    let most = 0;
    let runs = 0;
    const soon = coalesce(async () => {
      running++;
      most = Math.max(most, running);
      runs++;
      await wait(30);
      running--;
    }, 5);
    soon();
    await wait(10);
    soon();
    soon();
    await wait(100);
    expect(runs).toBe(2);
    expect(most).toBe(1);
  });

  test('loads land while events keep coming closer together than a load takes', async () => {
    const begin = latestOnly();
    let landed = 0;
    const load = async () => {
      const stale = begin();
      await wait(30);
      if (!stale()) landed++;
    };
    const soon = coalesce(load, 5);
    for (let event = 0; event < 12; event++) {
      soon();
      await wait(10);
    }
    expect(landed).toBeGreaterThan(0);
    await wait(80);
  });
});
