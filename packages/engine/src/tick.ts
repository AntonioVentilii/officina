import { nextAgentRoles, parseProjectConfig, type Actor } from '@officina/core';
import { applyCommand, countOpenAgentWork, listActiveTaskIds, loadTaskContext } from '@officina/db';
import { RUNNER_ROLES, type RunnerRole } from '@officina/runner';
import { runAgentStep, type EngineDependencies, type StepResult } from './step';

const ENGINE: Actor = { kind: 'engine' };

export interface TickReport {
  readonly dispatched: readonly string[];
  readonly steps: readonly {
    taskId: string;
    role: RunnerRole;
    result: StepResult | { status: 'error'; message: string };
  }[];
}

const isRunnerRole = (role: string): role is RunnerRole =>
  (RUNNER_ROLES as readonly string[]).includes(role);

/**
 * One scheduling pass over a project: hands ready tasks to the builder agent within lane limits,
 * then runs every agent step that is due. Concurrent passes are safe: runs are claimed in the database.
 */
export const tick = async (deps: EngineDependencies, projectId: string): Promise<TickReport> => {
  const dispatched: string[] = [];
  const due: { taskId: string; role: RunnerRole }[] = [];

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
            assignee: { kind: 'agent', role: 'builder' },
            openInLane: await countOpenAgentWork(deps.pool, projectId, task.lane)
          },
          actor: ENGINE
        });
        if (result.ok) {
          dispatched.push(taskId);
          due.push(
            ...nextAgentRoles(result.task)
              .filter(isRunnerRole)
              .map((role) => ({ taskId, role }))
          );
        }
      }
      continue;
    }

    due.push(
      ...nextAgentRoles(task)
        .filter(isRunnerRole)
        .map((role) => ({ taskId, role }))
    );
  }

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
