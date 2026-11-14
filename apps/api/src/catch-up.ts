import { loadTaskContext } from '@officina/db';
import type { GitHubClient } from '@officina/github';
import type { Pool } from 'pg';
import { handleWebhookAction, type ConfigReader } from './webhooks';

/** What the catch-up for a missed pull request webhook reads from GitHub. */
export type PullRequestReader = ConfigReader & Pick<GitHubClient, 'pullRequest'>;

/** Applies the webhook's own handling when the pull request of a task in merging was closed. */
const catchUpPullRequest = async (pool: Pool, github: PullRequestReader, taskId: string) => {
  const context = await loadTaskContext(pool, taskId);
  if (context?.task.stage !== 'merging' || !context.pullRequest || !context.installationId) return;
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
 * handler error): GitHub redelivers only when a person asks, and the task would wait in merging
 * forever. It reads the pull request of each task in merging and applies what the webhook would
 * have, which is also how a merge Officina made straight away (`mergeWhenReady` answering
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
