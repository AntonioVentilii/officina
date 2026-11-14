import { describe, expect, test } from 'bun:test';
import { nextPassDelay, startScheduler, type DueWork } from '../src';

const waitFor = async (condition: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
};

const work: DueWork = { taskId: 't1', role: 'builder' };

describe('scheduler', () => {
  test('never starts a step that is still running in this process', async () => {
    let calls = 0;
    let finish = () => {};
    const scheduler = startScheduler({
      intervalMs: 5,
      collect: async () => [work],
      runStep: () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    });

    await waitFor(() => scheduler.passes() >= 4);
    expect(calls).toBe(1);
    expect(scheduler.inFlight()).toBe(1);

    finish();
    await waitFor(() => calls === 2);
    await scheduler.stop();
  });

  test('a failing pass or step is logged and scheduling continues', async () => {
    const logged: string[] = [];
    let collects = 0;
    const scheduler = startScheduler({
      intervalMs: 5,
      log: (message) => logged.push(message),
      collect: async () => {
        collects += 1;
        if (collects === 1) throw new Error('database unavailable');
        return [work];
      },
      runStep: async () => {
        throw new Error('session failed');
      }
    });
    await waitFor(
      () => logged.includes('pass failed') && logged.includes('step failed') && collects >= 3
    );
    await scheduler.stop();
  });

  test('stop can wait for running steps to settle', async () => {
    let settled = false;
    const scheduler = startScheduler({
      intervalMs: 1000,
      collect: async () => [work],
      runStep: async () => {
        await Bun.sleep(30);
        settled = true;
      }
    });
    await waitFor(() => scheduler.inFlight() === 1);
    await scheduler.stop({ waitForSteps: true });
    expect(settled).toBe(true);
  });

  test('passes that keep failing wait longer each time, and one that succeeds resets the wait', async () => {
    let collects = 0;
    const failures: unknown[] = [];
    const scheduler = startScheduler({
      intervalMs: 5,
      collect: async () => {
        collects += 1;
        // Four failures, one success, then a fifth failure, which counts from one again.
        if (collects <= 4 || collects === 6) throw new Error('database unavailable');
        return [];
      },
      runStep: async () => {},
      log: (_message, details) => failures.push(details?.failedInARow)
    });
    // Waits of 10, 20 and 40 ms after the first three failures: a fixed 5 ms would give a dozen.
    await Bun.sleep(60);
    expect(scheduler.passes()).toBeLessThan(5);
    await waitFor(() => failures.length === 5);
    await scheduler.stop();
    expect(failures).toEqual([1, 2, 3, 4, 1]);
  });

  test('the wait after failed passes never grows past five minutes', () => {
    expect(nextPassDelay(15_000, 0)).toBe(15_000);
    expect(nextPassDelay(15_000, 2)).toBe(60_000);
    expect(nextPassDelay(15_000, 30)).toBe(5 * 60 * 1000);
    expect(nextPassDelay(10 * 60 * 1000, 3)).toBe(10 * 60 * 1000);
  });
});
