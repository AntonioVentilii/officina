import { branchForTask, parseProjectConfig, type Actor } from '@officina/core';
import { appendTaskEvent, hasTaskEvent, loadTaskContext } from '@officina/db';
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

/**
 * Once a task is verified and its spec marked Implemented, approves the pull request on GitHub as
 * the member whose approval passed the gate, and asks GitHub to merge it when its rules are met.
 * Officina never merges on its own: without that member's linked account nothing happens and they
 * merge on GitHub as before. It is tried once; a failure is recorded for people to see.
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
  const verifier = (
    await pool.query<{ member_id: string }>(
      `select payload->>'memberId' as member_id from task_events
       where task_id = $1 and type = 'approval_recorded' and payload->>'gate' = 'verifying'
         and (payload->>'satisfied')::boolean
       order by id desc limit 1`,
      [input.taskId]
    )
  ).rows[0]?.member_id;
  if (!verifier) return;
  const account = await onBehalf.tokenFor(verifier);
  if (!account) return;
  const actor: Actor = { kind: 'member', memberId: verifier };
  try {
    const pr = await onBehalf.asUser.pullRequest(account.token, input.repo, input.pullRequest);
    if (pr.merged || pr.state !== 'open') return;
    await onBehalf.asUser.approve(
      account.token,
      input.repo,
      input.pullRequest,
      pr.head.sha,
      `Verified in ${taskLink(onBehalf.publicUrl, input.taskNumber)}.`
    );
    const merge = await onBehalf.asUser.mergeWhenReady(
      account.token,
      input.repo,
      input.pullRequest
    );
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor,
      type: 'github_approved',
      payload: { login: account.login, headSha: pr.head.sha, merge }
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
  | 'resolveReviewThreads'
>;

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
 * A result that skipped people's verification is merged by GitHub's own rules: the app turns on
 * auto-merge, so checks, resolved threads and any required review still decide. Tried once per
 * time the task reaches merging.
 */
const autoMergeOnGitHub = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: { taskId: string; ref: RepoRef; pullRequest: number }
) => {
  const tried = await pool.query(
    `select 1 from task_events where task_id = $1
       and type in ('github_auto_merge', 'github_auto_merge_failed') and id > ${SINCE_MERGING}`,
    [input.taskId]
  );
  if (tried.rowCount) return;
  try {
    const merge = await github.mergeWhenReady({ ...input.ref, pullRequest: input.pullRequest });
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: ENGINE,
      type: 'github_auto_merge',
      payload: { merge }
    });
  } catch (error) {
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: ENGINE,
      type: 'github_auto_merge_failed',
      payload: { error: (error as Error).message.slice(0, 500) }
    });
  }
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

const ENGINE: Actor = { kind: 'engine' };

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
): Promise<'updated' | 'unchanged' | 'no_spec'> => {
  if (await hasTaskEvent(pool, input.taskId, 'spec_status_set', { status: input.status })) {
    return 'unchanged';
  }
  const facts = await github.pushFacts({ ...input.ref, base: input.base, branch: input.branch });
  const path = specPathIn(facts.changedPaths, input.specDir);
  if (!path) return 'no_spec';
  const file = await github.readFile({ ...input.ref, path, branch: input.branch });
  if (!file) return 'no_spec';
  const text = file.text.replace(/^Status: .*$/m, `Status: ${input.status}`);
  if (text !== file.text) {
    await github.updateFile({
      ...input.ref,
      path,
      branch: input.branch,
      text,
      sha: file.sha,
      message: `docs(spec): mark ${path.split('/').pop()!.replace(/\.md$/, '')} ${input.status}`
    });
  }
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'spec_status_set',
    payload: { status: input.status, path }
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
 * in, automatically: the final commit before merge,
 * as the spec workflow asks.
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
    // After the status commit, so the approval covers the final head.
    if (await autoVerified(pool, taskId)) {
      await autoMergeOnGitHub(pool, github, { taskId, ref, pullRequest: context.pullRequest });
    } else if (onBehalf) {
      await approveOnGitHub(pool, onBehalf, {
        taskId,
        taskNumber: context.number,
        repo: context.repo,
        pullRequest: context.pullRequest
      });
    }
  }
};
