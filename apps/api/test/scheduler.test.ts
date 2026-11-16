import { describe, expect, test } from 'bun:test';
import {
  collectEachProject,
  heldPassDelay,
  nextPassDelay,
  startScheduler,
  type DueWork
} from '../src';

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

  test('a pass held until a time waits for it, then passes run at the interval again', async () => {
    // Held to a time that stays ahead of the clock, so no pass is due however slow the runner.
    let held = true;
    let reads = 0;
    const logged: string[] = [];
    const scheduler = startScheduler({
      intervalMs: 5,
      collect: async () => [],
      runStep: async () => {},
      resumeAt: () => {
        reads += 1;
        return held ? Date.now() + 20 : null;
      },
      log: (message) => logged.push(message)
    });
    // The hold read again and again, where a 5 ms interval alone would have run as many passes.
    await waitFor(() => reads >= 5);
    expect(scheduler.passes()).toBe(1);
    expect(logged).toEqual(Array.from({ length: reads }, () => 'next pass held'));
    held = false;
    await waitFor(() => scheduler.passes() >= 5);
    await scheduler.stop();
  });

  test('a rate limit a step meets after its pass holds the pass already waiting', async () => {
    let held = false;
    let reads = 0;
    let waitSet = () => {};
    const waitWasSet = new Promise<void>((resolve) => {
      waitSet = resolve;
    });
    const scheduler = startScheduler({
      intervalMs: 20,
      collect: async () => [work],
      runStep: async () => {
        // Still running when the wait for the next pass was set, as an agent session is.
        await waitWasSet;
        held = true;
      },
      resumeAt: () => {
        reads += 1;
        waitSet();
        return held ? Date.now() + 20 : null;
      }
    });
    // The 20 ms wait set before the step met the limit has ended and found the pass held.
    await waitFor(() => reads >= 5);
    expect(scheduler.passes()).toBe(1);
    held = false;
    await waitFor(() => scheduler.passes() >= 2);
    await scheduler.stop({ waitForSteps: true });
  });

  test('the wait before the next pass lasts until the time it is held to, at most an hour', () => {
    const now = 1_000_000;
    expect(heldPassDelay(15_000, null, now)).toBe(15_000);
    expect(heldPassDelay(15_000, now + 5_000, now)).toBe(15_000);
    expect(heldPassDelay(15_000, now + 120_000, now)).toBe(120_000);
    expect(heldPassDelay(15_000, now - 1_000, now)).toBe(15_000);
    expect(heldPassDelay(15_000, now + 24 * 60 * 60 * 1000, now)).toBe(60 * 60 * 1000);
  });

  test('the wait after failed passes never grows past five minutes', () => {
    expect(nextPassDelay(15_000, 0)).toBe(15_000);
    expect(nextPassDelay(15_000, 2)).toBe(60_000);
    expect(nextPassDelay(15_000, 30)).toBe(5 * 60 * 1000);
    expect(nextPassDelay(10 * 60 * 1000, 3)).toBe(10 * 60 * 1000);
  });
});

describe('a pass over several projects', () => {
  test('a project that throws is logged and the projects after it still run', async () => {
    const logged: { message: string; details: Record<string, unknown> | undefined }[] = [];
    const due = await collectEachProject(
      ['p1', 'p2'],
      async (projectId) => {
        if (projectId === 'p1') throw new Error('config unreadable');
        return [{ taskId: 't2', role: 'builder' }];
      },
      (message, details) => logged.push({ message, details })
    );
    expect(due).toEqual([{ taskId: 't2', role: 'builder' }]);
    expect(logged).toEqual([
      { message: 'project pass failed', details: { projectId: 'p1', error: 'config unreadable' } }
    ]);
  });
});
