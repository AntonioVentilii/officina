import type { Pool, PoolClient } from 'pg';

/**
 * Claims a webhook delivery before it is processed. Only one of two concurrent deliveries with the
 * same id gets `true`, so a redelivery racing the original is never applied twice. A claim still
 * unhandled after `STALE_CLAIM` belonged to a process that died while handling it, and is taken again.
 */
export const claimDelivery = async (
  pool: Pool,
  deliveryId: string,
  event: string
): Promise<boolean> =>
  (
    await pool.query(
      `insert into webhook_deliveries (id, event) values ($1, $2)
       on conflict (id) do update set received_at = now()
         where webhook_deliveries.handled_at is null
           and webhook_deliveries.received_at < now() - $3::interval
       returning id`,
      [deliveryId, event, STALE_CLAIM]
    )
  ).rowCount === 1;

/** Far longer than any handler runs: a webhook is answered in seconds. */
const STALE_CLAIM = '10 minutes';

/** Marks a claimed delivery as handled, so no redelivery processes it again. */
export const markDeliveryHandled = async (pool: Pool, deliveryId: string): Promise<void> => {
  await pool.query('update webhook_deliveries set handled_at = now() where id = $1', [deliveryId]);
};

/** Gives a claimed delivery back after it failed, so GitHub's redelivery is processed. */
export const releaseDelivery = async (pool: Pool, deliveryId: string): Promise<void> => {
  await pool.query('delete from webhook_deliveries where id = $1', [deliveryId]);
};

export const linkPullRequest = async (
  pool: Pool,
  taskId: string,
  prNumber: number
): Promise<void> => {
  await pool.query('update tasks set github_pr = $2, updated_at = now() where id = $1', [
    taskId,
    prNumber
  ]);
};

/** Forgets a task's pull request, so the next push opens a new one. */
export const unlinkPullRequest = async (db: Pool | PoolClient, taskId: string): Promise<void> => {
  await db.query('update tasks set github_pr = null, updated_at = now() where id = $1', [taskId]);
};

export const findTasksByPullRequest = async (
  pool: Pool,
  repo: string,
  prNumber: number
): Promise<string[]> =>
  (
    await pool.query<{ id: string }>(
      `select t.id from tasks t join projects p on p.id = t.project_id
       where lower(p.github_repo) = lower($1) and t.github_pr = $2`,
      [repo, prNumber]
    )
  ).rows.map((row) => row.id);
