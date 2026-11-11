import { buildRoleFor, nextAgentRoles, parseProjectConfig, type Actor } from '@officina/core';
import {
  applyCommand,
  countOpenAgentWork,
  listActiveTaskIds,
  listTasksAwaitingLearning,
  loadTaskContext
} from '@officina/db';
import { RUNNER_ROLES, type RunnerRole } from '@officina/runner';
import { runAgentStep, type EngineDependencies, type StepResult } from './step';

const ENGINE: Actor = { kind: 'engine' };

export interface DueStep {
  readonly taskId: string;
  readonly role: RunnerRole;
}

export interface TickReport {
  readonly dispatched: readonly string[];
  readonly steps: readonly (DueStep & {
    readonly result: StepResult | { readonly status: 'error'; readonly message: string };
  })[];
}

const isRunnerRole = (role: string): role is RunnerRole =>
  (RUNNER_ROLES as readonly string[]).includes(role);

/**
 * Hands ready tasks to the builder agent within lane limits and lists every agent step now due.
 * Starting the steps is left to the caller, so a scheduler can run long sessions without blocking.
 */
export const collectDueSteps = async (
  deps: Pick<EngineDependencies, 'pool'>,
  projectId: string
): Promise<{ dispatched: string[]; due: DueStep[] }> => {
  const dispatched: string[] = [];
  const due: DueStep[] = [];
  const dueFor = (taskId: string, roles: readonly string[]) =>
    due.push(...roles.filter(isRunnerRole).map((role) => ({ taskId, role })));

  for (const taskId of await listActiveTaskIds(deps.pool, projectId)) {
    const context = await loadTaskContext(deps.pool, taskId);
    if (!context) continue;
    const { task } = context;

    if (task.stage === 'ready' && task.lane && !task.blocked && !task.paused) {
      const config = parseProjectConfig(context.rawConfig);
      if (config.ok && config.config.lanes[task.lane].agentsBuild) {
        const result = await applyCommand(deps.pool, {
          taskId,
          command: {
            type: 'dispatch',
            assignee: { kind: 'agent', role: buildRoleFor(task.kind) },
            openInLane: await countOpenAgentWork(deps.pool, projectId, task.lane)
          },
          actor: ENGINE
        });
        if (result.ok) {
          dispatched.push(taskId);
          dueFor(taskId, nextAgentRoles(result.task));
        }
      }
      continue;
    }

    dueFor(taskId, nextAgentRoles(task));
  }
  for (const taskId of await listTasksAwaitingLearning(deps.pool, projectId)) {
    due.push({ taskId, role: 'learner' });
  }
  return { dispatched, due };
};

/**
 * One complete pass over a project: collects due steps and runs them all to completion. Concurrent
 * passes are safe because runs are claimed in the database.
 */
export const tick = async (deps: EngineDependencies, projectId: string): Promise<TickReport> => {
  const { dispatched, due } = await collectDueSteps(deps, projectId);
  const settled = await Promise.allSettled(
    due.map(({ taskId, role }) => runAgentStep(deps, taskId, role))
  );
  return {
    dispatched,
    steps: settled.map((outcome, index) => ({
      ...due[index]!,
      result:
        outcome.status === 'fulfilled'
          ? outcome.value
          : { status: 'error' as const, message: (outcome.reason as Error).message }
    }))
  };
};
