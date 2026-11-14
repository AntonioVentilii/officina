import type { Pool, PoolClient } from 'pg';

/**
 * Claims a webhook delivery before it is processed. Only one of two concurrent deliveries with the
 * same id gets `true`, so a redelivery racing the original is never applied twice.
 */
export const claimDelivery = async (
  pool: Pool,
  deliveryId: string,
  event: string
): Promise<boolean> =>
  (
    await pool.query(
      'insert into webhook_deliveries (id, event) values ($1, $2) on conflict (id) do nothing returning id',
      [deliveryId, event]
    )
  ).rowCount === 1;

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

/**
 * Officina's own commit that only sets the spec's status line on top of the task's head, since
 * its last push, in SQL for a task `t` and a commit `$2`.
 */
const IS_STATUS_COMMIT = `exists (
  select 1 from task_events e where e.task_id = t.id and e.type = 'spec_status_set'
    and e.payload->>'commitSha' = $2
    and e.id > coalesce((select max(p.id) from task_events p
      where p.task_id = t.id and p.type = 'pushed'), 0))`;

/**
 * The head a commit stands for in the task's terms. Officina's own status commit sits on top of
 * the reviewed work, so feedback on it is feedback on the task's head; any other commit is passed
 * through and judged by the lifecycle.
 */
export const taskHeadFor = async (pool: Pool, taskId: string, commitId: string): Promise<string> =>
  (
    await pool.query<{ head_sha: string | null }>(
      `select t.head_sha from tasks t where t.id = $1 and ${IS_STATUS_COMMIT}`,
      [taskId, commitId]
    )
  ).rows[0]?.head_sha ?? commitId;

/** The tasks of a repository whose head is this commit, or Officina's status commit on it. */
export const findTasksByCommit = async (
  pool: Pool,
  repo: string,
  commitId: string
): Promise<string[]> =>
  (
    await pool.query<{ id: string }>(
      `select t.id from tasks t join projects p on p.id = t.project_id
       where lower(p.github_repo) = lower($1) and (t.head_sha = $2 or ${IS_STATUS_COMMIT})`,
      [repo, commitId]
    )
  ).rows.map((row) => row.id);
