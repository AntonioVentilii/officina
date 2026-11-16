import { appendRunEvent } from '@officina/db';
import type { ManagedAgentsPort } from '@officina/runner';
import type { GitHubPort, Step } from './step';

/** How many times a run's token is revoked before giving up, and the wait that grows between. */
const REVOKE_ATTEMPTS = 3;
const REVOKE_BACKOFF_MS = 250;

/**
 * Revokes a build run's write token, trying again with a short backoff: a token left valid could
 * still push for up to an hour. `false` when GitHub refused every try.
 */
export const revokeRunToken = async (
  github: Pick<GitHubPort, 'revokeToken'>,
  token: string
): Promise<boolean> => {
  for (let attempt = 1; attempt <= REVOKE_ATTEMPTS; attempt++) {
    const revoked = await github.revokeToken(token).then(
      () => true,
      () => false
    );
    if (revoked) return true;
    if (attempt < REVOKE_ATTEMPTS) await Bun.sleep(REVOKE_BACKOFF_MS * attempt);
  }
  return false;
};

/** One session running in this process, and the write token minted for it if it builds. */
export interface LiveRun {
  /** The session the run started, for a shutdown to interrupt. */
  session(sessionId: string): void;
  /** The run ended on its own; `false` when a shutdown stopped it already, token included. */
  end(): boolean;
}

export interface LiveRuns {
  start(token: string | null): LiveRun;
  /**
   * Interrupts every session still running in this process and revokes every token minted for one,
   * for a process that is shutting down, whose steps never reach their own cleanup; a run that
   * starts afterwards is stopped as it starts. `false` when the deadline came first: what is left
   * is interrupted on the next boot, and its token expires within the hour.
   */
  stopAll(deadlineMs: number): Promise<boolean>;
}

interface Run {
  readonly token: string | null;
  sessionId: string | null;
}

export const createLiveRuns = (ports: {
  readonly agents: Pick<ManagedAgentsPort, 'send'>;
  readonly github: Pick<GitHubPort, 'revokeToken'>;
}): LiveRuns => {
  const runs = new Set<Run>();
  let closing = false;
  // Best-effort, as at boot for orphaned runs: the token is what stops a push.
  const interrupt = (sessionId: string) =>
    ports.agents.send(sessionId, [{ type: 'user.interrupt' }]).catch(() => {});
  const stop = (run: Run) =>
    Promise.all([
      run.sessionId ? interrupt(run.sessionId) : null,
      run.token ? revokeRunToken(ports.github, run.token) : null
    ]);

  return {
    start(token) {
      const run: Run = { token, sessionId: null };
      if (closing) void stop(run);
      else runs.add(run);
      return {
        session(sessionId) {
          if (runs.has(run)) run.sessionId = sessionId;
          else void interrupt(sessionId);
        },
        end: () => runs.delete(run)
      };
    },
    async stopAll(deadlineMs) {
      closing = true;
      const stopping = Promise.all(
        [...runs].map((run) => {
          runs.delete(run);
          return stop(run);
        })
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
      });
      const done = await Promise.race([stopping.then(() => true), late]);
      clearTimeout(timer);
      return done;
    }
  };
};

/**
 * Runs a step's session with its GitHub token. Only the build roles get a token that can push,
 * minted for this run alone and revoked when the session ends, so nothing it pushes can land after
 * the refs are checked. The run is live meanwhile, for a shutdown to stop. A revocation GitHub
 * refuses is recorded on the run and leaves the session's result, or its error, as it was.
 */
export const withRunToken = async <T>(
  step: Step,
  use: (token: string, live: LiveRun | undefined) => Promise<T>
): Promise<T> => {
  const { github, pool } = step.deps;
  const token = step.builds
    ? await github.runToken(step.repoRef, { contents: 'write' })
    : await github.installationToken(step.repoRef, { contents: 'read' });
  const live = step.deps.liveRuns?.start(step.builds ? token : null);
  try {
    return await use(token, live);
  } finally {
    const stoppedByShutdown = live?.end() === false;
    if (step.builds && !stoppedByShutdown && !(await revokeRunToken(github, token)))
      await appendRunEvent(pool, step.runId, 'token_revoke_failed', {}).catch(() => {});
  }
};
