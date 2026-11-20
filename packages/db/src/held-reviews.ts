import { ENGINE } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { appendTaskEvent } from './task-history';

/**
 * A review on GitHub that counts, refused because its task was blocked or paused, kept to be sent
 * on once the hold clears. `headSha` is the head it is about in the task's terms (`reviewedHead`).
 */
interface HeldReview {
  readonly reviewId: number;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly by: string;
  readonly notes: string;
  readonly overviewOnly: boolean;
}

/**
 * The reviews kept while the task was held and not dealt with yet (`markHeldReviewHandled`),
 * oldest first. Not limited to the current build round: the lifecycle's head check judges whether
 * a review still applies.
 */
export const heldGitHubReviews = async (pool: Pool, taskId: string): Promise<HeldReview[]> =>
  (
    await pool.query<{ payload: HeldReview }>(
      `select payload from task_events e
       where task_id = $1 and type = 'github_review_held'
         and not exists (select 1 from task_events h where h.task_id = $1
           and h.type = 'github_review_handled'
           and h.payload->>'reviewId' = e.payload->>'reviewId')
       order by id`,
      [taskId]
    )
  ).rows.map((row) => row.payload);

/**
 * Keeps a review refused while its task was held (`github_review_held`). It takes the client of
 * the transaction that refused it, which holds the task's row lock: an answer or a resume cannot
 * clear the hold in between,
 * so the scheduler never finds the task free with the review not yet kept. A review is kept once
 * per task, whatever came of it since, so a repeated delivery during a later hold is not sent again.
 */
export const holdGitHubReview = async (
  client: PoolClient,
  taskId: string,
  review: HeldReview
): Promise<void> => {
  const kept = await client.query(
    `select 1 from task_events
     where task_id = $1 and type = 'github_review_held' and payload @> $2::jsonb`,
    [taskId, JSON.stringify({ reviewId: review.reviewId })]
  );
  if (kept.rowCount) return;
  await appendTaskEvent(client, {
    taskId,
    actor: ENGINE,
    type: 'github_review_held',
    payload: review
  });
};

/**
 * Records that a held review was dealt with (`github_review_handled`): `outcome` is `forwarded`,
 * or why it no longer applied, so it is never sent again.
 */
export const markHeldReviewHandled = async (
  pool: Pool,
  taskId: string,
  handled: { readonly reviewId: number; readonly by: string; readonly outcome: string }
): Promise<void> => {
  await appendTaskEvent(pool, {
    taskId,
    actor: ENGINE,
    type: 'github_review_handled',
    payload: handled
  });
};
