import {
  adoptOutsidePushes,
  forwardSettledComments,
  collectDueSteps,
  createLiveRuns,
  guardOrphanedBuilds,
  cancelStaleAutoMerges,
  finishVerifiedSpecs,
  openMissingPullRequests,
  requestCopilotReviews,
  syncChecklistComments,
  type OnBehalf,
  runAgentStep,
  type EngineDependencies,
  type LiveRuns
} from '@officina/engine';
import {
  failOrphanedRuns,
  failStaleRuns,
  failTakenOverRuns,
  listActiveTaskIds,
  listSchedulableProjectIds,
  purgeConnectorCredentials,
  purgeExpiredCredentials,
  purgeOldAccessEvents,
  purgeOldDeliveries
} from '@officina/db';
import type { GitHubClient } from '@officina/github';
import {
  createAnthropicClient,
  createSdkPort,
  type AnthropicAuth,
  type ManagedAgentsPort,
  type ModelResolver,
  type RunnerRole,
  SESSION_DEADLINE_MS
} from '@officina/runner';
import type { Pool } from 'pg';
import { collectEachProject, startScheduler, type Scheduler } from './scheduler';
import { setupAgents } from './setup';
import { catchUpLearningPullRequests, catchUpPullRequests } from './catch-up';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Well past a session's own deadline, so only a run its step no longer looks after is failed. */
const STALE_RUN_MS = 2 * SESSION_DEADLINE_MS;

/** Interrupts the sessions of runs failed outside their step, best-effort: the run is failed already. */
const interruptSessions = async (
  agents: ManagedAgentsPort,
  runs: readonly { id: string; externalId: string | null }[],
  log: (message: string, details?: Record<string, unknown>) => void,
  message: string
) => {
  for (const run of runs) {
    log(message, run);
    if (run.externalId) {
      await agents.send(run.externalId, [{ type: 'user.interrupt' }]).catch(() => {});
    }
  }
};

export const createAgentsPort = (
  auth: AnthropicAuth,
  onRefreshError?: (error: unknown) => void
): ManagedAgentsPort => createSdkPort(createAnthropicClient(auth, onRefreshError));

/** Rows that are only kept for a while: expired credentials, old access events and webhook deliveries. */
const purgeStaleRows = async (
  pool: Pool,
  log: (message: string, details?: Record<string, unknown>) => void
) => {
  const purged = await purgeExpiredCredentials(pool).catch((error: unknown) => {
    log('credential purge failed', { error: (error as Error).message });
    return null;
  });
  if (purged && purged.loginLinks + purged.sessions + purged.oauthStates > 0)
    log('expired credentials purged', purged);
  const oldAccess = await purgeOldAccessEvents(pool).catch((error: unknown) => {
    log('access log purge failed', { error: (error as Error).message });
    return 0;
  });
  if (oldAccess > 0) log('access events older than a year purged', { rows: oldAccess });
  const connector = await purgeConnectorCredentials(pool).catch((error: unknown) => {
    log('connector credential purge failed', { error: (error as Error).message });
    return 0;
  });
  if (connector > 0) log('expired connector credentials purged', { rows: connector });
  const deliveries = await purgeOldDeliveries(pool).catch((error: unknown) => {
    log('webhook delivery purge failed', { error: (error as Error).message });
    return 0;
  });
  if (deliveries > 0) log('old webhook deliveries purged', { rows: deliveries });
};

/**
 * Starts the engine inside this process. Runs orphaned by a previous process are failed first, and
 * their sessions interrupted best-effort, so their steps can run again; a build among them whose
 * refs outside its branch moved blocks its task. With a prompts directory, the role agents are
 * synced first, so a new Opus release or a merged prompt change takes effect on the next boot. The
 * live runs are what a shutdown stops before the process exits.
 */
