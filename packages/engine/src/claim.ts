import { parseProjectConfig, type ProjectConfig } from '@officina/core';
import {
  loadAgentVersions,
  loadTaskContext,
  startRun,
  type AgentVersionRecord,
  type StoredTaskContext
} from '@officina/db';
import type { RepoRef } from '@officina/github';
import { RUNNER, type RunnerRole } from '@officina/runner';
import type { Pool } from 'pg';

/** Why a step cannot run that lies in the project's setup, not the task: no later pass clears it alone. */
export const PROJECT_SKIP_REASONS = [
  'not_installed',
  'no_environment',
  'agent_not_synced',
  'invalid_config'
] as const;
export type ProjectSkipReason = (typeof PROJECT_SKIP_REASONS)[number];

export type SkipReason = 'not_found' | 'not_due' | ProjectSkipReason | 'already_running';

/** A run claimed for one role on one task, with everything every step needs to start it. */
export interface ClaimedStep {
  readonly context: StoredTaskContext;
  readonly config: ProjectConfig;
  readonly agent: AgentVersionRecord;
  readonly runId: string;
  readonly environmentId: string;
  readonly repoRef: RepoRef;
}

/**
 * Checks a step can run (the task exists and is due, the project is installed with an environment,
 * the role's agent is synced, the config is valid) and claims its run in the database, so a second
 * scheduler pass finds it taken. `isDue` is the role's own rule for when it runs.
 */
export const claimStep = async (
  pool: Pool,
  input: {
    readonly taskId: string;
    readonly role: RunnerRole;
    readonly isDue: (context: StoredTaskContext) => boolean | Promise<boolean>;
  }
): Promise<{ ok: true; step: ClaimedStep } | { ok: false; reason: SkipReason }> => {
  const context = await loadTaskContext(pool, input.taskId);
  if (!context) return { ok: false, reason: 'not_found' };
  if (!(await input.isDue(context))) return { ok: false, reason: 'not_due' };
  if (context.installationId === null) return { ok: false, reason: 'not_installed' };
  if (context.environmentId === null) return { ok: false, reason: 'no_environment' };
  const agent = (await loadAgentVersions(pool)).find((record) => record.role === input.role);
  if (!agent) return { ok: false, reason: 'agent_not_synced' };
  const config = parseProjectConfig(context.rawConfig);
  if (!config.ok) return { ok: false, reason: 'invalid_config' };
  const claim = await startRun(pool, {
    taskId: input.taskId,
    stage: context.task.stage,
    role: input.role,
    agentVersion: agent.version,
    runner: RUNNER
  });
  if (!claim.ok) return { ok: false, reason: 'already_running' };
  return {
    ok: true,
    step: {
      context,
      config: config.config,
      agent,
      runId: claim.runId,
      environmentId: context.environmentId,
      repoRef: { installationId: context.installationId, repo: context.repo }
    }
  };
};
