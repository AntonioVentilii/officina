import type { ClientBase, Pool } from 'pg';

/** Far longer than a lock wait takes to start, so only a wait that never came reaches it. */
const DEADLINE_MS = 10_000;

/** The server process of a connection, to name it as the one holding a lock. */
export const backendPid = async (client: ClientBase): Promise<number> =>
  (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;

/** Whether some connection waits on a lock the connection with server process `holder` holds. */
const waitsOnALock = async (db: Pool | ClientBase, holder: number): Promise<boolean> =>
  ((
    await db.query('select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [holder])
  ).rowCount ?? 0) > 0;

/**
 * Waits until another connection waits on a lock `holder` holds, as a race under test needs before
 * the holder lets go. `finished` ends the wait early for an operation that may not need the lock.
 */
export const untilWaitingOn = async (
  db: Pool | ClientBase,
  holder: number,
  finished: () => boolean = () => false
): Promise<void> => {
  const deadline = Date.now() + DEADLINE_MS;
  while (!finished() && !(await waitsOnALock(db, holder))) {
    if (Date.now() > deadline) throw new Error(`nothing waited on a lock of process ${holder}`);
    await Bun.sleep(5);
  }
};
