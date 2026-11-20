import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

/**
 * How long a claim to hand in a build holds since it was last renewed. A claim older than this was
 * left by a process that stopped before it released it, and the next hand-in takes it over: a
 * hand-in is safe to repeat.
 */
export const HAND_IN_LEASE = '10 minutes';

/** Whether task `t` has a hand-in claim still within its lease, the one place that is decided. */
export const HAND_IN_CLAIM_LIVE = `(t.hand_in_claim is not null
  and t.hand_in_claimed_at >= clock_timestamp() - '${HAND_IN_LEASE}'::interval)`;

/**
 * Marks a task's build as being handed in by `memberId`, unless a live claim holds it already, and
 * returns the claim that renews and releases it. The GitHub reads and the pull request run under
 * this claim, so a second hand-in meanwhile is refused instead of racing the first.
 */
export const claimHandIn = async (
  db: Queryable,
  taskId: string,
  memberId: string
): Promise<string | null> =>
  (
    await db.query<{ claim: string }>(
      `update tasks t
       set hand_in_claim = gen_random_uuid(), hand_in_claimed_at = clock_timestamp(),
         hand_in_claimed_by = $2
       where t.id = $1 and not ${HAND_IN_CLAIM_LIVE}
       returning hand_in_claim as claim`,
      [taskId, memberId]
    )
  ).rows[0]?.claim ?? null;

/**
 * Renews a claim still held, right before a GitHub call or the push applied, so its lease runs from
 * there. Says whether it is still held: once another hand-in took it over, this one stops.
 */
export const holdHandIn = async (db: Queryable, taskId: string, claim: string): Promise<boolean> =>
  ((
    await db.query(
      `update tasks set hand_in_claimed_at = clock_timestamp()
       where id = $1 and hand_in_claim = $2`,
      [taskId, claim]
    )
  ).rowCount ?? 0) === 1;

/** Lets go of a hand-in's claim once it ended, however it ended, so the task can be handed in again. */
export const releaseHandIn = async (db: Queryable, taskId: string, claim: string) => {
  await db.query(
    `update tasks set hand_in_claim = null, hand_in_claimed_at = null, hand_in_claimed_by = null
     where id = $1 and hand_in_claim = $2`,
    [taskId, claim]
  );
};

/**
 * Whether a hand-in of the task is under way. Read in the transaction of a person's action on the
 * task, which locks its row, so no action changes the task while a hand-in runs on it.
 */
export const handInUnderWay = async (db: Queryable, taskId: string): Promise<boolean> =>
  ((await db.query(`select 1 from tasks t where t.id = $1 and ${HAND_IN_CLAIM_LIVE}`, [taskId]))
    .rowCount ?? 0) > 0;
