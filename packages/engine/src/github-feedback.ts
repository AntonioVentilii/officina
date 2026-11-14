import {
  ENGINE,
  GITHUB_REVIEWABLE,
  parseProjectConfig,
  type GitHubFeedbackSource
} from '@officina/core';
import {
  answeredOverviewLast,
  applyCommand,
  loadTaskContext,
  settledBotComments,
  type StoredTaskContext
} from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { Pool } from 'pg';
import { stopAutoMergeOnLeaving } from './auto-merge';

/**
 * How long a review bot's comment must stay unchanged before it reaches the builder. Bots such as
 * a Claude review action post a placeholder and edit it as they work; forwarding the first text
 * would hand the builder the placeholder.
 */
export const COMMENT_SETTLE_SECONDS = 180;

export type ReviewNotes = { readonly notes: string; readonly overviewOnly: boolean };

/** The bots a project lists as its own reviewers (`pull_request.review_bots`). */
export const reviewBotsIn = (context: StoredTaskContext | null): ReadonlySet<string> => {
  const config = context ? parseProjectConfig(context.rawConfig) : null;
  return new Set(config?.ok ? config.config.pullRequest.reviewBots : []);
};

/** Notes for the builder about feedback that left nothing on the code: a verdict, an overview. */
export const overviewNotes = (what: string, by: string, body: string): string =>
  [
    `${what} by @${by} on the pull request, with no comment on the code. Check each point of it against the code: change what is right, and say in \`reviewReply\` what you checked and why the rest needs no change. Finish \`unchanged\` when nothing does.`,
    body.trim()
  ].join('\n\n');

/**
 * Sends a task back to its builder with feedback left on GitHub, once per answer: an overview by a
 * bot whose last overview the builder already answered is not sent back again, so a bot that
 * reviews every push cannot loop the task. Auto-merge goes off if the task leaves merging.
 */
export const forwardFeedback = async (
  pool: Pool,
  github: Pick<GitHubClient, 'cancelAutoMerge'> | undefined,
  input: {
    readonly taskId: string;
    readonly ref: RepoRef;
    readonly pullRequest: number;
    readonly by: string;
    readonly headSha: string;
    readonly source: GitHubFeedbackSource;
    readonly review: ReviewNotes;
  }
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const { taskId, review } = input;
  if (review.overviewOnly && (await answeredOverviewLast(pool, taskId, input.by)))
    return { ok: false, error: 'overview_already_answered' };
  const result = await applyCommand(pool, {
    taskId,
    command: {
      type: 'github_review',
      headSha: input.headSha,
      by: input.by,
      source: input.source,
      notes: review.notes,
      overviewOnly: review.overviewOnly
    },
    actor: ENGINE
  });
  if (github) await stopAutoMergeOnLeaving(pool, github, input, result);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
};

/** A task whose pull request holds a head that a review bot's comment can still send back. */
const takesComments = (
  context: StoredTaskContext | null
): context is StoredTaskContext & { pullRequest: number; installationId: number } =>
  context !== null &&
  context.pullRequest !== null &&
  context.installationId !== null &&
  GITHUB_REVIEWABLE.has(context.task.stage) &&
  !context.task.blocked &&
  !context.task.paused;

/**
 * Hands the builder, on every scheduler pass, the review bots' comments that stopped changing
 * (`COMMENT_SETTLE_SECONDS`), as one round about the head the task holds. A bot the project no
 * longer lists is left out.
 */
export const forwardSettledComments = async (
  pool: Pool,
  github: Pick<GitHubClient, 'cancelAutoMerge'>,
  taskIds: readonly string[]
) => {
  for (const taskId of taskIds) {
    const context = await loadTaskContext(pool, taskId);
    const headSha = context?.task.headSha;
    if (!takesComments(context) || !headSha) continue;
    const bots = reviewBotsIn(context);
    const comments = (await settledBotComments(pool, taskId, COMMENT_SETTLE_SECONDS)).filter(
      (comment) => bots.has(comment.by) && comment.body.trim() !== ''
    );
    const last = comments.at(-1);
    if (!last) continue;
    await forwardFeedback(pool, github, {
      taskId,
      ref: { installationId: context.installationId, repo: context.repo },
      pullRequest: context.pullRequest,
      by: [...new Set(comments.map((comment) => comment.by))].join(', '),
      headSha,
      source: { commentId: last.commentId },
      review: {
        notes: comments
          .map((comment) => overviewNotes('Comment', comment.by, comment.body))
          .join('\n\n'),
        overviewOnly: true
      }
    });
  }
};
