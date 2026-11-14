import type { Pool } from 'pg';

/*
 * The demo workshop's writes that no real flow makes: `bun run dev` seeds a throwaway local
 * database with them, so the board shows plausible times. Nothing else may call these.
 */

/** Empties a throwaway database, so the migrations and the demo seed start from nothing. */
export const resetDemoSchema = async (pool: Pool): Promise<void> => {
  await pool.query('drop schema public cascade; create schema public;');
};

/** A demo run that started six minutes ago in a session of its own. */
export const backdateDemoRunStart = async (
  pool: Pool,
  runId: string,
  externalId: string
): Promise<void> => {
  await pool.query(
    "update runs set external_id = $2, started_at = now() - interval '6 minutes' where id = $1",
    [runId, externalId]
  );
};

/** A finished demo run that took a little over four minutes. */
export const setDemoRunDuration = async (pool: Pool, runId: string): Promise<void> => {
  await pool.query(
    "update runs set finished_at = started_at + interval '4 minutes 12 seconds' where id = $1",
    [runId]
  );
};

/**
 * Spreads each task's history over the last days, keeping its order and ending before now. The
 * audit tables refuse updates, so this throwaway database skips their triggers for the rewrite.
 */
export const spreadDemoHistory = async (pool: Pool): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(`
      update tasks set created_at = now() - interval '10 hours' - random() * interval '4 days'`);
    await client.query(`
      with ordered as (
        select e.id, t.created_at
          + row_number() over (partition by e.task_id order by e.id) * interval '23 minutes' as at
        from task_events e join tasks t on t.id = e.task_id
      )
      update task_events e set created_at = o.at from ordered o where o.id = e.id`);
    await client.query(`
      update comments c set created_at = t.created_at from tasks t where t.id = c.task_id`);
    await client.query(`
      update spec_versions s set created_at = t.created_at + interval '40 minutes'
      from tasks t where t.id = s.task_id`);
    await client.query(`
      update runs r set
        created_at = t.created_at + interval '30 minutes',
        started_at = case when r.status = 'running' then now() - interval '6 minutes'
                          else t.created_at + interval '30 minutes' end,
        finished_at = case when r.status = 'running' then null
                           else t.created_at + interval '34 minutes 12 seconds' end
      from tasks t where t.id = r.task_id`);
  } finally {
    await client.query('reset session_replication_role');
    client.release();
  }
};

/** The demo runs still in progress, which the simulated agents keep busy. */
export const listRunningDemoRuns = async (pool: Pool): Promise<string[]> =>
  (await pool.query<{ id: string }>("select id from runs where status = 'running'")).rows.map(
    (row) => row.id
  );