export const startEngine = async (input: {
  pool: Pool;
  github: GitHubClient;
  agents: ManagedAgentsPort;
  models: ModelResolver;
  intervalMs: number;
  publicUrl: string;
  promptsDir?: string;
  onBehalf?: OnBehalf | undefined;
  log: (message: string, details?: Record<string, unknown>) => void;
}): Promise<{ scheduler: Scheduler; liveRuns: LiveRuns }> => {
  const liveRuns = createLiveRuns({ agents: input.agents, github: input.github });
  const deps: EngineDependencies = {
    pool: input.pool,
    github: input.github,
    agents: input.agents,
    publicUrl: input.publicUrl,
    promptsDir: input.promptsDir,
    liveRuns
  };

  const orphaned = await failOrphanedRuns(input.pool);
  await interruptSessions(input.agents, orphaned, input.log, 'orphaned run failed');
  // After the sessions are stopped, so what the builders pushed until then is all in the refs.
  const moved = await guardOrphanedBuilds(
    deps,
    orphaned.map((run) => run.id)
  );
  for (const run of moved) input.log('orphaned build blocked', run);

  if (input.promptsDir) {
    // A failed sync must not keep the board down: the versions recorded last time still run.
    try {
      const model = await input.models.resolve('opus');
      const { changed } = await setupAgents(input.pool, input.agents, input.promptsDir, model.id);
      input.log('agents synced', { model: model.id, changed });
    } catch (error) {
      input.log('agent sync failed, keeping the recorded versions', {
        error: (error as Error).message
      });
    }
  }

  /** One project's share of a pass; it may throw, and `collectEachProject` keeps the others going. */
  const passProject = async (projectId: string) => {
    const active = await listActiveTaskIds(input.pool, projectId);
    // Before the due steps, so they follow the head taken in, and before the merge work below,
    // which writes Officina's own status commit on the branch.
    for (const failure of await adoptOutsidePushes(input.pool, input.github, active)) {
      input.log('outside push check failed', { projectId, ...failure });
    }
    for (const failure of await forwardSettledComments(input.pool, input.github, active)) {
      input.log('bot comment forwarding failed', { projectId, ...failure });
    }
    const { due } = await collectDueSteps(deps, projectId);
    const unfinished = await finishVerifiedSpecs(
      input.pool,
      input.github,
      active,
      input.onBehalf
    ).catch((error: unknown) => [{ error: (error as Error).message }]);
    for (const failure of unfinished) {
      input.log('spec status update failed', { projectId, ...failure });
    }
    // After the verifications above, so a result verified in this pass already says so.
    for (const failure of await syncChecklistComments(
      input.pool,
      input.github,
      active,
      input.publicUrl
    )) {
      input.log('checklist comment update failed', { projectId, ...failure });
    }
    // After the pass that may merge a pull request straight away, so that merge reaches its
    // task in the same pass.
    const uncaught = await catchUpPullRequests(
      input.pool,
      input.github,
      await listActiveTaskIds(input.pool, projectId)
    ).catch((error: unknown) => [{ error: (error as Error).message }]);
    for (const failure of uncaught) {
      input.log('pull request state catch-up failed', { projectId, ...failure });
    }
    const unapplied = await catchUpLearningPullRequests(input.pool, input.github, projectId).catch(
      (error: unknown) => [{ error: (error as Error).message }]
    );
    for (const failure of unapplied) {
      input.log('learning pull request catch-up failed', { projectId, ...failure });
    }
    const unopened = await openMissingPullRequests(
      input.pool,
      input.github,
      await listActiveTaskIds(input.pool, projectId),
      input.publicUrl
    ).catch((error: unknown) => [{ error: (error as Error).message }]);
    for (const failure of unopened) {
      input.log('pull request catch-up failed', { projectId, ...failure });
    }
    await requestCopilotReviews(
      input.pool,
      await listActiveTaskIds(input.pool, projectId),
      input.onBehalf
    ).catch((error: unknown) =>
      input.log('copilot review request failed', { projectId, error: (error as Error).message })
    );
    await cancelStaleAutoMerges(input.pool, input.github, projectId).catch((error: unknown) =>
      input.log('auto-merge cancel failed', { projectId, error: (error as Error).message })
    );
    return due;
  };

  let lastPurge = 0;
  const scheduler = startScheduler({
    intervalMs: input.intervalMs,
    // Every sub-step of a pass catches its own errors, so a rate limit never fails the pass: the
    // App client remembers when it resets, and no pass calls GitHub again before then.
    resumeAt: input.github.rateLimitedUntil,
    log: input.log,
    collect: async () => {
      // Hourly is plenty: expired rows are already refused, they only take up space.
      if (Date.now() - lastPurge >= PURGE_INTERVAL_MS) {
        lastPurge = Date.now();
        await purgeStaleRows(input.pool, input.log);
      }
      // A member who takes a build over stops the agent's session, which would only spend now.
      const takenOver = await failTakenOverRuns(input.pool).catch((error: unknown) => {
        input.log('taken over run stop failed', { error: (error as Error).message });
        return [];
      });
      await interruptSessions(input.agents, takenOver, input.log, 'taken over run stopped');
      const stale = await failStaleRuns(input.pool, STALE_RUN_MS).catch((error: unknown) => {
        input.log('stale run check failed', { error: (error as Error).message });
        return [];
      });
      await interruptSessions(input.agents, stale, input.log, 'stale run failed');
      return collectEachProject(
        await listSchedulableProjectIds(input.pool),
        passProject,
        input.log
      );
    },
    runStep: (work) => runAgentStep(deps, work.taskId, work.role as RunnerRole)
  });
  return { scheduler, liveRuns };
};
