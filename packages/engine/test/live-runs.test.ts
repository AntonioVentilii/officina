import { describe, expect, test } from 'bun:test';
import { createLiveRuns } from '../src';

const recording = (revoke: (token: string) => Promise<void> = async () => {}) => {
  const interrupted: string[] = [];
  const revoked: string[] = [];
  const liveRuns = createLiveRuns({
    agents: {
      send: async (sessionId) => {
        interrupted.push(sessionId);
      }
    },
    github: {
      revokeToken: async (token) => {
        revoked.push(token);
        await revoke(token);
      }
    }
  });
  return { liveRuns, interrupted, revoked };
};

describe('live runs', () => {
  test('a shutdown stops the runs still going and leaves those that ended alone', async () => {
    const { liveRuns, interrupted, revoked } = recording();
    const build = liveRuns.start('run_1', 'token-write');
    build.session('sesn_1');
    const review = liveRuns.start('run_2', null);
    review.session('sesn_2');
    const done = liveRuns.start('run_3', 'token-done');
    done.session('sesn_3');
    expect(done.end()).toBe(true);

    expect(await liveRuns.stopAll(1_000)).toBe(true);
    expect(interrupted.sort()).toEqual(['sesn_1', 'sesn_2']);
    expect(revoked).toEqual(['token-write']);
    // Its step must not revoke the token a second time.
    expect(build.end()).toBe(false);
  });

  test('a run that starts while the process shuts down is stopped as it starts', async () => {
    const { liveRuns, interrupted, revoked } = recording();
    await liveRuns.stopAll(1_000);
    const late = liveRuns.start('run_9', 'token-late');
    late.session('sesn_9');
    await Bun.sleep(0);
    expect(revoked).toEqual(['token-late']);
    expect(interrupted).toEqual(['sesn_9']);
    expect(late.end()).toBe(false);
  });

  test('only the runs that ended outside their step are stopped, once, and their steps revoke nothing', async () => {
    const { liveRuns, interrupted, revoked } = recording();
    const takenOver = liveRuns.start('run_1', 'token-taken');
    takenOver.session('sesn_1');
    const going = liveRuns.start('run_2', 'token-going');
    going.session('sesn_2');
    const asked: (readonly string[])[] = [];
    const ended = async (runIds: readonly string[]) => {
      asked.push(runIds);
      return ['run_1'];
    };

    expect(await liveRuns.stopEnded(ended)).toEqual(['run_1']);
    expect(asked).toEqual([['run_1', 'run_2']]);
    expect(interrupted).toEqual(['sesn_1']);
    expect(revoked).toEqual(['token-taken']);
    expect(takenOver.end()).toBe(false);

    expect(await liveRuns.stopEnded(ended)).toEqual([]);
    expect(interrupted).toEqual(['sesn_1']);
    expect(going.end()).toBe(true);
    expect(await liveRuns.stopEnded(ended)).toEqual([]);
    expect(asked).toHaveLength(2);
  });

  test('a run stopped before its session started has the session interrupted as it starts', async () => {
    const { liveRuns, interrupted, revoked } = recording();
    const early = liveRuns.start('run_1', 'token-early');
    expect(await liveRuns.stopEnded(async () => ['run_1'])).toEqual(['run_1']);
    expect(revoked).toEqual(['token-early']);
    early.session('sesn_1');
    await Bun.sleep(0);
    expect(interrupted).toEqual(['sesn_1']);
  });

  test('a shutdown gives up at its deadline, before the platform kills the process', async () => {
    const { liveRuns } = recording(() => new Promise(() => {}));
    liveRuns.start('run_1', 'token-stuck');
    const started = Date.now();
    expect(await liveRuns.stopAll(50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a token GitHub refuses at first is revoked on a later try', async () => {
    let tries = 0;
    const { liveRuns, revoked } = recording(async () => {
      tries += 1;
      if (tries === 1) throw new Error('GitHub 502 on /installation/token');
    });
    liveRuns.start('run_1', 'token-write');
    expect(await liveRuns.stopAll(2_000)).toBe(true);
    expect(revoked).toEqual(['token-write', 'token-write']);
  });
});
