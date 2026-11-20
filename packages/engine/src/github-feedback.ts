import {
  ENGINE,
  GITHUB_REVIEWABLE,
  parseProjectConfig,
  type DecisionError,
  type GitHubFeedbackSource
} from '@officina/core';
import {
  answeredOverviewLast,
  applyCommand,
  heldGitHubReviews,
  holdGitHubReview,
  loadTaskContext,
  markBotCommentsHandled,
  markHeldReviewHandled,
  unhandledBotComments,
  type BotComment,
  type StoredTaskContext
} from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { Pool, PoolClient } from 'pg';
import { stopAutoMergeOnLeaving } from './auto-merge';
import { eachTaskOnItsOwn, type TaskFailure } from './each-task';

/**
 * How long a review bot's comment must stay unchanged before it reaches the builder. Bots such as
 * a Claude review action post a placeholder and edit it as they work; forwarding the first text
 * would hand the builder the placeholder.
 */
export const COMMENT_SETTLE_SECONDS = 180;

export type ReviewNotes = { readonly notes: string; readonly overviewOnly: boolean };

/** The refusals that mean the task is held: a review refused this way is kept, not lost. */
const HELD: ReadonlySet<string> = new Set<DecisionError>(['blocked', 'paused']);

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
 * reviews every push cannot loop the task. Auto-merge goes off if the task leaves merging. A review
 * refused because the task is blocked or paused is kept for `forwardHeldReviews`.
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
  if (!result.ok && HELD.has(result.error) && 'reviewId' in input.source)
    await holdGitHubReview(pool, taskId, {
      reviewId: input.source.reviewId,
      pullRequest: input.pullRequest,
      headSha: input.headSha,
      by: input.by,
      notes: review.notes,
      overviewOnly: review.overviewOnly
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

/** The comments of bots the project lists, with something to read. */
const fromListedBots = (context: StoredTaskContext, comments: readonly BotComment[]) => {
  const bots = reviewBotsIn(context);
  return comments.filter((comment) => bots.has(comment.by) && comment.body.trim() !== '');
};

/**
 * Whether a review bot the project lists has a comment on the task's pull request that was not
 * dealt with yet, settled or not: until it is, the result must not be handed to GitHub to merge.
 * Under the task's row lock it takes that transaction's client, so it never waits for a second
 * connection while others wait on the lock.
 */
export const hasPendingBotComments = async (
  db: Pool | PoolClient,
  context: StoredTaskContext
): Promise<boolean> =>
  fromListedBots(context, await unhandledBotComments(db, context.task.id, 0)).length > 0;

/**
 * The settled comments to forward: a bot whose last overview the builder already answered is left
 * out, checked bot by bot, so a bot that comments on every answer cannot loop the task.
 */
const toForward = async (pool: Pool, taskId: string, comments: readonly BotComment[]) => {
  const answered = new Set<string>();
  for (const bot of new Set(comments.map((comment) => comment.by)))
    if (await answeredOverviewLast(pool, taskId, bot)) answered.add(bot);
  await markBotCommentsHandled(
    pool,
    taskId,
    comments.filter((comment) => answered.has(comment.by)).map((comment) => comment.commentId)
  );
  return comments.filter((comment) => !answered.has(comment.by));
};

/**
 * Hands the builder, on every scheduler pass, the review bots' comments that stopped changing
 * (`COMMENT_SETTLE_SECONDS`), as one round about the head the task holds, naming every bot so the
 * loop guard knows each. A bot the project no longer lists is left out.
 */
const forwardSettledCommentsOf = async (
  pool: Pool,
  github: Pick<GitHubClient, 'cancelAutoMerge'>,
  taskId: string
) => {
  const context = await loadTaskContext(pool, taskId);
  const headSha = context?.task.headSha;
  if (!takesComments(context) || !headSha) return;
  const settled = fromListedBots(
    context,
    await unhandledBotComments(pool, taskId, COMMENT_SETTLE_SECONDS)
  );
  const comments = await toForward(pool, taskId, settled);
  const last = comments.at(-1);
  if (!last) return;
  const forwarded = await forwardFeedback(pool, github, {
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
  if (forwarded.ok)
    await markBotCommentsHandled(
      pool,
      taskId,
      comments.map((comment) => comment.commentId)
    );
};

/** Each task on its own; the failures are returned for the log and tried again on the next pass. */
export const forwardSettledComments = async (
  pool: Pool,
  github: Pick<GitHubClient, 'cancelAutoMerge'>,
  taskIds: readonly string[]
): Promise<TaskFailure[]> =>
  eachTaskOnItsOwn(taskIds, (taskId) => forwardSettledCommentsOf(pool, github, taskId));

/**
 * Sends on the reviews kept while the task was held, oldest first, once it is neither blocked nor
 * paused, as if each had just arrived: the same overview guard, window, head check and auto-merge
 * stop. Each is then recorded as dealt with, sent or no longer applying, and never sent again; one
 * that finds the task held again waits with the rest. As with reviews arriving together, once one
 * sends the task to building the later ones meet the wrong stage and are dropped.
 */
const forwardHeldReviewsOf = async (
  pool: Pool,
  github: Pick<GitHubClient, 'cancelAutoMerge'>,
  taskId: string
) => {
  const context = await loadTaskContext(pool, taskId);
  if (!context || context.task.blocked || context.task.paused) return;
  const { installationId, repo } = context;
  if (installationId === null) return;
  for (const held of await heldGitHubReviews(pool, taskId)) {
    const forwarded = await forwardFeedback(pool, github, {
      taskId,
      ref: { installationId, repo },
      pullRequest: held.pullRequest,
      by: held.by,
      headSha: held.headSha,
      source: { reviewId: held.reviewId },
      review: { notes: held.notes, overviewOnly: held.overviewOnly }
    });
    if (!forwarded.ok && HELD.has(forwarded.error)) return;
    await markHeldReviewHandled(pool, taskId, {
      reviewId: held.reviewId,
      by: held.by,
      outcome: forwarded.ok ? 'forwarded' : forwarded.error
    });
  }
};

/** Each task on its own; the failures are returned for the log and tried again on the next pass. */
export const forwardHeldReviews = async (
  pool: Pool,
  github: Pick<GitHubClient, 'cancelAutoMerge'>,
  taskIds: readonly string[]
): Promise<TaskFailure[]> =>
  eachTaskOnItsOwn(taskIds, (taskId) => forwardHeldReviewsOf(pool, github, taskId));
