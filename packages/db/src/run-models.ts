import type { Pool } from 'pg';

/** The model a run's session runs at, its effort and why the engine chose them. */
export interface RunModel {
  readonly model: string;
  readonly effort: string;
  readonly reason: string;
}

/** Records the model a run's session runs at, before the session starts. */
export const recordRunModel = async (pool: Pool, runId: string, choice: RunModel) => {
  await pool.query('update runs set model = $2, effort = $3, model_reason = $4 where id = $1', [
    runId,
    choice.model,
    choice.effort,
    choice.reason
  ]);
};

/**
 * Earlier runs of a role on a task that left nothing usable: a result the contract kept refusing,
 * a session that stopped without one, or a result saying the agent failed. A session's own error
 * (the spend limit, a closed stream) says nothing about the model, so it does not count.
 */
export const failedAttempts = async (db: Pool, taskId: string, role: string): Promise<number> =>
  (
    await db.query<{ count: number }>(
      `select count(*)::int as count from runs
       where task_id = $1 and agent_role = $2 and status <> 'running'
         and (result->>'kind' in ('invalid_result', 'no_result') or result->>'outcome' = 'failed')`,
      [taskId, role]
    )
  ).rows[0]!.count;
