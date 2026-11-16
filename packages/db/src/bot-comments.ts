import { ENGINE } from '@officina/core';
import type { Pool } from 'pg';
import { SINCE_LAST_BUILD } from './runs';
import { appendTaskEvent } from './task-history';

/** A review bot's comment on a task's pull request, as it read when GitHub last reported it. */
export interface BotComment {
  readonly commentId: number;
  readonly by: string;
  readonly body: string;
}

/**
 * Records a review bot's comment, or its new text after an edit, with when GitHub says it was last
 * edited. Bots often post a placeholder and edit it as they work, so a comment is forwarded only
 * once it stops changing (`unhandledBotComments`).
 */
export const recordBotComment = (
  pool: Pool,
  taskId: string,
  comment: BotComment & { readonly updatedAt: string | null }
) =>
  appendTaskEvent(pool, { taskId, actor: ENGINE, type: 'github_comment_seen', payload: comment });

/**
 * Records that these comments, as they last read, were dealt with: forwarded to the builder, or
 * left out because the builder already answered that bot's last overview.
 */
export const markBotCommentsHandled = async (
  pool: Pool,
  taskId: string,
  commentIds: readonly number[]
) => {
  for (const commentId of commentIds)
    await appendTaskEvent(pool, {
      taskId,
      actor: ENGINE,
      type: 'github_comment_handled',
      payload: { commentId }
    });
};

/**
 * The bot comments of the current build round that have not changed for `quietSeconds` and whose
 * latest text was not dealt with yet (`markBotCommentsHandled`), oldest first, each as it last
 * read: its latest edit by GitHub's `updated_at`, since deliveries can arrive out of order, or the
 * last one recorded when none carries it. With no quiet time, every comment still waiting.
 * A comment from before the builder's last push or answer was about work that is no longer the head.
 */
export const unhandledBotComments = async (
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
         order by payload->>'commentId',
           (payload->>'updatedAt')::timestamptz desc nulls last, id desc
       ) latest
       where latest.created_at <= now() - make_interval(secs => $2)
         and not exists (select 1 from task_events h where h.task_id = $1
           and h.type = 'github_comment_handled' and h.payload->>'commentId' = latest.comment_id
           and h.id > latest.id)
       order by latest.id`,
      [taskId, quietSeconds]
    )
  ).rows.map((row) => ({ commentId: Number(row.comment_id), by: row.by, body: row.body }));
