import type { Pool, PoolClient } from 'pg';

/**
 * Claims a webhook delivery before it is processed. Only one of two concurrent deliveries with the
 * same id gets a claim, so a redelivery racing the original is never applied twice. A claim still
 * unhandled after `STALE_CLAIM` belonged to a process that died while handling it, and is taken
 * again under a new claim id. `null` means another claim holds the delivery or it was handled.
 */
export const claimDelivery = async (
  pool: Pool,
  deliveryId: string,
  event: string
): Promise<string | null> =>
  (
    await pool.query<{ claim: string }>(
      `insert into webhook_deliveries (id, event) values ($1, $2)
       on conflict (id) do update set received_at = now(), claim = gen_random_uuid()
         where webhook_deliveries.handled_at is null
           and webhook_deliveries.received_at < now() - $3::interval
       returning claim`,
      [deliveryId, event, STALE_CLAIM]
    )
  ).rows[0]?.claim ?? null;

/** Far longer than any handler runs: a webhook is answered in seconds. */
const STALE_CLAIM = '10 minutes';

/** Marks a delivery handled, so no redelivery processes it again; only its own claim may. */
export const markDeliveryHandled = async (
  pool: Pool,
  deliveryId: string,
  claim: string
): Promise<void> => {
  await pool.query(
    'update webhook_deliveries set handled_at = now() where id = $1 and claim = $2',
    [deliveryId, claim]
  );
};

/**
 * Deletes deliveries older than GitHub lets anyone redeliver (three days), with margin: their ids
 * can never come again, so they only take up space.
 */
export const purgeOldDeliveries = async (pool: Pool): Promise<number> =>
  (await pool.query("delete from webhook_deliveries where received_at < now() - interval '7 days'"))
    .rowCount ?? 0;

/** Gives a claimed delivery back after it failed, so GitHub's redelivery is processed. */
export const releaseDelivery = async (
  pool: Pool,
  deliveryId: string,
  claim: string
): Promise<void> => {
  await pool.query('delete from webhook_deliveries where id = $1 and claim = $2', [
    deliveryId,
    claim
  ]);
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

/** The id of the event that last moved the task into `merging`, in SQL for a task id `$1`. */
const SINCE_MERGING = `coalesce((select max(id) from task_events where task_id = $1
  and type = 'stage_changed' and payload->>'to' = 'merging'), 0)`;

/**
 * Whether one of these events was recorded since the task last reached merging: what the engine
 * does on GitHub at merging is done once per time the task gets there.
 */
export const hasEventSinceMerging = async (
  pool: Pool,
  taskId: string,
  types: readonly string[]
): Promise<boolean> =>
  Boolean(
    (
      await pool.query(
        `select 1 from task_events where task_id = $1 and type = any($2::text[])
           and id > ${SINCE_MERGING}`,
        [taskId, types]
      )
    ).rowCount
  );

/** The member whose approval last passed the verification gate. */
export const latestVerifier = async (pool: Pool, taskId: string): Promise<string | null> =>
  (
    await pool.query<{ member_id: string }>(
      `select payload->>'memberId' as member_id from task_events
       where task_id = $1 and type = 'approval_recorded' and payload->>'gate' = 'verifying'
         and (payload->>'satisfied')::boolean
       order by id desc limit 1`,
      [taskId]
    )
  ).rows[0]?.member_id ?? null;

/**
 * The commit the pull request should have as its head: the task's verified head, or Officina's own
 * latest commit that only set the spec's status line on top of it. Anything else was pushed after
 * the result was accepted.
 */
export const expectedHead = async (pool: Pool, taskId: string): Promise<string | null> =>
  (
    await pool.query<{ sha: string | null }>(
      `select coalesce(
         (select e.payload->>'commitSha' from task_events e
          where e.task_id = t.id and e.type = 'spec_status_set'
            and e.payload->>'commitSha' is not null
            and e.id > coalesce((select max(p.id) from task_events p
              where p.task_id = t.id and p.type = 'pushed'), 0)
          order by e.id desc limit 1),
         t.head_sha) as sha
       from tasks t where t.id = $1`,
      [taskId]
    )
  ).rows[0]?.sha ?? null;

/** The GitHub reviews that were ever sent back to the task's builder. */
export const forwardedReviewIds = async (pool: Pool, taskId: string): Promise<number[]> =>
  (
    await pool.query<{ review_id: string }>(
      `select distinct payload->>'githubReviewId' as review_id from task_events
       where task_id = $1 and type = 'review_recorded' and payload->>'reviewer' = 'github'`,
      [taskId]
    )
  ).rows.map((row) => Number(row.review_id));

/**
 * Whether GitHub may merge the pull request on its own since the task reached merging: auto-merge
 * was turned on, or an attempt failed in a way that may have turned it on anyway (a timeout after
 * GitHub accepted it) and was not yet confirmed off. Either way a person must not be told to merge.
 */
export const handedToGitHub = async (pool: Pool, taskId: string): Promise<boolean> =>
  Boolean(
    (
      await pool.query(
        `select 1 from task_events where task_id = $1 and id > ${SINCE_MERGING}
           and (type = 'github_auto_merge'
             or (type = 'github_auto_merge_failed' and not exists (
               select 1 from task_events c where c.task_id = $1
                 and c.type = 'github_auto_merge_cancelled' and c.id > task_events.id)))`,
        [taskId]
      )
    ).rowCount
  );

/**
 * The tasks of a project whose trail may have auto-merge on (turned on, or an attempt with an
 * unknown outcome) when it must not be: the task left merging, the attempt failed, or the pull
 * request was held for commits nobody verified.
 */
export const listStaleAutoMerges = async (
  pool: Pool,
  projectId: string
): Promise<{ id: string; repo: string; installationId: number; pullRequest: number }[]> =>
  (
    await pool.query<{ id: string; repo: string; installation_id: string; pr: number }>(
      `select t.id, p.github_repo as repo, p.github_installation_id::text as installation_id,
         t.github_pr as pr
       from tasks t join projects p on p.id = t.project_id
       cross join lateral (
         select
           coalesce((select max(e.id) from task_events e where e.task_id = t.id
             and (e.type in ('github_auto_merge', 'github_auto_merge_failed')
                  or (e.type = 'github_approved' and e.payload->>'merge' = 'auto_merge'))), 0)
             as turned_on,
           coalesce((select max(e.id) from task_events e where e.task_id = t.id
             and e.type = 'github_auto_merge_cancelled'), 0) as cancelled
       ) a
       where t.project_id = $1 and t.stage <> 'done' and t.github_pr is not null
         and p.github_installation_id is not null
         and a.turned_on > a.cancelled
         and (t.stage <> 'merging'
           or exists (select 1 from task_events e where e.id = a.turned_on
             and e.type = 'github_auto_merge_failed')
           or exists (select 1 from task_events e where e.task_id = t.id
             and e.type = 'merge_held' and e.id > a.cancelled))`,
      [projectId]
    )
  ).rows.map((row) => ({
    id: row.id,
    repo: row.repo,
    installationId: Number(row.installation_id),
    pullRequest: row.pr
  }));

/** Whether the task's latest way into merging skipped people's verification. */
export const autoVerified = async (pool: Pool, taskId: string): Promise<boolean> =>
  Boolean(
    (
      await pool.query(
        `select 1 from task_events where task_id = $1 and type = 'auto_verified'
           and id > coalesce((select max(id) from task_events where task_id = $1
             and type = 'stage_changed' and payload->>'to' = 'choosing'), 0)`,
        [taskId]
      )
    ).rowCount
  );
