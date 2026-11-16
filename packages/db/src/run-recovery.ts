import { BUILD_ROLES } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { RUN_IS_ACTIVE } from './run-status';

/**
 * Runs left `running` by a previous engine process can never finish: their stream is gone. They are
 * failed so the step can run again; a result the run already recorded is kept beside the error.
 * Assumes a single scheduler instance.
 */
export const failOrphanedRuns = async (
  db: Pool | PoolClient
): Promise<{ id: string; externalId: string | null }[]> =>
  (
    await db.query<{ id: string; external_id: string | null }>(
      `update runs set status = 'failed', finished_at = now(),
         result = coalesce(result, '{}'::jsonb)
           || '{"error": "the engine restarted while this run was in progress"}'::jsonb
       where status ${RUN_IS_ACTIVE} returning id, external_id`
    )
  ).rows.map((row) => ({ id: row.id, externalId: row.external_id }));

/**
 * Build runs still in progress on a task a member is claiming, failed in the claim's transaction:
 * nothing they end with may apply any more (the engine's `sameWork`), even once the build goes back
 * to the agent before the scheduler's next pass. The engine stops their sessions (`stopEnded` of
 * its live runs).
 */
export const failTakenOverRuns = async (client: PoolClient, taskId: string): Promise<void> => {
  await client.query(
    `update runs set status = 'failed', finished_at = now(),
       result = coalesce(result, '{}'::jsonb)
         || '{"error": "a member took the build over while this run was in progress"}'::jsonb
     where task_id = $1 and status ${RUN_IS_ACTIVE} and agent_role = any($2::text[])`,
    [taskId, BUILD_ROLES]
  );
};

/**
 * Runs still in progress long after they started, such as one whose step ended without recording
 * it; a session has a deadline of its own, so a limit well past it finds only those. They are
 * failed, like an orphaned run, so the role can be claimed again, and the caller interrupts their
 * sessions.
 */
export const failStaleRuns = async (
  db: Pool | PoolClient,
  olderThanMs: number
): Promise<{ id: string; externalId: string | null }[]> =>
  (
    await db.query<{ id: string; external_id: string | null }>(
      `update runs set status = 'failed', finished_at = now(),
         result = coalesce(result, '{}'::jsonb)
           || '{"error": "the run was still in progress long past its deadline"}'::jsonb
       where status ${RUN_IS_ACTIVE}
         and coalesce(started_at, created_at) < now() - make_interval(secs => $1::double precision / 1000)
       returning id, external_id`,
      [olderThanMs]
    )
  ).rows.map((row) => ({ id: row.id, externalId: row.external_id }));
