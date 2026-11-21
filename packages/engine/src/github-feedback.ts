import {
  ENGINE,
  GITHUB_REVIEWABLE,
  parseProjectConfig,
  type DecisionError,
  type GitHubFeedbackSource
} from '@officina/core';
import {
  answeredOverviewLast,
  applyCommandIn,
  expectedHead,
  heldGitHubReviews,
  holdGitHubReview,
  inTransaction,
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
 * refused because the task is blocked or paused is kept for `forwardHeldReviews`, in the same
 * transaction as the refusal. Auto-merge is left as it is while such a review waits: holding it
 * for a task held at merging is a follow-up of its own.
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
  const { source } = input;
  const result = await inTransaction(pool, async (client) => {
    const applied = await applyCommandIn(client, {
      taskId,
      command: {
        type: 'github_review',
        headSha: input.headSha,
        by: input.by,
        source,
        notes: review.notes,
        overviewOnly: review.overviewOnly
      },
      actor: ENGINE
    });
    if (!applied.ok && HELD.has(applied.error) && 'reviewId' in source)
      await holdGitHubReview(client, taskId, {
        reviewId: source.reviewId,
        pullRequest: input.pullRequest,
        headSha: input.headSha,
        by: input.by,
        notes: review.notes,
        overviewOnly: review.overviewOnly
      });
    return applied;
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

type HeldReviewPort = Pick<GitHubClient, 'cancelAutoMerge' | 'pullRequest'>;

/** A task on a repository Officina is installed on, neither blocked nor paused. */
const freeOfHold = (
  context: StoredTaskContext | null
): context is StoredTaskContext & { installationId: number } =>
  context !== null &&
  context.installationId !== null &&
  !context.task.blocked &&
  !context.task.paused;

/**
 * Whether the task's pull request is still open at the head Officina expects of it.
 * `adoptOutsidePushes` skips a held task and may fail on a pass, so a push made during the hold may
 * not be taken in yet; a review accepted against the old head would send the task to building,
 * where pushes from outside are no longer taken in. Auto-merge is left on while a task is held at
 * merging and the `merged` command is refused while it is held, so the pull request may also have
 * merged or closed meanwhile; the catch-up deals with that first. The task's current pull request
 * is the one read, so a review of one it no longer links is left to the lifecycle's head check, as
 * is one outside the review window.
 */
const openAtExpectedHead = async (
  pool: Pool,
  github: HeldReviewPort,
  context: StoredTaskContext & { installationId: number }
): Promise<boolean> => {
  if (!GITHUB_REVIEWABLE.has(context.task.stage) || context.pullRequest === null) return true;
  const expected = await expectedHead(pool, context.task.id);
  if (!expected) return true;
  const { installationId, repo } = context;
  const pullRequest = await github.pullRequest({
    installationId,
    repo,
    pullRequest: context.pullRequest
  });
  return pullRequest.state === 'open' && pullRequest.head.sha === expected;
};

/**
 * Sends on the reviews kept while the task was held, oldest first, once it is neither blocked nor
 * paused and its pull request is open at the head Officina expects, as if each had just arrived:
 * the same overview guard, window, head check and auto-merge stop. A head that moved waits for a
 * later pass to take it in, which drops the reviews of the old one, and a pull request that merged
 * or closed waits for the catch-up to settle the task. Each is then recorded as dealt with,
 * sent or no longer applying, and never sent again; one that finds the task held again waits with
 * the rest. As with reviews arriving together, once one sends the task to building the later ones
 * meet the wrong stage and are dropped.
 */
const forwardHeldReviewsOf = async (pool: Pool, github: HeldReviewPort, taskId: string) => {
  const context = await loadTaskContext(pool, taskId);
  if (!freeOfHold(context)) return;
  const { installationId, repo } = context;
  const reviews = await heldGitHubReviews(pool, taskId);
  if (reviews.length === 0 || !(await openAtExpectedHead(pool, github, context))) return;
  for (const held of reviews) {
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
  github: HeldReviewPort,
  taskIds: readonly string[]
): Promise<TaskFailure[]> =>
  eachTaskOnItsOwn(taskIds, (taskId) => forwardHeldReviewsOf(pool, github, taskId));
