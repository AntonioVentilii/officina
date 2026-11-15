import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

/**
 * How long a claim to decide a learning holds. A claim older than this was left by a process that
 * stopped before it recorded or released it, and the next decision takes it over: every GitHub
 * write an accept makes lands once, so the decision that takes over finishes without repeating it.
 */
const DECISION_LEASE = '10 minutes';

/**
 * Marks a proposed learning as being decided, unless a live claim holds it already, and returns
 * the claim that records or releases the decision. The GitHub calls of an accept run under this
 * claim rather than under a row lock, so no transaction stays open across them.
 */
export const claimLearningDecision = async (
  db: Queryable,
  projectId: string,
  id: string
): Promise<string | null> =>
  (
    await db.query<{ claim: string }>(
      `update learnings
       set decision_claim = gen_random_uuid(), decision_claimed_at = clock_timestamp()
       where project_id = $1 and id = $2 and status = 'proposed'
         and (decision_claim is null or decision_claimed_at < clock_timestamp() - $3::interval)
       returning decision_claim as claim`,
      [projectId, id, DECISION_LEASE]
    )
  ).rows[0]?.claim ?? null;

/**
 * Renews a claim still held, right before a GitHub write, so its lease runs from there. Says
 * whether it is still held: once another decision took it over, this one makes no further write.
 */
export const holdLearningDecision = async (
  db: Queryable,
  id: string,
  claim: string
): Promise<boolean> =>
  ((
    await db.query(
      `update learnings set decision_claimed_at = clock_timestamp()
       where id = $1 and status = 'proposed' and decision_claim = $2`,
      [id, claim]
    )
  ).rowCount ?? 0) === 1;

/** Lets go of a claim that recorded nothing, so the learning can be decided again at once. */
export const releaseLearningDecision = async (db: Queryable, id: string, claim: string) => {
  await db.query(
    `update learnings set decision_claim = null, decision_claimed_at = null
     where id = $1 and decision_claim = $2`,
    [id, claim]
  );
};

/**
 * Records a decision once, under the claim that made it: a learning no longer proposed, or whose
 * claim another decision took over, is left as it is. The time is read as the row is written, after
 * the GitHub calls, so a build that started meanwhile still counts the accept's push as Officina's.
 */
export const decideLearning = async (
  db: Queryable,
  input: {
    id: string;
    claim: string;
    status: 'accepted' | 'rejected';
    memberId: string;
    note: string | null;
    prNumber?: number;
    prUrl?: string;
    /** The commit Officina wrote on the learning's branch, and the one it was written on. */
    branchCommit?: { sha: string; parentSha: string };
  }
): Promise<boolean> =>
  ((
    await db.query(
      `update learnings set status = $2, decided_by = $3, decided_at = clock_timestamp(),
         decision_note = $4, pr_number = $5, pr_url = $6, branch_sha = $7, branch_parent_sha = $8,
         decision_claim = null, decision_claimed_at = null
       where id = $1 and status = 'proposed' and decision_claim = $9`,
      [
        input.id,
        input.status,
        input.memberId,
        input.note,
        input.prNumber ?? null,
        input.prUrl ?? null,
        input.branchCommit?.sha ?? null,
        input.branchCommit?.parentSha ?? null,
        input.claim
      ]
    )
  ).rowCount ?? 0) === 1;

/**
 * Hands a proposed learning whose edit no longer applies back to the learner, ending the accept
 * that found it, under that accept's claim (`claimLearningDecision`). Says whether it did: a claim
 * another decision took over meanwhile changes nothing.
 */
export const requestLearningRewrite = async (
  db: Queryable,
  id: string,
  claim: string
): Promise<boolean> =>
  ((
    await db.query(
      `update learnings set rewrite = 'requested', decision_claim = null, decision_claimed_at = null
       where id = $1 and status = 'proposed' and rewrite is null and decision_claim = $2`,
      [id, claim]
    )
  ).rowCount ?? 0) === 1;
