import type { LearningDecision, LearningTarget } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { DUPLICATE_OF, sameEditAs } from './learning-pull-requests';
import { inTransaction } from './store';

type Queryable = Pool | PoolClient;

/** Who claimed a learning's decision, and which decision it is, so open boards can show it. */
export interface Decider {
  readonly memberId: string;
  readonly decision: LearningDecision;
}

/** The columns a claim sets, cleared together whenever it ends. */
const CLAIM_CLEARED = `decision_claim = null, decision_claimed_at = null,
  decision_claimed_by = null, decision_claimed_for = null`;

/**
 * How long a claim to decide a learning holds. A claim older than this was left by a process that
 * stopped before it recorded or released it, and the next decision takes it over: every GitHub
 * write an accept makes lands once, so the decision that takes over finishes without repeating it.
 */
export const DECISION_LEASE = '10 minutes';

/**
 * Marks a proposed learning as being decided by `decider`, unless a live claim holds it already,
 * and returns the claim that records or releases the decision. The GitHub calls of an accept run
 * under this claim rather than under a row lock, so no transaction stays open across them.
 */
export const claimLearningDecision = async (
  db: Queryable,
  projectId: string,
  id: string,
  decider: Decider
): Promise<string | null> =>
  (
    await db.query<{ claim: string }>(
      `update learnings
       set decision_claim = gen_random_uuid(), decision_claimed_at = clock_timestamp(),
         decision_claimed_by = $4, decision_claimed_for = $5
       where project_id = $1 and id = $2 and status = 'proposed'
         and (decision_claim is null or decision_claimed_at < clock_timestamp() - $3::interval)
       returning decision_claim as claim`,
      [projectId, id, DECISION_LEASE, decider.memberId, decider.decision]
    )
  ).rows[0]?.claim ?? null;

/** Whether learning `l` has a claim still within its lease, the one place that is decided. */
export const DECISION_CLAIM_LIVE = `(l.decision_claim is not null
  and l.decision_claimed_at >= clock_timestamp() - '${DECISION_LEASE}'::interval)`;

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

/**
 * What came of marking an accept: marked, marked over the mark of an earlier accept the catch-up
 * has not read yet, its claim taken over by another decision, or refused because another learning
 * with the same edit is accepted with its pull request or being accepted.
 */
export type AcceptMark = 'marked' | 'remarked' | 'taken_over' | 'repeated';

/**
 * Marks a learning with a new accept attempt, and who made it, under the claim of that accept, once
 * it passed every check and right before its pull request is opened: a pull request it opens without
 * recording is found afterwards (`listAcceptsToCheck`), and an accept refused before then leaves no
 * mark. Refused while another copy of the edit is accepted with its pull request open or merged, or
 * is marked and still proposed (its accept is opening its pull request, or left one the catch-up has
 * not read yet), so two copies accepted at once never open two identical pull requests. Every copy
 * is locked first, in one order, so two such accepts take turns and the second sees the first mark.
 * Says when it replaced an earlier mark of this learning: that accept may have left its pull request
 * on the branch of the edit, so this one must not move the edit to another branch.
 */
export const markAcceptAttempt = (
  pool: Pool,
  input: { id: string; claim: string; memberId: string }
): Promise<AcceptMark> =>
  inTransaction(pool, async (client): Promise<AcceptMark> => {
    await client.query(
      `select d.id from learnings l join learnings d on ${sameEditAs('d')}
       where l.id = $1 order by d.id for update of d`,
      [input.id]
    );
    const copy = (
      await client.query<{ held: boolean; remarked: boolean; repeated: boolean }>(
        `select l.decision_claim = $2 as held, l.accept_attempt is not null as remarked,
           (${DUPLICATE_OF}) is not null or exists (
           select 1 from learnings d where ${sameEditAs('d')} and d.id <> l.id
             and d.status = 'proposed' and d.accept_attempt is not null) as repeated
         from learnings l where l.id = $1 and l.status = 'proposed'`,
        [input.id, input.claim]
      )
    ).rows[0];
    if (!copy?.held) return 'taken_over';
    if (copy.repeated) return 'repeated';
    await client.query(
      `update learnings set accept_attempt = gen_random_uuid(), accept_attempted_by = $2
       where id = $1`,
      [input.id, input.memberId]
    );
    return copy.remarked ? 'remarked' : 'marked';
  });

