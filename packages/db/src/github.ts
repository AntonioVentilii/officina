import type { Pool } from 'pg';

export const hasDelivery = async (pool: Pool, deliveryId: string): Promise<boolean> =>
  ((await pool.query('select 1 from webhook_deliveries where id = $1', [deliveryId])).rowCount ??
    0) > 0;

export const recordDelivery = async (
  pool: Pool,
  deliveryId: string,
  event: string
): Promise<void> => {
  await pool.query(
    'insert into webhook_deliveries (id, event) values ($1, $2) on conflict (id) do nothing',
    [deliveryId, event]
  );
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
