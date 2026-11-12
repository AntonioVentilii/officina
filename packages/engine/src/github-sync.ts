import { branchForTask, ENGINE, parseProjectConfig, type Actor } from '@officina/core';
import { appendTaskEvent, hasTaskEvent, loadTask, loadTaskContext } from '@officina/db';
import type { GitHubAsUser, GitHubClient, RepoRef } from '@officina/github';
import type { Pool } from 'pg';

/**
 * A markdown link to a task. A bare `#N` would link the repository's issue or pull request N.
 */
export const taskLink = (publicUrl: string, taskNumber: number) =>
  `[Officina task ${taskNumber}](${publicUrl.replace(/\/$/, '')}/tasks/${taskNumber})`;

/** Acting on GitHub as the member who verified a task, with their own linked account. */
export interface OnBehalf {
  readonly publicUrl: string;
  tokenFor(memberId: string): Promise<{ token: string; login: string } | null>;
  readonly asUser: Pick<GitHubAsUser, 'pullRequest' | 'approve' | 'mergeWhenReady'>;
}

/** The member whose approval passed the verification, with a usable token of their own. */
const verifierAccount = async (
  pool: Pool,
  onBehalf: OnBehalf,
  taskId: string
): Promise<{ actor: Actor; token: string; login: string } | null> => {
  const verifier = (
    await pool.query<{ member_id: string }>(
      `select payload->>'memberId' as member_id from task_events
       where task_id = $1 and type = 'approval_recorded' and payload->>'gate' = 'verifying'
         and (payload->>'satisfied')::boolean
       order by id desc limit 1`,
      [taskId]
    )
  ).rows[0]?.member_id;
  if (!verifier) return null;
  const account = await onBehalf.tokenFor(verifier);
  return account ? { actor: { kind: 'member', memberId: verifier }, ...account } : null;
};

/**
 * Once a task is verified and its spec marked Implemented, approves the pull request on GitHub as
 * the member whose approval passed the gate, so their check counts as a review there. Without that
 * member's linked account nothing happens. It is tried once; a failure is recorded.
 */
export const approveOnGitHub = async (
  pool: Pool,
  onBehalf: OnBehalf,
  input: { taskId: string; taskNumber: number; repo: string; pullRequest: number }
) => {
  // Once per time the task reaches merging: a fix round after a GitHub review needs a new approval.
  const tried = await pool.query(
    `select 1 from task_events where task_id = $1 and type in ('github_approved', 'github_approval_failed')
       and id > ${SINCE_MERGING}`,
    [input.taskId]
  );
  if (tried.rowCount) return;
  const account = await verifierAccount(pool, onBehalf, input.taskId);
  if (!account) return;
  const { actor } = account;
  try {
    const pr = await onBehalf.asUser.pullRequest(account.token, input.repo, input.pullRequest);
    if (pr.merged || pr.state !== 'open') return;
    const expected = await expectedHead(pool, input.taskId);
    // Someone pushed after the verification: approving now would put the member's name on a
    // commit they never checked.
    if (pr.head.sha !== expected) {
      await appendTaskEvent(pool, {
        taskId: input.taskId,
        actor,
        type: 'github_approval_failed',
        payload: {
          login: account.login,
          error: `the pull request head ${pr.head.sha.slice(0, 7)} is not the verified ${expected?.slice(0, 7) ?? 'head'}`,
          expectedHead: expected,
          actualHead: pr.head.sha
        }
      });
      return;
    }
    await onBehalf.asUser.approve(
      account.token,
      input.repo,
      input.pullRequest,
      expected,
      `Verified in ${taskLink(onBehalf.publicUrl, input.taskNumber)}.`
    );
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor,
      type: 'github_approved',
      payload: { login: account.login, headSha: expected }
    });
  } catch (error) {
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor,
      type: 'github_approval_failed',
      payload: { login: account.login, error: (error as Error).message.slice(0, 500) }
    });
  }
};

export type SyncGitHubPort = Pick<
  GitHubClient,
  | 'readFile'
  | 'updateFile'
  | 'pushFacts'
  | 'commentOnIssue'
  | 'mergeWhenReady'
  | 'cancelAutoMerge'
  | 'pullRequestHead'
  | 'resolveReviewThreads'
>;

/**
 * The commit the pull request should have as its head: the task's verified head, or Officina's own
 * latest commit that only set the spec's status line on top of it. Anything else was pushed after
 * the result was accepted.
 */
