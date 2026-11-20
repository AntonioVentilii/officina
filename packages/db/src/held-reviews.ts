import { ENGINE } from '@officina/core';
import type { Pool } from 'pg';
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
      `select payload from (
         select distinct on (payload->>'reviewId') id, payload from task_events
         where task_id = $1 and type = 'github_review_held'
         order by payload->>'reviewId', id desc
       ) latest
       where not exists (select 1 from task_events h where h.task_id = $1
         and h.type = 'github_review_handled'
         and h.payload->>'reviewId' = latest.payload->>'reviewId' and h.id > latest.id)
       order by latest.id`,
      [taskId]
    )
  ).rows.map((row) => row.payload);

/** Keeps a review refused while its task was held (`github_review_held`), once while it waits. */
export const holdGitHubReview = async (
  pool: Pool,
  taskId: string,
  review: HeldReview
): Promise<void> => {
  const pending = await heldGitHubReviews(pool, taskId);
  if (pending.some((held) => held.reviewId === review.reviewId)) return;
  await appendTaskEvent(pool, {
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
