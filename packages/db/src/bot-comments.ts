import { ENGINE } from '@officina/core';
import type { Pool } from 'pg';
import { SINCE_LAST_BUILD, appendTaskEvent } from './runs';

/** A review bot's comment on a task's pull request, as it read when GitHub last reported it. */
export interface BotComment {
  readonly commentId: number;
  readonly by: string;
  readonly body: string;
}

/**
 * Records a review bot's comment, or its new text after an edit. Bots often post a placeholder and
 * edit it as they work, so a comment is forwarded only once it stops changing (`settledBotComments`).
 */
export const recordBotComment = (pool: Pool, taskId: string, comment: BotComment) =>
  appendTaskEvent(pool, { taskId, actor: ENGINE, type: 'github_comment_seen', payload: comment });

/**
 * The bot comments of the current build round that have not changed for `quietSeconds` and whose
 * latest text has not been forwarded yet, oldest first, each as it last read. A comment from before
 * the builder's last push or answer was about work that is no longer the head.
 */
export const settledBotComments = async (
  pool: Pool,
  taskId: string,
  quietSeconds: number
): Promise<BotComment[]> =>
  (
    await pool.query<{ comment_id: string; by: string; body: string }>(
      `select comment_id, by, body from (
         select distinct on (payload->>'commentId') id, created_at,
           payload->>'commentId' as comment_id, payload->>'by' as by, payload->>'body' as body
         from task_events
         where task_id = $1 and type = 'github_comment_seen' and ${SINCE_LAST_BUILD}
         order by payload->>'commentId', id desc
       ) latest
       where latest.created_at <= now() - make_interval(secs => $2)
         and not exists (select 1 from task_events f where f.task_id = $1
           and f.type = 'review_recorded' and f.payload->>'githubCommentId' = latest.comment_id
           and f.id > latest.id)
       order by latest.id`,
      [taskId, quietSeconds]
    )
  ).rows.map((row) => ({ commentId: Number(row.comment_id), by: row.by, body: row.body }));
