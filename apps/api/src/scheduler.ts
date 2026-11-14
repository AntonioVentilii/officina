/** The longest wait between passes while they keep failing, however many failed in a row. */
const MAX_FAILED_PASS_DELAY_MS = 5 * 60 * 1000;

/** The wait before the next pass: the interval, doubled for each pass that failed in a row, up to the cap. */
export const nextPassDelay = (intervalMs: number, failedInARow: number): number =>
  Math.max(intervalMs, Math.min(intervalMs * 2 ** failedInARow, MAX_FAILED_PASS_DELAY_MS));

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
 * Collects the due work of each project in turn. A project whose pass throws is logged and left out
 * of this pass only, so one broken project never holds back the others.
 */
export const collectEachProject = async (
  projectIds: readonly string[],
  collectOne: (projectId: string) => Promise<readonly DueWork[]>,
  log: (message: string, details?: Record<string, unknown>) => void
): Promise<DueWork[]> => {
  const due: DueWork[] = [];
  for (const projectId of projectIds) {
    try {
      due.push(...(await collectOne(projectId)));
    } catch (error) {
      log('project pass failed', { projectId, error: (error as Error).message });
    }
  }
  return due;
};

/**
 * Polls for due work and starts each step without waiting for it, because an agent session can run
 * for many minutes. A step already running in this process is never started again; the database
 * claim guards against other processes. A failing pass or step is logged and never stops the loop;
 * passes that keep failing wait longer each time (`nextPassDelay`), and one that succeeds resets it.
 */
export const startScheduler = (options: SchedulerOptions): Scheduler => {
  const log = options.log ?? (() => {});
  const inFlight = new Map<string, Promise<void>>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentPass: Promise<void> = Promise.resolve();
  let passes = 0;
  let failedInARow = 0;

  const pass = async () => {
    for (const work of await options.collect()) {
      const key = `${work.taskId}:${work.role}`;
      if (inFlight.has(key)) continue;
      const running = options
        .runStep(work)
        .then((result) => log('step finished', { ...work, result }))
        .catch((error: Error) =>
          log('step failed', {
            ...work,
            error: error.message,
            stack: String(error.stack).split('\n').slice(0, 8).join('\n')
          })
        )
        .finally(() => inFlight.delete(key));
      inFlight.set(key, running);
    }
  };

  const loop = async () => {
    if (stopped) return;
    currentPass = pass()
      .then(() => {
        failedInARow = 0;
      })
      .catch((error: Error) => {
        failedInARow += 1;
        log('pass failed', { error: error.message, failedInARow });
      })
      .finally(() => {
        passes += 1;
      });
    await currentPass;
    if (!stopped) timer = setTimeout(loop, nextPassDelay(options.intervalMs, failedInARow));
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
