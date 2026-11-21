import {
  buildRoleFor,
  ENGINE,
  humanBuildReason,
  nextAgentRoles,
  parentCloses,
  parseProjectConfig
} from '@officina/core';
import {
  applyCommand,
  buildLinksOf,
  countOpenAgentWork,
  listActiveTaskIds,
  listOpenParents,
  listTasksAwaitingLearning,
  listTasksAwaitingRewrite,
  loadTaskContext
} from '@officina/db';
import { isRunnerRole, type RunnerRole } from '@officina/runner';
import type { Pool } from 'pg';
import { heldForSpend } from './spend';
import { runAgentStep, type EngineDependencies, type StepResult } from './step';

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

/**
 * Closes every open parent whose sub-tasks are all closed with at least one merged
 * (`parentCloses`), read again under the parent's lock. One that no longer closes is skipped, as
 * a refused dispatch is.
 */
const closeMergedParents = async (pool: Pool, projectId: string) => {
  for (const parent of await listOpenParents(pool, projectId)) {
    if (!parentCloses(parent.subtasks)) continue;
    const merged = parent.subtasks.filter((task) => task.stage === 'done');
    await applyCommand(pool, {
      taskId: parent.id,
      command: { type: 'close_parent', subtasks: merged.map((task) => task.number) },
      actor: ENGINE,
      guard: async (_task, client) => parentCloses((await buildLinksOf(client, parent.id)).subtasks)
    });
  }
};

/**
 * Closes parents whose sub-tasks have merged, then hands ready tasks to the builder agent within
 * lane limits and lists every agent step now due. Starting the steps is left to the caller, so a
 * scheduler can run long sessions without blocking.
 */
export const collectDueSteps = async (
  deps: Pick<EngineDependencies, 'pool'>,
  projectId: string
): Promise<{ dispatched: string[]; due: DueStep[] }> => {
  const dispatched: string[] = [];
  const due: DueStep[] = [];
  const dueFor = (taskId: string, roles: readonly string[]) =>
    due.push(...roles.filter(isRunnerRole).map((role) => ({ taskId, role })));

  await closeMergedParents(deps.pool, projectId);

  for (const taskId of await listActiveTaskIds(deps.pool, projectId)) {
    const context = await loadTaskContext(deps.pool, taskId);
    if (!context) continue;
    const { task } = context;

    if (task.stage === 'ready' && task.lane && !task.blocked && !task.paused) {
      const config = parseProjectConfig(context.rawConfig);
      // A task a person must build waits for a maintainer to claim it.
      if (config.ok && humanBuildReason(config.config, task) === null) {
        if (await heldForSpend(deps.pool, taskId)) continue;
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

    const roles = nextAgentRoles(task);
    // A task whose runs spent its budget starts none until a maintainer lets them go on.
    if (roles.length > 0 && (await heldForSpend(deps.pool, taskId))) continue;
    dueFor(taskId, roles);
  }
  const learning = new Set([
    ...(await listTasksAwaitingLearning(deps.pool, projectId)),
    ...(await listTasksAwaitingRewrite(deps.pool, projectId))
  ]);
  for (const taskId of learning) due.push({ taskId, role: 'learner' });
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
