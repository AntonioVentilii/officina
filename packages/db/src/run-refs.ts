import type { Pool, PoolClient } from 'pg';
import { RUN_IS_ACTIVE } from './run-status';

/** The refs a build run's token could move, as they stood before its session, and since when. */
export interface RunRefs {
  readonly refs: {
    readonly branches: Readonly<Record<string, string>>;
    readonly tags: Readonly<Record<string, string>>;
  };
  readonly since: Date;
}

/** Keeps a build run's starting refs on the run, so they can be checked even if this process dies. */
export const recordRunRefs = async (pool: Pool, runId: string, { refs, since }: RunRefs) => {
  await pool.query('update runs set refs_before = $2, refs_since = $3 where id = $1', [
    runId,
    JSON.stringify(refs),
    since
  ]);
};

/** Records that a build run's refs were checked, so no later start checks them again. */
export const markRefsChecked = async (pool: Pool, runId: string) => {
  await pool.query('update runs set refs_checked_at = now() where id = $1', [runId]);
};

/**
 * The build runs that ended with their starting refs recorded and never checked: the process that
 * ran them stopped, or its check failed, before the check was recorded. Oldest first, with the task
 * and what each recorded.
 */
export const uncheckedRunRefs = async (
  db: Pool | PoolClient
): Promise<(RunRefs & { runId: string; taskId: string; role: string; result: unknown })[]> =>
  (
    await db.query<RunRefs & { runId: string; taskId: string; role: string; result: unknown }>(
      `select id as "runId", task_id as "taskId", agent_role as role, result,
              refs_before as refs, refs_since as since
       from runs
       where refs_before is not null and refs_checked_at is null and not (status ${RUN_IS_ACTIVE})
       order by created_at`
    )
  ).rows;
