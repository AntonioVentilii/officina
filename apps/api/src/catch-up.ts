import { WITH_PULL_REQUEST } from '@officina/core';
import { listLearningPullRequests, loadTaskContext, markLearningsApplied } from '@officina/db';
import type { GitHubClient } from '@officina/github';
import type { Pool } from 'pg';
import { handleWebhookAction, type ConfigReader } from './webhooks';

/** What the catch-up for a missed pull request webhook reads from GitHub. */
export type PullRequestReader = ConfigReader & Pick<GitHubClient, 'pullRequest'>;

/**
 * Applies the webhook's own handling when the pull request of a task that may have one was closed:
 * a merge, or a close without merging, which GitHub can report from the first push on.
 */
const catchUpPullRequest = async (pool: Pool, github: PullRequestReader, taskId: string) => {
  const context = await loadTaskContext(pool, taskId);
  if (!context || !WITH_PULL_REQUEST.has(context.task.stage)) return;
  if (!context.pullRequest || !context.installationId) return;
  const prNumber = context.pullRequest;
  const pr = await github.pullRequest({
    installationId: context.installationId,
    repo: context.repo,
    pullRequest: prNumber
  });
  if (pr.state !== 'closed') return;
  const kind = pr.merged ? 'pull_request_merged' : 'pull_request_closed';
  await handleWebhookAction(pool, { kind, repo: context.repo, prNumber }, github);
};

/**
 * Catches up a pull request merged or closed whose webhook never arrived (a deploy restart, a
 * handler error): GitHub redelivers only when a person asks, and the task would wait forever for
 * a pull request that is gone. It reads the pull request of each task from building up to merging
 * and applies what the webhook would have, which is also how a merge Officina made straight away (`mergeWhenReady` answering
 * `merged`) reaches its task. Each task is tried on its own; the failures are returned for the log
 * and tried again on the next pass.
 */
export const catchUpPullRequests = async (
  pool: Pool,
  github: PullRequestReader,
  taskIds: readonly string[]
): Promise<{ taskId: string; error: string }[]> => {
  const failures: { taskId: string; error: string }[] = [];
  for (const taskId of taskIds) {
    await catchUpPullRequest(pool, github, taskId).catch((error: unknown) =>
      failures.push({ taskId, error: (error as Error).message })
    );
  }
  return failures;
};

/**
 * Marks applied the accepted learnings of a project whose pull request merged while its webhook
 * was missed, as the webhook would have (`markLearningsApplied`). Each pull request is tried on its
 * own; the failures are returned for the log and tried again on the next pass.
 */
export const catchUpLearningPullRequests = async (
  pool: Pool,
  github: Pick<GitHubClient, 'pullRequest'>,
  projectId: string
): Promise<{ pullRequest: number; error: string }[]> => {
  const failures: { pullRequest: number; error: string }[] = [];
  for (const learning of await listLearningPullRequests(pool, projectId)) {
    try {
      const pr = await github.pullRequest(learning);
      if (pr.merged) await markLearningsApplied(pool, learning.repo, learning.pullRequest);
    } catch (error) {
      failures.push({ pullRequest: learning.pullRequest, error: (error as Error).message });
    }
  }
  return failures;
};