const expectedHead = async (pool: Pool, taskId: string): Promise<string | null> =>
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

/** The id of the event that last moved the task into `merging`, in SQL for a task id `$1`. */
const SINCE_MERGING = `coalesce((select max(id) from task_events where task_id = $1
  and type = 'stage_changed' and payload->>'to' = 'merging'), 0)`;

/**
 * Resolves the pull request threads of the GitHub reviews that were sent back to the builder, once
 * per time the task reaches merging: by then the fixes were reviewed again and verified.
 */
const resolveForwardedThreads = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: { taskId: string; ref: RepoRef; pullRequest: number }
) => {
  if (
    (
      await pool.query(
        `select 1 from task_events where task_id = $1 and type = 'github_threads_resolved'
           and id > ${SINCE_MERGING}`,
        [input.taskId]
      )
    ).rowCount
  )
    return;
  const reviewIds = (
    await pool.query<{ review_id: string }>(
      `select distinct payload->>'githubReviewId' as review_id from task_events
       where task_id = $1 and type = 'review_recorded' and payload->>'reviewer' = 'github'`,
      [input.taskId]
    )
  ).rows.map((row) => Number(row.review_id));
  if (reviewIds.length === 0) return;
  const resolved = await github.resolveReviewThreads({
    ...input.ref,
    pullRequest: input.pullRequest,
    reviewIds
  });
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'github_threads_resolved',
    payload: { reviewIds, resolved }
  });
};

/**
 * Whether GitHub may merge the pull request on its own since the task reached merging: auto-merge
 * was turned on, or an attempt failed in a way that may have turned it on anyway (a timeout after
 * GitHub accepted it) and was not yet confirmed off. Either way a person must not be told to merge.
 */
const handedToGitHub = async (pool: Pool, taskId: string): Promise<boolean> =>
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
 * Records that the pull request holds a commit nobody verified, once per such head: it must not be
 * merged until the commits are reviewed, and any auto-merge is turned off (`cancelStaleAutoMerges`).
 */
const holdMerge = async (
  pool: Pool,
  input: { taskId: string; pullRequest: number; head: string }
) => {
  if (await hasTaskEvent(pool, input.taskId, 'merge_held', { headSha: input.head })) return;
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'merge_held',
    payload: { pullRequest: input.pullRequest, headSha: input.head }
  });
};

/**
 * Records, once per time the task reaches merging, that the engine's part is over and GitHub will
 * not merge on its own: the pull request waits for a person to merge it. The board and the
 * timeline say whose turn it is from this.
 */
const awaitMerge = async (pool: Pool, input: { taskId: string; pullRequest: number }) => {
  const recorded = await pool.query(
    `select 1 from task_events where task_id = $1 and type = 'awaiting_merge'
       and id > ${SINCE_MERGING}`,
    [input.taskId]
  );
  if (recorded.rowCount) return;
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'awaiting_merge',
    payload: { pullRequest: input.pullRequest }
  });
};

/**
 * Turns on GitHub's auto-merge, pinned to the verified head, so checks, resolved threads and any
 * required review still decide when it lands: as the verifier, or as the App for a result that
 * skipped people's verification. Tried once per time the task reaches merging. A failure may
 * still have turned it on (the request reached GitHub but the answer did not), so it is recorded
 * as unsettled and `cancelStaleAutoMerges` turns it off before a person is asked to merge.
 */
const autoMergeOnGitHub = async (
  pool: Pool,
  input: { taskId: string; actor: Actor; merge: () => Promise<'auto_merge' | 'merged'> }
) => {
  const tried = await pool.query(
    `select 1 from task_events where task_id = $1
       and type in ('github_auto_merge', 'github_auto_merge_failed') and id > ${SINCE_MERGING}`,
    [input.taskId]
  );
  if (tried.rowCount) return;
  try {
    const merge = await input.merge();
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: input.actor,
      type: 'github_auto_merge',
      payload: { merge }
    });
  } catch (error) {
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: input.actor,
      type: 'github_auto_merge_failed',
      payload: { error: (error as Error).message.slice(0, 500) }
    });
  }
};

/**
 * Turns auto-merge off, until GitHub confirms it, on every task of a project whose trail may have
 * it on (turned on, or an attempt with an unknown outcome) when it must not be: the task left
 * merging (sent back to building, or cancelled), the attempt failed, or the pull request was held
 * for commits nobody verified. The webhook that moved a task already tried once; this makes it
 * stick when that call failed.
 */
