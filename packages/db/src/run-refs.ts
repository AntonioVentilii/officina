import type { Pool, PoolClient } from 'pg';

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

/** Of these runs, those that recorded their starting refs, with the task and what they recorded. */
export const runsWithRefs = async (
  db: Pool | PoolClient,
  runIds: readonly string[]
): Promise<(RunRefs & { runId: string; taskId: string; role: string; result: unknown })[]> =>
  (
    await db.query<RunRefs & { runId: string; taskId: string; role: string; result: unknown }>(
      `select id as "runId", task_id as "taskId", agent_role as role, result,
              refs_before as refs, refs_since as since
       from runs where id = any($1::uuid[]) and refs_before is not null order by created_at`,
      [runIds]
    )
  ).rows;
