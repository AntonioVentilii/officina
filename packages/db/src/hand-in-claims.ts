import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

/**
 * How long a claim to hand in a build holds. A claim older than this was left by a process that
 * stopped before it released it, and the next hand-in takes it over: a hand-in is safe to repeat.
 */
export const HAND_IN_LEASE = '10 minutes';

/**
 * Marks a task's build as being handed in by `memberId`, unless a live claim holds it already, and
 * returns the claim that releases it. The GitHub reads and the pull request run under this claim,
 * so a second hand-in meanwhile is refused instead of racing the first.
 */
export const claimHandIn = async (
  db: Queryable,
  taskId: string,
  memberId: string
): Promise<string | null> =>
  (
    await db.query<{ claim: string }>(
      `update tasks
       set hand_in_claim = gen_random_uuid(), hand_in_claimed_at = clock_timestamp(),
         hand_in_claimed_by = $3
       where id = $1
         and (hand_in_claim is null or hand_in_claimed_at < clock_timestamp() - $2::interval)
       returning hand_in_claim as claim`,
      [taskId, HAND_IN_LEASE, memberId]
    )
  ).rows[0]?.claim ?? null;

/** Lets go of a hand-in's claim once it ended, however it ended, so the task can be handed in again. */
export const releaseHandIn = async (db: Queryable, taskId: string, claim: string) => {
  await db.query(
    `update tasks set hand_in_claim = null, hand_in_claimed_at = null, hand_in_claimed_by = null
     where id = $1 and hand_in_claim = $2`,
    [taskId, claim]
  );
};

/** Whether task `t` has a hand-in claim still within its lease, the one place that is decided. */
export const HAND_IN_CLAIM_LIVE = `(t.hand_in_claim is not null
  and t.hand_in_claimed_at >= clock_timestamp() - '${HAND_IN_LEASE}'::interval)`;
