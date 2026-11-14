import {
  adoptOutsidePushes,
  collectDueSteps,
  cancelStaleAutoMerges,
  finishVerifiedSpecs,
  openMissingPullRequests,
  requestCopilotReviews,
  type OnBehalf,
  runAgentStep,
  type EngineDependencies
} from '@officina/engine';
import {
  failOrphanedRuns,
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
  type RunnerRole
} from '@officina/runner';
import type { Pool } from 'pg';
import { startScheduler, type Scheduler } from './scheduler';
import { setupAgents } from './setup';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export const createAgentsPort = (
  auth: AnthropicAuth,
  onRefreshError?: (error: unknown) => void
): ManagedAgentsPort => createSdkPort(createAnthropicClient(auth, onRefreshError));

/**
 * Starts the engine inside this process. Runs orphaned by a previous process are failed first, and
 * their sessions interrupted best-effort, so their steps can run again. With a prompts directory,
 * the role agents are synced first, so a new Opus release or a merged prompt change takes effect on
 * the next boot.
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
}): Promise<Scheduler> => {
  const deps: EngineDependencies = {
    pool: input.pool,
    github: input.github,
    agents: input.agents,
    publicUrl: input.publicUrl,
    promptsDir: input.promptsDir
  };

  for (const run of await failOrphanedRuns(input.pool)) {
    input.log('orphaned run failed', run);
    if (run.externalId) {
      await input.agents.send(run.externalId, [{ type: 'user.interrupt' }]).catch(() => {});
    }
  }

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

  let lastPurge = 0;
  return startScheduler({
    intervalMs: input.intervalMs,
    log: input.log,
    collect: async () => {
      // Hourly is plenty: expired rows are already refused, they only take up space.
      if (Date.now() - lastPurge >= PURGE_INTERVAL_MS) {
        lastPurge = Date.now();
        const purged = await purgeExpiredCredentials(input.pool).catch((error: unknown) => {
          input.log('credential purge failed', { error: (error as Error).message });
          return null;
        });
        if (purged && purged.loginLinks + purged.sessions + purged.oauthStates > 0)
          input.log('expired credentials purged', purged);
        const oldAccess = await purgeOldAccessEvents(input.pool).catch((error: unknown) => {
          input.log('access log purge failed', { error: (error as Error).message });
          return 0;
        });
        if (oldAccess > 0) input.log('access events older than a year purged', { rows: oldAccess });
        const connector = await purgeConnectorCredentials(input.pool).catch((error: unknown) => {
          input.log('connector credential purge failed', { error: (error as Error).message });
          return 0;
        });
        if (connector > 0) input.log('expired connector credentials purged', { rows: connector });
        const deliveries = await purgeOldDeliveries(input.pool).catch((error: unknown) => {
          input.log('webhook delivery purge failed', { error: (error as Error).message });
          return 0;
        });
        if (deliveries > 0) input.log('old webhook deliveries purged', { rows: deliveries });
      }
      const due = [];
      for (const projectId of await listSchedulableProjectIds(input.pool)) {
        const active = await listActiveTaskIds(input.pool, projectId);
        // Before the due steps, so they follow the head taken in, and before the merge work below,
        // which writes Officina's own status commit on the branch.
        await adoptOutsidePushes(input.pool, input.github, active).catch((error: unknown) =>
          input.log('outside push check failed', { projectId, error: (error as Error).message })
        );
        due.push(...(await collectDueSteps(deps, projectId)).due);
        const unfinished = await finishVerifiedSpecs(
          input.pool,
          input.github,
          active,
          input.onBehalf
        ).catch((error: unknown) => [{ error: (error as Error).message }]);
        for (const failure of unfinished) {
          input.log('spec status update failed', { projectId, ...failure });
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
      }
      return due;
    },
    runStep: (work) => runAgentStep(deps, work.taskId, work.role as RunnerRole)
  });
};
