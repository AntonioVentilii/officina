import { collectDueSteps, runAgentStep, type EngineDependencies } from '@officina/engine';
import { failOrphanedRuns, listSchedulableProjectIds } from '@officina/db';
import type { GitHubClient } from '@officina/github';
import {
  createAnthropicClient,
  createSdkPort,
  type AnthropicAuth,
  type ManagedAgentsPort,
  type RunnerRole
} from '@officina/runner';
import type { Pool } from 'pg';
import { startScheduler, type Scheduler } from './scheduler';

export const createAgentsPort = (
  auth: AnthropicAuth,
  onRefreshError?: (error: unknown) => void
): ManagedAgentsPort => createSdkPort(createAnthropicClient(auth, onRefreshError));

/**
 * Starts the engine inside this process. Runs orphaned by a previous process are failed first, and
 * their sessions interrupted best-effort, so their steps can run again.
 */
export const startEngine = async (input: {
  pool: Pool;
  github: GitHubClient;
  agents: ManagedAgentsPort;
  intervalMs: number;
  log: (message: string, details?: Record<string, unknown>) => void;
}): Promise<Scheduler> => {
  const deps: EngineDependencies = { pool: input.pool, github: input.github, agents: input.agents };

  for (const run of await failOrphanedRuns(input.pool)) {
    input.log('orphaned run failed', run);
    if (run.externalId) {
      await input.agents.send(run.externalId, [{ type: 'user.interrupt' }]).catch(() => {});
    }
  }

  return startScheduler({
    intervalMs: input.intervalMs,
    log: input.log,
    collect: async () => {
      const due = [];
      for (const projectId of await listSchedulableProjectIds(input.pool)) {
        due.push(...(await collectDueSteps(deps, projectId)).due);
      }
      return due;
    },
    runStep: (work) => runAgentStep(deps, work.taskId, work.role as RunnerRole)
  });
};