export const cancelStaleAutoMerges = async (
  pool: Pool,
  github: Pick<SyncGitHubPort, 'cancelAutoMerge'>,
  projectId: string
) => {
  const stale = (
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
  ).rows;
  const failures: string[] = [];
  for (const task of stale) {
    try {
      await github.cancelAutoMerge({
        installationId: Number(task.installation_id),
        repo: task.repo,
        pullRequest: task.pr
      });
      await appendTaskEvent(pool, {
        taskId: task.id,
        actor: ENGINE,
        type: 'github_auto_merge_cancelled',
        payload: { pullRequest: task.pr }
      });
    } catch (error) {
      failures.push(`${task.repo}#${task.pr}: ${(error as Error).message}`);
    }
  }
  if (failures.length) throw new Error(`auto-merge still on: ${failures.join('; ')}`);
};

/** Whether the task's latest way into merging skipped people's verification. */
const autoVerified = async (pool: Pool, taskId: string): Promise<boolean> =>
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

/** The spec file a task's branch adds, found by the project's spec directory. */
export const specPathIn = (
  changedPaths: readonly string[],
  specDir: string | null
): string | null => {
  if (!specDir) return null;
  const pattern = new RegExp(
    `^${specDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '')}/[^/]+\\.md$`
  );
  return changedPaths.find((path) => pattern.test(path)) ?? null;
};

/**
 * Sets the spec's `Status:` line on the task branch, once per status. The builder cannot do it: it
 * does not know the pull request number when it pushes.
 */
export const syncSpecStatus = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: {
    readonly taskId: string;
    readonly ref: RepoRef;
    readonly branch: string;
    readonly base: string;
    readonly specDir: string | null;
    readonly status: string;
  }
): Promise<'updated' | 'unchanged' | 'no_spec' | 'moved'> => {
  if (await hasTaskEvent(pool, input.taskId, 'spec_status_set', { status: input.status })) {
    return 'unchanged';
  }
  const facts = await github.pushFacts({ ...input.ref, base: input.base, branch: input.branch });
  const expected = await expectedHead(pool, input.taskId);
  // The branch holds commits nobody verified: a status commit on top of them must not stand for
  // the task's head. Recorded once, so the approval that follows sees the mismatch and skips.
  if (facts.headSha !== expected) {
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: ENGINE,
      type: 'spec_status_set',
      payload: { status: input.status, path: null, commitSha: null, branchMoved: facts.headSha }
    });
    return 'moved';
  }
  const path = specPathIn(facts.changedPaths, input.specDir);
  if (!path) return 'no_spec';
  const file = await github.readFile({ ...input.ref, path, branch: input.branch });
  if (!file) return 'no_spec';
  const text = file.text.replace(/^Status: .*$/m, `Status: ${input.status}`);
  let commitSha: string | null = null;
  let unverified: string | null = null;
  if (text !== file.text) {
    const written = await github.updateFile({
      ...input.ref,
      path,
      branch: input.branch,
      text,
      sha: file.sha,
      message: `docs(spec): mark ${path.split('/').pop()!.replace(/\.md$/, '')} ${input.status}`
    });
    // A push between reading the branch and writing would put the commit on top of it instead.
    if (written?.commitSha && written.parentSha === expected) commitSha = written.commitSha;
    else if (written?.commitSha) unverified = written.commitSha;
  }
  // The commit is recorded so a review of it counts as a review of the task's head: it only
  // changes the spec's status line on top of the work that was reviewed.
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'spec_status_set',
    payload: { status: input.status, path, commitSha, ...(unverified ? { unverified } : {}) }
  });
  return text === file.text ? 'unchanged' : 'updated';
};

interface ChooserResult {
  readonly checklist?: readonly string[];
  readonly beforeAfter?: readonly { key: string; locale: string; before: string; after: string }[];
}

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

/** The verification checklist as markdown, for the pull request and for people reading it there. */
export const checklistMarkdown = (result: unknown, taskLink: string): string | null => {
  const chosen = result as ChooserResult | null;
  if (!chosen?.checklist?.length) return null;
  const lines = [
    `### Verification checklist for ${taskLink}`,
    '',
    ...chosen.checklist.map((item) => `- [ ] ${item}`)
  ];
  if (chosen.beforeAfter?.length) {
    lines.push('', '| Key | Locale | Before | After |', '| --- | --- | --- | --- |');
    for (const row of chosen.beforeAfter) {
      lines.push(
        `| \`${cell(row.key)}\` | ${cell(row.locale)} | ${cell(row.before)} | ${cell(row.after)} |`
      );
    }
  }
  return lines.join('\n');
};

