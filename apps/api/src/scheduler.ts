export interface DueWork {
  readonly taskId: string;
  readonly role: string;
}

export interface SchedulerOptions {
  /** Lists the steps due now (and dispatches ready tasks) across all projects. */
  readonly collect: () => Promise<readonly DueWork[]>;
  readonly runStep: (work: DueWork) => Promise<unknown>;
  readonly intervalMs: number;
  readonly log?: (message: string, details?: Record<string, unknown>) => void;
}

export interface Scheduler {
  /** Stops scheduling new passes; optionally waits for steps already running to settle. */
  stop(options?: { waitForSteps?: boolean }): Promise<void>;
  readonly inFlight: () => number;
  /** Resolves after the next pass completes, for tests and graceful startup checks. */
  readonly passes: () => number;
}

/**
 * Polls for due work and starts each step without waiting for it, because an agent session can run
 * for many minutes. A step already running in this process is never started again; the database
 * claim guards against other processes. A failing pass or step is logged and never stops the loop.
 */
export const startScheduler = (options: SchedulerOptions): Scheduler => {
  const log = options.log ?? (() => {});
  const inFlight = new Map<string, Promise<void>>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentPass: Promise<void> = Promise.resolve();
  let passes = 0;

  const pass = async () => {
    for (const work of await options.collect()) {
      const key = `${work.taskId}:${work.role}`;
      if (inFlight.has(key)) continue;
      const running = options
        .runStep(work)
        .then((result) => log('step finished', { ...work, result }))
        .catch((error: Error) => log('step failed', { ...work, error: error.message }))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, running);
    }
  };

  const loop = async () => {
    if (stopped) return;
    currentPass = pass()
      .catch((error: Error) => log('pass failed', { error: error.message }))
      .finally(() => {
        passes += 1;
      });
    await currentPass;
    if (!stopped) timer = setTimeout(loop, options.intervalMs);
  };
  void loop();

  return {
    async stop({ waitForSteps = false } = {}) {
      stopped = true;
      clearTimeout(timer);
      await currentPass;
      if (waitForSteps) await Promise.allSettled([...inFlight.values()]);
    },
    inFlight: () => inFlight.size,
    passes: () => passes
  };
};
