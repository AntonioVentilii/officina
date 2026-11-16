import { ENGINE } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './store';
import { appendTaskEvent } from './task-history';

/** Far longer than any handler runs: a webhook is answered in seconds. */
export const STALE_CLAIM = '10 minutes';

/**
 * How long a delivery is kept: longer than GitHub lets anyone redeliver (three days), with margin,
 * since an id older than that can never come again.
 */
export const DELIVERY_RETENTION = '7 days';

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

/** Deletes deliveries older than `DELIVERY_RETENTION`: their ids only take up space. */
export const purgeOldDeliveries = async (pool: Pool): Promise<number> =>
  (
    await pool.query('delete from webhook_deliveries where received_at < now() - $1::interval', [
      DELIVERY_RETENTION
    ])
  ).rowCount ?? 0;

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

// The rules of the auto-merge and verification trail are SQL fragments over the task id in `task`
// (a column such as `t.id`, or a parameter such as `$1`), so the board and the engine read the
// trail the same way. Their aliases are their own, so they nest in any query.

/** The id of the event that last moved the task into `merging`. */
const sinceMerging = (task: string): string =>
  `coalesce((select max(sm.id) from task_events sm where sm.task_id = ${task}
    and sm.type = 'stage_changed' and sm.payload->>'to' = 'merging'), 0)`;

/**
 * The id of the event that last moved the task into `merging`, or later carried its head to a new
 * commit with the same change (`head_carried`): what the engine does on GitHub at merging (approve,
 * auto-merge, hand to a person) is done again for the new commit. Whether auto-merge is on still
 * counts from `merging` (`sinceMerging`), so an attempt from before the carry is never hidden.
 */
const sinceHandoff = (task: string): string =>
  `coalesce((select max(sh.id) from task_events sh where sh.task_id = ${task}
    and ((sh.type = 'stage_changed' and sh.payload->>'to' = 'merging')
      or sh.type = 'head_carried')), 0)`;

/**
 * The commit an event `e` names as standing for the task's head: Officina's own commit that only
 * set the spec's status line on top of it, or a head carried from an update with the same change.
 */
const standingSha = (e: string): string =>
  `(case ${e}.type when 'spec_status_set' then ${e}.payload->>'commitSha'
     else ${e}.payload->>'headSha' end)`;

/** Events since the task's last push that name a commit standing for its head, for a task `t`. */
const STANDING_EVENTS = `e.task_id = t.id and e.type in ('spec_status_set', 'head_carried')
  and e.id > coalesce((select max(p.id) from task_events p
    where p.task_id = t.id and p.type = 'pushed'), 0)`;

/**
 * Whether the event `event` (a `task_events` alias) may have turned auto-merge on: it was turned
 * on, or an attempt failed in a way that may have turned it on anyway (a timeout after GitHub
 * accepted it). Before auto-merge had events of its own it was recorded in `github_approved` as
 * `merge: 'auto_merge'`; that payload is no longer written, but tasks from then still carry it,
 * so it is still read.
 */
const turnedAutoMergeOn = (event: string): string =>
  `(${event}.type in ('github_auto_merge', 'github_auto_merge_failed')
    or (${event}.type = 'github_approved' and ${event}.payload->>'merge' = 'auto_merge'))`;

/**
 * Whether GitHub may merge the pull request on its own: since the task last reached merging,
 * auto-merge was turned on or an attempt may have turned it on, and GitHub has not confirmed it
 * off since. Either way a person must not be told to merge.
 */
export const autoMergeIsOn = (task: string): string =>
  `exists (select 1 from task_events ao where ao.task_id = ${task}
    and ${turnedAutoMergeOn('ao')} and ao.id > ${sinceMerging(task)}
    and not exists (select 1 from task_events ac where ac.task_id = ${task}
      and ac.type = 'github_auto_merge_cancelled' and ac.id > ao.id))`;

/** Whether the task's latest way into merging skipped people's verification. */
export const wasAutoVerified = (task: string): string =>
  `exists (select 1 from task_events av where av.task_id = ${task} and av.type = 'auto_verified'
    and av.id > coalesce((select max(sc.id) from task_events sc where sc.task_id = ${task}
      and sc.type = 'stage_changed' and sc.payload->>'to' = 'choosing'), 0))`;

/**
 * Whether one of these events was recorded since the task last reached merging or had its head
 * carried (`sinceHandoff`): what the engine does on GitHub at merging is done once per head.
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
           and id > ${sinceHandoff('$1')}`,
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
 * The commit the pull request should have as its head: the task's verified head, or the latest
 * commit standing for it (Officina's own status commit on top of it, or a head carried from an
 * update with the same change). Anything else was pushed after the result was accepted.
 */
export const expectedHead = async (db: Pool | PoolClient, taskId: string): Promise<string | null> =>
  (
    await db.query<{ sha: string | null }>(
      `select coalesce(
         (select ${standingSha('e')} from task_events e
          where ${STANDING_EVENTS} and ${standingSha('e')} is not null
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
       where task_id = $1 and type = 'review_recorded' and payload->>'reviewer' = 'github'
         and payload ? 'githubReviewId'`,
      [taskId]
    )
  ).rows.map((row) => Number(row.review_id));