/** Posts the chooser's checklist on the pull request, once. */
export const postChecklist = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: { taskId: string; ref: RepoRef; pullRequest: number; taskLink: string; result: unknown }
) => {
  if (
    await hasTaskEvent(pool, input.taskId, 'checklist_posted', { pullRequest: input.pullRequest })
  )
    return;
  const body = checklistMarkdown(input.result, input.taskLink);
  if (!body) return;
  await github.commentOnIssue({ ...input.ref, issueNumber: input.pullRequest, body });
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'checklist_posted',
    payload: { pullRequest: input.pullRequest }
  });
};

/**
 * Marks the spec Implemented once the result is verified, by people or, in a green lane that opts
 * in, automatically: the final commit before merge, as the spec workflow asks. Then approves as the
 * verifier and hands the merge to GitHub or to a person (`autoMergeOnGitHub`, `awaitMerge`).
 */
export const finishVerifiedSpecs = async (
  pool: Pool,
  github: SyncGitHubPort,
  taskIds: readonly string[],
  onBehalf?: OnBehalf
) => {
  for (const taskId of taskIds) {
    const context = await loadTaskContext(pool, taskId);
    if (
      !context ||
      context.task.stage !== 'merging' ||
      !context.pullRequest ||
      !context.installationId
    )
      continue;
    const config = parseProjectConfig(context.rawConfig);
    if (!config.ok) continue;
    const ref: RepoRef = { installationId: context.installationId, repo: context.repo };
    await syncSpecStatus(pool, github, {
      taskId,
      ref,
      branch: branchForTask(context.number),
      base: context.defaultBranch,
      specDir: config.config.docs.specDir,
      status: `Implemented (#${context.pullRequest})`
    });
    await resolveForwardedThreads(pool, github, {
      taskId,
      ref,
      pullRequest: context.pullRequest
    }).catch(() => undefined);
    // A review may have sent the task back while the GitHub calls above ran; acting on the
    // context loaded before them would approve a head that is no longer accepted.
    const current = await loadTask(pool, taskId);
    if (current?.task.stage !== 'merging' || current.task.headSha !== context.task.headSha)
      continue;
    const pullRequest = context.pullRequest;
    // Checked on every pass, not once: a push after the verification (by anyone, at any time while
    // the task waits to merge) holds the pull request and gets auto-merge turned off, since
    // GitHub's auto-merge would land whatever the branch holds once its checks pass.
    const expected = await expectedHead(pool, taskId);
    const head = await github.pullRequestHead({ ...ref, pullRequest });
    if (!expected || head !== expected) {
      await holdMerge(pool, { taskId, pullRequest, head });
      continue;
    }
    // GitHub merges on its own only when the project allows it and the chooser chose it for this
    // result; anything else is merged by a person.
    const autoMerge =
      config.config.pullRequest.autoMerge && current.task.approvalPlans.verifying?.merge === 'auto';
    // After the status commit, so the approval covers the final head. A result that skipped
    // people's verification has no verifier to approve as.
    if (await autoVerified(pool, taskId)) {
      if (autoMerge)
        await autoMergeOnGitHub(pool, {
          taskId,
          actor: ENGINE,
          merge: () => github.mergeWhenReady({ ...ref, pullRequest, expectedHead: expected })
        });
    } else if (onBehalf) {
      await approveOnGitHub(pool, onBehalf, {
        taskId,
        taskNumber: context.number,
        repo: context.repo,
        pullRequest
      });
      // Only on top of the verifier's own approval, so it never stands in for a missing review.
      const approved = await hasTaskEvent(pool, taskId, 'github_approved', { headSha: expected });
      const account = autoMerge && approved ? await verifierAccount(pool, onBehalf, taskId) : null;
      if (account)
        await autoMergeOnGitHub(pool, {
          taskId,
          actor: account.actor,
          merge: () =>
            onBehalf.asUser.mergeWhenReady(account.token, context.repo, pullRequest, expected)
        });
    }
    if (!(await handedToGitHub(pool, taskId))) await awaitMerge(pool, { taskId, pullRequest });
  }
};
