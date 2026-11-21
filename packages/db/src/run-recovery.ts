import { BUILD_ROLES } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { RUN_IS_ACTIVE } from './run-status';

/** A run failed outside its step, with the session the caller interrupts. */
export interface StoppedRun {
  readonly id: string;
  readonly externalId: string | null;
}

/**
 * Fails the runs in progress that `condition` picks (over `runs r`), keeping a result the run
 * already recorded beside `error`, and returns them so the caller can interrupt their sessions.
 */
const failRunsWhere = async (
  db: Pool | PoolClient,
  error: string,
  condition: string,
  params: readonly unknown[] = []
): Promise<StoppedRun[]> =>
  (
    await db.query<{ id: string; external_id: string | null }>(
      `update runs r set status = 'failed', finished_at = now(),
         result = coalesce(r.result, '{}'::jsonb) || jsonb_build_object('error', $1::text)
       where r.status ${RUN_IS_ACTIVE} and ${condition}
       returning r.id, r.external_id`,
      [error, ...params]
    )
  ).rows.map((row) => ({ id: row.id, externalId: row.external_id }));

/**
 * Runs left `running` by a previous engine process can never finish: their stream is gone. They are
 * failed so the step can run again. Assumes a single scheduler instance.
 */
export const failOrphanedRuns = (db: Pool | PoolClient): Promise<StoppedRun[]> =>
  failRunsWhere(db, 'the engine restarted while this run was in progress', 'true');

/**
 * Build runs still in progress on a task a member took over, whatever stage the member's work has
 * reached since (a hand-in moves it on before the next pass): their result no longer applies (the
 * engine's `sameWork`), and their session would only spend. They are failed, like an orphaned run,
 * and the caller interrupts their sessions.
 */
export const failTakenOverRuns = (db: Pool | PoolClient): Promise<StoppedRun[]> =>
  failRunsWhere(
    db,
    'a member took the build over while this run was in progress',
    `r.agent_role = any($2::text[]) and exists (
       select 1 from tasks t where t.id = r.task_id and t.assignee->>'kind' = 'member')`,
    [BUILD_ROLES]
  );

/** The run event a pause records on each run in progress on its task. */
const PAUSED_DURING_RUN = 'officina.task_paused';

/**
 * Marks the task's runs in progress, in the transaction that pauses it: none of them applies its
 * result or its failure any more (`runWasPaused`), even once the task is resumed, and the next
 * scheduler pass fails them and interrupts their sessions (`failPausedRuns`). A learner run only
 * looks back at a finished task, which has no step to hold, so it is left to end.
 */
export const markRunsPaused = async (client: PoolClient, taskId: string) => {
  await client.query(
    `insert into run_events (run_id, type, payload)
     select id, $2, '{}'::jsonb from runs
     where task_id = $1 and status ${RUN_IS_ACTIVE} and agent_role <> 'learner'`,
    [taskId, PAUSED_DURING_RUN]
  );
};

/** Whether the run's task was paused while it was in progress, resumed since or not. */
export const runWasPaused = async (client: PoolClient, runId: string): Promise<boolean> =>
  ((
    await client.query('select 1 from run_events where run_id = $1 and type = $2 limit 1', [
      runId,
      PAUSED_DURING_RUN
    ])
  ).rowCount ?? 0) > 0;

/**
 * Runs still in progress whose task was paused while they were, resumed since or not: their result
 * no longer applies (the engine's `sameWork`), and their session would only spend. They are failed,
 * so the role can be claimed again once the task is resumed, and the caller interrupts their
 * sessions.
 */
export const failPausedRuns = (db: Pool | PoolClient): Promise<StoppedRun[]> =>
  failRunsWhere(
    db,
    'the task was paused while this run was in progress',
    'exists (select 1 from run_events e where e.run_id = r.id and e.type = $2)',
    [PAUSED_DURING_RUN]
  );

/**
 * Runs still in progress long after they started, such as one whose step ended without recording
 * it; a session has a deadline of its own, so a limit well past it finds only those. They are
 * failed, like an orphaned run, so the role can be claimed again, and the caller interrupts their
 * sessions.
 */
export const failStaleRuns = (db: Pool | PoolClient, olderThanMs: number): Promise<StoppedRun[]> =>
  failRunsWhere(
    db,
    'the run was still in progress long past its deadline',
    'coalesce(r.started_at, r.created_at) < now() - make_interval(secs => $2::double precision / 1000)',
    [olderThanMs]
  );

/**
 * Whether a build run is still in progress on the task. A run a member took over stays so until
 * the scheduler's next pass fails it, and `failTakenOverRuns` finds it only while a member holds the
 * task, so a build is handed back only once no such run is left.
 */
export const buildRunInProgress = async (db: Pool | PoolClient, taskId: string): Promise<boolean> =>
  ((
    await db.query(
      `select 1 from runs
       where task_id = $1 and status ${RUN_IS_ACTIVE} and agent_role = any($2::text[])`,
      [taskId, BUILD_ROLES]
    )
  ).rowCount ?? 0) > 0;
