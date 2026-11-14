import { ENGINE } from '@officina/core';
import { appendTaskEvent, type ApplyResult } from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { Pool } from 'pg';

/**
 * Turns a task's auto-merge off on GitHub and records it in the task's trail, which is what tells
 * `cancelStaleAutoMerges` it is off. Throws when GitHub refuses, so nothing is recorded.
 */
export const cancelTaskAutoMerge = async (
  pool: Pool,
  github: Pick<GitHubClient, 'cancelAutoMerge'>,
  task: { id: string; installationId: number; repo: string; pullRequest: number }
) => {
  await github.cancelAutoMerge({
    installationId: task.installationId,
    repo: task.repo,
    pullRequest: task.pullRequest
  });
  await appendTaskEvent(pool, {
    taskId: task.id,
    actor: ENGINE,
    type: 'github_auto_merge_cancelled',
    payload: { pullRequest: task.pullRequest }
  });
};

/**
 * Turns auto-merge off when a command just moved a task out of `merging`, whatever moved it (a
 * review, failing checks, a push from outside): a person may have turned it on on GitHub, which
 * leaves no trail in Officina, and the work must be checked again before anything lands. A failure
 * is left to `cancelStaleAutoMerges`, which retries while the task's trail records auto-merge as on.
 */
export const stopAutoMergeOnLeaving = async (
  pool: Pool,
  github: Pick<GitHubClient, 'cancelAutoMerge'>,
  input: { readonly taskId: string; readonly ref: RepoRef; readonly pullRequest: number },
  result: ApplyResult
) => {
  const leftMerging =
    result.ok &&
    result.events.some((event) => event.type === 'stage_changed' && event.from === 'merging');
  if (!leftMerging) return;
  try {
    await cancelTaskAutoMerge(pool, github, {
      id: input.taskId,
      ...input.ref,
      pullRequest: input.pullRequest
    });
  } catch {
    // Left to `cancelStaleAutoMerges`.
  }
};
