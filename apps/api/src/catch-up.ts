import { branchForLearning, editsProject, WITH_PULL_REQUEST } from '@officina/core';
import {
  clearAcceptAttempt,
  listAcceptsToCheck,
  listLearningPullRequests,
  loadTaskContext,
  markLearningPullRequestsClosed,
  markLearningsApplied,
  recordLeftAccept,
  type AcceptToCheck
} from '@officina/db';
import { eachTaskOnItsOwn, type TaskFailure } from '@officina/engine';
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
): Promise<TaskFailure[]> =>
  eachTaskOnItsOwn(taskIds, (taskId) => catchUpPullRequest(pool, github, taskId));

/**
 * Marks applied the accepted learnings of a project whose pull request merged while its webhook
 * was missed, and closed those whose pull request was closed without merging, as the webhook would
 * have (`markLearningsApplied`, `markLearningPullRequestsClosed`). Each pull request is tried on its
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
      else if (pr.state === 'closed')
        await markLearningPullRequestsClosed(pool, learning.repo, learning.pullRequest);
    } catch (error) {
      failures.push({ pullRequest: learning.pullRequest, error: (error as Error).message });
    }
  }
  return failures;
};

/**
 * Records the pull request a marked accept left from the branch of the learning's current edit,
 * the only one holding the edit the card shows: accepted while it is open, applied once merged.
 * The mark is cleared when the branch has none, when it was closed unmerged (the edit never landed,
 * so the learning is offered again), or when it was not recorded (`recordLeftAccept`).
 */
const catchUpLeftAccept = async (
  pool: Pool,
  github: Pick<GitHubClient, 'pullRequestFrom'>,
  learning: AcceptToCheck
) => {
  const clear = () => clearAcceptAttempt(pool, learning.id, learning.attempt);
  // An agent learning opens no pull request, so there is nothing to look for.
  if (!editsProject(learning.target)) return clear();
  const pr = await github.pullRequestFrom({
    installationId: learning.installationId,
    repo: learning.repo,
    branch: branchForLearning(learning),
    base: learning.defaultBranch
  });
  if (!pr || pr.state === 'closed') return clear();
  const recorded = await recordLeftAccept(pool, {
    id: learning.id,
    attempt: learning.attempt,
    status: pr.state === 'merged' ? 'applied' : 'accepted',
    prNumber: pr.number,
    prUrl: pr.url
  });
  if (!recorded) await clear();
};

/**
 * Records the proposed learnings of a project whose accept opened the pull request but lost its
 * record (the process stopped, the write failed, GitHub's answer was lost, or the claim was taken
 * over), so the card stops offering Accept for a pull request already open or merged. Each accept
 * marks its learning; once no claim is live, the branch is read and the mark recorded or cleared,
 * so each attempt is looked at once. Each learning is tried on its own; the failures are returned
 * for the log and tried again on the next pass.
 */
export const catchUpLeftAccepts = async (
  pool: Pool,
  github: Pick<GitHubClient, 'pullRequestFrom'>,
  projectId: string
): Promise<{ learningId: string; error: string }[]> => {
  const failures: { learningId: string; error: string }[] = [];
  for (const learning of await listAcceptsToCheck(pool, projectId)) {
    try {
      await catchUpLeftAccept(pool, github, learning);
    } catch (error) {
      failures.push({ learningId: learning.id, error: (error as Error).message });
    }
  }
  return failures;
};