/** Whether GitHub may merge the pull request on its own (`autoMergeIsOn`). */
export const handedToGitHub = async (pool: Pool, taskId: string): Promise<boolean> =>
  (await pool.query<{ handed: boolean }>(`select ${autoMergeIsOn('$1')} as handed`, [taskId]))
    .rows[0]?.handed ?? false;

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
             and ${turnedAutoMergeOn('e')}), 0)
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
  (await pool.query<{ skipped: boolean }>(`select ${wasAutoVerified('$1')} as skipped`, [taskId]))
    .rows[0]?.skipped ?? false;

/**
 * Whether the task's last request for changes was an overview-only review or comment by the same
 * bot (comments of several bots forwarded together name each, comma-separated). A bot may review every push, and its overview of the builder's answer would otherwise send
 * the task back again and again; a review asking for changes on the code, or any other reviewer's,
 * still counts.
 */
export const answeredOverviewLast = async (
  pool: Pool,
  taskId: string,
  by: string
): Promise<boolean> =>
  Boolean(
    (
      await pool.query<{ last: boolean }>(
        `select (payload->>'reviewer' = 'github'
                 and $2 = any(string_to_array(payload->>'by', ', '))
                 and (payload->>'overviewOnly')::boolean is true) as last
         from task_events
         where task_id = $1 and type = 'review_recorded' and payload->>'verdict' = 'changes'
         order by id desc limit 1`,
        [taskId, by]
      )
    ).rows[0]?.last
  );

/** Whether a commit `$2` stands for the head of a task `t` since its last push. */
const STANDS_FOR_HEAD = `exists (
  select 1 from task_events e where ${STANDING_EVENTS} and ${standingSha('e')} = $2)`;

/**
 * The head a review, a check or a status is about, in the task's terms. A commit standing for the
 * task's head (Officina's own status commit, or a head carried from an update with the same
 * change) holds the reviewed work, so feedback on it is feedback on the task's head; any other
 * commit is passed through and judged by the lifecycle.
 */
export const reviewedHead = async (pool: Pool, taskId: string, commitId: string): Promise<string> =>
  (
    await pool.query<{ head_sha: string | null }>(
      `select t.head_sha from tasks t where t.id = $1 and ${STANDS_FOR_HEAD}`,
      [taskId, commitId]
    )
  ).rows[0]?.head_sha ?? commitId;

/** The tasks of a repository whose head is this commit, or a commit standing for it. */
export const findTasksByCommit = async (
  pool: Pool,
  repo: string,
  commitId: string
): Promise<string[]> =>
  (
    await pool.query<{ id: string }>(
      `select t.id from tasks t join projects p on p.id = t.project_id
       where lower(p.github_repo) = lower($1) and (t.head_sha = $2 or ${STANDS_FOR_HEAD})`,
      [repo, commitId]
    )
  ).rows.map((row) => row.id);

/**
 * Records that a new head carries the change people verified (`head_carried`), only while the task
 * is still at the stage and head it was compared at and its expected head is still the one
 * compared, checked under the task's row lock that every command takes: a push or a carry that
 * landed meanwhile wins, and `false` says nothing was recorded.
 */
export const recordHeadCarried = (
  pool: Pool,
  input: {
    readonly taskId: string;
    readonly stage: string;
    readonly taskHead: string;
    readonly from: string;
    readonly headSha: string;
  }
): Promise<boolean> =>
  inTransaction(pool, async (client) => {
    const row = (
      await client.query<{ stage: string; head_sha: string | null }>(
        'select stage, head_sha from tasks where id = $1 for update',
        [input.taskId]
      )
    ).rows[0];
    if (row?.stage !== input.stage || row.head_sha !== input.taskHead) return false;
    if ((await expectedHead(client, input.taskId)) !== input.from) return false;
    await appendTaskEvent(client, {
      taskId: input.taskId,
      actor: ENGINE,
      type: 'head_carried',
      payload: { headSha: input.headSha, from: input.from }
    });
    return true;
  });

/**
 * Records the spec status a task's branch carries (`spec_status_set`), once per status, checked
 * under the task's row lock: two openings of the same pull request that both reach the status
 * leave one entry, and `false` says it was already recorded.
 */
export const recordSpecStatus = (
  pool: Pool,
  taskId: string,
  payload: { readonly status: string } & Record<string, unknown>
): Promise<boolean> =>
  inTransaction(pool, async (client) => {
    await client.query('select 1 from tasks where id = $1 for update', [taskId]);
    const recorded = await client.query(
      `select 1 from task_events
       where task_id = $1 and type = 'spec_status_set' and payload @> $2::jsonb`,
      [taskId, JSON.stringify({ status: payload.status })]
    );
    if (recorded.rowCount) return false;
    await appendTaskEvent(client, { taskId, actor: ENGINE, type: 'spec_status_set', payload });
    return true;
  });
