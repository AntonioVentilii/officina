import type { Actor, Command } from '@officina/core';
import { applyCommand, findTasksByPullRequest } from '@officina/db';
import type { WebhookAction } from '@officina/github';
import type { Pool } from 'pg';

export interface TaskOutcome {
  readonly taskId: string;
  readonly ok: boolean;
  readonly error?: string;
}

const ENGINE: Actor = { kind: 'engine' };

/**
 * Applies a GitHub fact to every task linked to the pull request. A rejection such as `wrong_stage`
 * (CI failing while a task is still in review) is an expected outcome, reported rather than raised.
 */
export const handleWebhookAction = async (
  pool: Pool,
  action: WebhookAction
): Promise<TaskOutcome[]> => {
  const targets: { prNumber: number; command: Command }[] =
    action.kind === 'pull_request_merged'
      ? [{ prNumber: action.prNumber, command: { type: 'merged' } }]
      : action.prNumbers.map((prNumber) => ({
          prNumber,
          command: { type: 'ci_failed', details: action.details }
        }));

  const outcomes: TaskOutcome[] = [];
  for (const { prNumber, command } of targets) {
    for (const taskId of await findTasksByPullRequest(pool, action.repo, prNumber)) {
      const result = await applyCommand(pool, { taskId, command, actor: ENGINE });
      outcomes.push(result.ok ? { taskId, ok: true } : { taskId, ok: false, error: result.error });
    }
  }
  return outcomes;
};