/** Lets go of a claim that recorded nothing, so the learning can be decided again at once. */
export const releaseLearningDecision = async (db: Queryable, id: string, claim: string) => {
  await db.query(
    `update learnings set ${CLAIM_CLEARED}
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
         ${CLAIM_CLEARED}
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
      `update learnings set rewrite = 'requested', ${CLAIM_CLEARED}
       where id = $1 and status = 'proposed' and rewrite is null and decision_claim = $2`,
      [id, claim]
    )
  ).rowCount ?? 0) === 1;

/** A proposed learning an accept marked, to look for the pull request that accept may have left. */
export interface AcceptToCheck {
  readonly id: string;
  readonly target: LearningTarget;
  readonly rewrittenAt: Date | null;
  /** The `accept_attempt` read, so only that attempt is recorded or cleared. */
  readonly attempt: string;
  readonly repo: string;
  readonly installationId: number;
  readonly defaultBranch: string;
}

/**
 * The proposed learnings of a project an accept marked and no decision holds now, in a project with
 * the GitHub App installed: an accept that opened its pull request and then lost its record left
 * one of them proposed with that pull request open.
 */
export const listAcceptsToCheck = async (
  db: Queryable,
  projectId: string
): Promise<AcceptToCheck[]> =>
  (
    await db.query<Omit<AcceptToCheck, 'installationId'> & { installationId: string }>(
      `select l.id, l.target, l.rewritten_at as "rewrittenAt", l.accept_attempt as attempt,
         p.github_repo as repo, p.github_installation_id::text as "installationId",
         p.default_branch as "defaultBranch"
       from learnings l join projects p on p.id = l.project_id
       where l.project_id = $1 and l.status = 'proposed' and l.accept_attempt is not null
         and not ${DECISION_CLAIM_LIVE} and p.github_installation_id is not null
       order by l.created_at`,
      [projectId]
    )
  ).rows.map((row) => ({ ...row, installationId: Number(row.installationId) }));

/**
 * Records, by whoever tried the accept, a learning whose accept opened its pull request and lost its
 * record: accepted while that pull request is open, applied once it merged. Only the attempt that
 * was checked, while no decision holds the learning, so an accept or a reject made meanwhile is
 * never overwritten. An open one whose edit another learning has since got accepted with its own
 * pull request is not recorded: the learning stays a duplicate, and rejecting it closes the pull
 * request it left. A merged one landed whatever else was accepted, so it is recorded as it is.
 * Says whether it recorded. The commit on the branch is unknown, so none is recorded.
 */
export const recordLeftAccept = async (
  db: Queryable,
  input: {
    id: string;
    attempt: string;
    status: 'accepted' | 'applied';
    prNumber: number;
    prUrl: string;
  }
): Promise<boolean> =>
  ((
    await db.query(
      `update learnings l set status = $3::text, decided_by = l.accept_attempted_by,
         decided_at = clock_timestamp(), pr_number = $4, pr_url = $5, ${CLAIM_CLEARED}
       where l.id = $1 and l.status = 'proposed' and l.accept_attempt = $2
         and not ${DECISION_CLAIM_LIVE} and ($3::text = 'applied' or (${DUPLICATE_OF}) is null)`,
      [input.id, input.attempt, input.status, input.prNumber, input.prUrl]
    )
  ).rowCount ?? 0) === 1;

/**
 * Clears the mark of an accept that left no pull request to record, so the learning is not looked
 * at again.
 * Only that attempt: one a newer accept made meanwhile stays for the next check.
 */
export const clearAcceptAttempt = async (db: Queryable, id: string, attempt: string) => {
  await db.query(
    `update learnings l set accept_attempt = null, accept_attempted_by = null
     where l.id = $1 and l.accept_attempt = $2 and l.status = 'proposed'
       and not ${DECISION_CLAIM_LIVE}`,
    [id, attempt]
  );
};
