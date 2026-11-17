import {
  memberActor,
  type ChecklistCheck,
  type CheckChannel,
  type CheckOutcome,
  type ConnectedApp
} from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './store';
import { appendTaskEvent } from './task-history';

type Queryable = Pool | PoolClient;

/** A check about to be recorded, for the head the checklist was written for. */
export interface CheckInput {
  readonly taskId: string;
  readonly headSha: string;
  readonly item: number;
  readonly outcome: CheckOutcome;
  readonly evidence: string;
  readonly memberId: string;
  readonly channel: CheckChannel;
  /** The connector app that recorded it for the member, kept on the timeline's event. */
  readonly via?: ConnectedApp | undefined;
}

const CHECK_COLUMNS = `item, outcome, evidence, member_id as "memberId", channel, created_at as at`;

/** A recorded check with the name of the person who made it, as people read it. */
export type RecordedCheck = ChecklistCheck & { readonly name: string };

/** Every check of a head's checklist, oldest first, so the last one per item is where it stands. */
export const listChecks = async (
  db: Queryable,
  taskId: string,
  headSha: string
): Promise<RecordedCheck[]> =>
  (
    await db.query<RecordedCheck>(
      `select c.item, c.outcome, c.evidence, c.member_id as "memberId", c.channel,
              c.created_at as at, m.display_name as name
       from checklist_checks c join members m on m.id = c.member_id
       where c.task_id = $1 and c.head_sha = $2 order by c.id`,
      [taskId, headSha]
    )
  ).rows;

/** What recording a check did: added it, found it already the item's latest, or found the task moved on. */
export type CheckRecording = 'recorded' | 'repeat' | 'moved';

/**
 * Records a check and its line on the task's timeline, in one transaction. The task is read again
 * under its row lock: a check lands only while it is still at `verifying` on the head the checks
 * are for, so an approval, a send-back or a new push that won the race leaves it out (`moved`). The
 * same member sending the same finding again (a retried request, a second click) records nothing
 * new (`repeat`): a check is added only when it changes what the item's latest check says.
 */
export const recordCheck = (pool: Pool, input: CheckInput): Promise<CheckRecording> =>
  inTransaction(pool, async (client) => {
    const task = (
      await client.query<{ current: boolean }>(
        `select stage = 'verifying' and head_sha = $2
                and approval_plans->'verifying'->>'subject' = 'sha:' || $2 as current
         from tasks where id = $1 for update`,
        [input.taskId, input.headSha]
      )
    ).rows[0];
    if (!task?.current) return 'moved';
    const latest = (
      await client.query<ChecklistCheck>(
        `select ${CHECK_COLUMNS} from checklist_checks
         where task_id = $1 and head_sha = $2 and item = $3 order by id desc limit 1`,
        [input.taskId, input.headSha, input.item]
      )
    ).rows[0];
    if (
      latest?.memberId === input.memberId &&
      latest.outcome === input.outcome &&
      latest.evidence === input.evidence
    )
      return 'repeat';
    await client.query(
      `insert into checklist_checks (task_id, head_sha, item, outcome, evidence, member_id, channel)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.taskId,
        input.headSha,
        input.item,
        input.outcome,
        input.evidence,
        input.memberId,
        input.channel
      ]
    );
    await appendTaskEvent(client, {
      taskId: input.taskId,
      actor: memberActor(input.memberId, input.via),
      type: 'checklist_checked',
      payload: {
        item: input.item,
        outcome: input.outcome,
        channel: input.channel,
        headSha: input.headSha
      }
    });
    return 'recorded';
  });

/** One person's decision at the verification of one head: approved, or sent back with a note. */
export interface VerifyingDecision {
  readonly memberId: string;
  readonly name: string;
  readonly decision: 'approve' | 'changes';
  readonly note: string | null;
  readonly at: Date;
}

/** The decisions people took at the verification of this subject, oldest first. */
export const listVerifyingDecisions = async (
  db: Queryable,
  taskId: string,
  subject: string
): Promise<VerifyingDecision[]> =>
  (
    await db.query<VerifyingDecision>(
      `select a.member_id as "memberId", m.display_name as name, a.decision, a.note,
              a.created_at as at
       from approvals a join members m on m.id = a.member_id
       where a.task_id = $1 and a.gate = 'verifying' and a.subject = $2
       order by a.created_at, a.id`,
      [taskId, subject]
    )
  ).rows;

/** How long a claim to post the checklist comment holds before another writer may take it over. */
export const CHECKLIST_CLAIM_LEASE = '10 minutes';

/** The checklist comment Officina keeps on a pull request, as it last wrote it. */
export interface ChecklistCommentRow {
  readonly commentId: number | null;
  readonly headSha: string | null;
  /** The current round's part of the body, kept to fold into the earlier rounds on a new head. */
  readonly round: string;
  readonly earlier: string;
  readonly body: string;
}

export const loadChecklistComment = async (
  db: Queryable,
  taskId: string,
  pullRequest: number
): Promise<ChecklistCommentRow | null> =>
  (
    await db.query<ChecklistCommentRow>(
      `select comment_id::float8 as "commentId", head_sha as "headSha", round, earlier, body
       from checklist_comments where task_id = $1 and pull_request = $2`,
      [taskId, pullRequest]
    )
  ).rows[0] ?? null;

/**
 * Claims the first post of a pull request's checklist comment: true for the one writer that may
 * post it. A claim whose writer stopped before recording the comment is taken over after the lease.
 */
export const claimChecklistComment = async (
  db: Queryable,
  taskId: string,
  pullRequest: number
): Promise<boolean> =>
  ((
    await db.query(
      `insert into checklist_comments (task_id, pull_request) values ($1, $2)
       on conflict (task_id, pull_request) do update set claimed_at = now()
       where checklist_comments.comment_id is null
         and checklist_comments.claimed_at < now() - $3::interval`,
      [taskId, pullRequest, CHECKLIST_CLAIM_LEASE]
    )
  ).rowCount ?? 0) > 0;

/** What was written to the comment, so the next pass edits it only when its text would change. */
export const saveChecklistComment = async (
  db: Queryable,
  input: {
    readonly taskId: string;
    readonly pullRequest: number;
    readonly commentId: number;
    readonly headSha: string;
    readonly round: string;
    readonly earlier: string;
    readonly body: string;
  }
) => {
  await db.query(
    `update checklist_comments
     set comment_id = $3, head_sha = $4, round = $5, earlier = $6, body = $7
     where task_id = $1 and pull_request = $2`,
    [
      input.taskId,
      input.pullRequest,
      input.commentId,
      input.headSha,
      input.round,
      input.earlier,
      input.body
    ]
  );
};
