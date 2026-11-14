import {
  ENGINE,
  parseProjectConfig,
  parseProjectConfigYaml,
  type GitHubFeedbackSource
} from '@officina/core';
import {
  answeredOverviewLast,
  appendTaskEvent,
  applyCommand,
  findProjectsByRepo,
  findTasksByCommit,
  findTasksByPullRequest,
  loadTaskContext,
  markLearningsApplied,
  reviewedHead,
  unlinkPullRequest,
  updateProjectConfig
} from '@officina/db';
import {
  COPILOT_REVIEWERS,
  copilotVerdict,
  type GitHubClient,
  type WebhookAction
} from '@officina/github';
import type { Pool } from 'pg';

export const CONFIG_PATH = '.github/officina.yml';

export type WebhookOutcome =
  | { readonly taskId: string; readonly ok: boolean; readonly error?: string }
  | {
      readonly projectId: string;
      readonly config: 'updated' | 'invalid' | 'missing';
      readonly errors?: readonly string[];
    };

/** What webhooks need from GitHub: configs on push, and review comments and auto-merge on reviews. */
export type ConfigReader = Pick<GitHubClient, 'fileContent'> &
  Partial<Pick<GitHubClient, 'reviewComments' | 'cancelAutoMerge'>>;

/**
 * A push to a project's default branch that touches its config refreshes the stored config. An
 * invalid or deleted config is reported and the last valid one stays in force.
 */
const refreshConfigs = async (
  pool: Pool,
  github: ConfigReader | undefined,
  action: Extract<WebhookAction, { kind: 'push' }>
): Promise<WebhookOutcome[]> => {
  if (!github || !action.changedPaths.includes(CONFIG_PATH)) return [];
  const outcomes: WebhookOutcome[] = [];
  for (const project of await findProjectsByRepo(pool, action.repo)) {
    if (project.defaultBranch !== action.branch || project.installationId === null) continue;
    const text = await github.fileContent({
      installationId: project.installationId,
      repo: project.repo,
      path: CONFIG_PATH,
      branch: project.defaultBranch
    });
    if (text === null) {
      outcomes.push({ projectId: project.id, config: 'missing' });
      continue;
    }
    const parsed = parseProjectConfigYaml(text);
    if (!parsed.ok) {
      outcomes.push({ projectId: project.id, config: 'invalid', errors: parsed.errors });
      continue;
    }
    await updateProjectConfig(pool, project.id, Bun.YAML.parse(text));
    outcomes.push({ projectId: project.id, config: 'updated' });
  }
  return outcomes;
};

type ReviewNotes = { readonly notes: string; readonly overviewOnly: boolean };

/** The bots a task's project lists as its own reviewers (`pull_request.review_bots`). */
const reviewBotsOf = async (pool: Pool, taskId: string): Promise<ReadonlySet<string>> => {
  const context = await loadTaskContext(pool, taskId);
  const config = context ? parseProjectConfig(context.rawConfig) : null;
  return new Set(config?.ok ? config.config.pullRequest.reviewBots : []);
};

/** Notes for the builder about feedback that left nothing on the code: a verdict, an overview. */
const overviewNotes = (what: string, by: string, body: string): string =>
  [
    `${what} by @${by} on the pull request, with no comment on the code. Check each point of it against the code: change what is right, and say in \`reviewReply\` what you checked and why the rest needs no change. Finish \`unchanged\` when nothing does.`,
    body.trim()
  ].join('\n\n');

/**
 * A review left on the pull request becomes notes for the builder. A bot counts when it left inline
 * comments; with none, Copilot counts when it gave a verdict (a green or blue one can still name a
 * risk in its overview) and a bot the project lists as a reviewer counts when it wrote anything.
 * The builder checks each point as it would an inline one. A person counts when they asked for
 * changes, because a plain comment may only be a question.
 */
const reviewNotes = async (
  github: ConfigReader,
  installationId: number,
  action: Extract<WebhookAction, { kind: 'pull_request_reviewed' }>,
  reviewBots: ReadonlySet<string>
): Promise<ReviewNotes | null> => {
  if (!action.bot && action.state !== 'changes_requested') return null;
  const comments = github.reviewComments
    ? await github.reviewComments({
        installationId,
        repo: action.repo,
        pullRequest: action.prNumber,
        reviewId: action.reviewId
      })
    : [];
  if (action.bot && comments.length === 0) {
    const copilot = COPILOT_REVIEWERS.has(action.by) && copilotVerdict(action.body) !== null;
    const listed = reviewBots.has(action.by) && action.body.trim() !== '';
    if (!copilot && !listed) return null;
    return { notes: overviewNotes('Review', action.by, action.body), overviewOnly: true };
  }
  const notes = [
    `Review by @${action.by} on the pull request. Address each point, or explain in the code why it does not apply.`,
    action.body.trim(),
    ...comments.map(
      (comment) => `- \`${comment.path}${comment.line ? `:${comment.line}` : ''}\`: ${comment.body}`
    )
  ]
    .filter(Boolean)
    .join('\n\n');
  return { notes, overviewOnly: false };
};

/**
 * Turns auto-merge off when a task just left `merging`, whatever moved it (a review, failing
 * checks): Officina never turns it on, but a person may have on GitHub, and the work must be
 * checked again before anything lands. A failure is left to `cancelStaleAutoMerges`, which retries
 * while the task's trail records auto-merge as on.
 */
const stopAutoMerge = async (
  pool: Pool,
  github: ConfigReader | undefined,
  input: { taskId: string; installationId: number; repo: string; prNumber: number },
  result: Awaited<ReturnType<typeof applyCommand>>
) => {
  const leftMerging =
    result.ok &&
    result.events.some((event) => event.type === 'stage_changed' && event.from === 'merging');
  if (!leftMerging || !github?.cancelAutoMerge) return;
  try {
    await github.cancelAutoMerge({
      installationId: input.installationId,
      repo: input.repo,
      pullRequest: input.prNumber
    });
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: ENGINE,
      type: 'github_auto_merge_cancelled',
      payload: { pullRequest: input.prNumber }
    });
  } catch {
    // Left to `cancelStaleAutoMerges`.
  }
};

/** Sends one task back to its builder with feedback left on GitHub, once per answer. */
const forwardFeedback = async (
  pool: Pool,
  github: ConfigReader,
  input: {
    taskId: string;
    installationId: number;
    repo: string;
    prNumber: number;
    by: string;
    headSha: string;
    source: GitHubFeedbackSource;
    review: ReviewNotes;
  }
): Promise<WebhookOutcome> => {
  const { taskId, review } = input;
  if (review.overviewOnly && (await answeredOverviewLast(pool, taskId, input.by)))
    return { taskId, ok: false, error: 'overview_already_answered' };
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
  await stopAutoMerge(pool, github, input, result);
  return result.ok ? { taskId, ok: true } : { taskId, ok: false, error: result.error };
};

/** The installation the repository's project is reached through, if it has one. */
const installationOf = async (pool: Pool, repo: string): Promise<number | null> =>
  (await findProjectsByRepo(pool, repo)).find((candidate) => candidate.installationId !== null)
    ?.installationId ?? null;

const handleReview = async (
  pool: Pool,
  github: ConfigReader | undefined,
  action: Extract<WebhookAction, { kind: 'pull_request_reviewed' }>
): Promise<WebhookOutcome[]> => {
  if (!github) return [];
  const taskIds = await findTasksByPullRequest(pool, action.repo, action.prNumber);
  if (taskIds.length === 0) return [];
  const installationId = await installationOf(pool, action.repo);
  if (!installationId) return [];
  const outcomes: WebhookOutcome[] = [];
  for (const taskId of taskIds) {
    const review = await reviewNotes(
      github,
      installationId,
      action,
      await reviewBotsOf(pool, taskId)
    );
    if (!review) continue;
    outcomes.push(
      await forwardFeedback(pool, github, {
        taskId,
        installationId,
        repo: action.repo,
        prNumber: action.prNumber,
        by: action.by,
        headSha: await reviewedHead(pool, taskId, action.commitId),
        source: { reviewId: action.reviewId },
        review
      })
    );
  }
  return outcomes;
};

/**
 * A comment on the pull request from a bot the project lists as a reviewer, such as a review
 * action's summary, reaches the builder like a review that left nothing on the code. A comment is
 * tied to no commit, so it is taken to be about the head the task holds when it arrives.
 */
const handleComment = async (
  pool: Pool,
  github: ConfigReader | undefined,
  action: Extract<WebhookAction, { kind: 'pull_request_commented' }>
): Promise<WebhookOutcome[]> => {
  if (!github || action.body.trim() === '') return [];
  const installationId = await installationOf(pool, action.repo);
  if (!installationId) return [];
  const outcomes: WebhookOutcome[] = [];
  for (const taskId of await findTasksByPullRequest(pool, action.repo, action.prNumber)) {
    if (!(await reviewBotsOf(pool, taskId)).has(action.by)) continue;
    const headSha = (await loadTaskContext(pool, taskId))?.task.headSha;
    if (!headSha) continue;
    outcomes.push(
      await forwardFeedback(pool, github, {
        taskId,
        installationId,
        repo: action.repo,
        prNumber: action.prNumber,
        by: action.by,
        headSha,
        source: { commentId: action.commentId },
        review: { notes: overviewNotes('Comment', action.by, action.body), overviewOnly: true }
      })
    );
  }
  return outcomes;
};

/**
 * A failed check suite or commit status on a task's head sends the work back to the builder with
 * what failed, from review up to merging, so nobody checks or merges a head with red checks.
 */
const handleChecksFailed = async (
  pool: Pool,
  github: ConfigReader | undefined,
  action: Extract<WebhookAction, { kind: 'checks_failed' }>
): Promise<WebhookOutcome[]> => {
  const installationId = await installationOf(pool, action.repo);
  const outcomes: WebhookOutcome[] = [];
  for (const taskId of await findTasksByCommit(pool, action.repo, action.headSha)) {
    const result = await applyCommand(pool, {
      taskId,
      command: {
        type: 'ci_failed',
        headSha: await reviewedHead(pool, taskId, action.headSha),
        details: action.details
      },
      actor: ENGINE
    });
    outcomes.push(result.ok ? { taskId, ok: true } : { taskId, ok: false, error: result.error });
    const prNumber = (await loadTaskContext(pool, taskId))?.pullRequest;
    if (installationId && prNumber)
      await stopAutoMerge(
        pool,
        github,
        { taskId, installationId, repo: action.repo, prNumber },
        result
      );
  }
  return outcomes;
};

/**
 * A pull request closed without merging sends its tasks back to the start of the build, held for
 * a maintainer, and forgets the pull request so a rebuild opens a new one. Nothing on GitHub tells
 * Officina otherwise, so without this an onboarding task would hold its project forever.
 */
const handleClosed = async (
  pool: Pool,
  action: Extract<WebhookAction, { kind: 'pull_request_closed' }>
): Promise<WebhookOutcome[]> => {
  const outcomes: WebhookOutcome[] = [];
  for (const taskId of await findTasksByPullRequest(pool, action.repo, action.prNumber)) {
    // The link is cleared in the same transaction as the move, so a crash between the two can
    // never leave a rebuilt task pointing at the closed pull request.
    const result = await applyCommand(pool, {
      taskId,
      command: { type: 'pull_request_closed', pullRequest: action.prNumber },
      actor: ENGINE,
      onApplied: (client) => unlinkPullRequest(client, taskId)
    });
    outcomes.push(result.ok ? { taskId, ok: true } : { taskId, ok: false, error: result.error });
  }
  return outcomes;
};

/**
 * Applies a GitHub fact. Pull request outcomes go to every linked task; a rejection such as
 * `wrong_stage` (CI failing while a task is still in review) is reported rather than raised.
 */
export const handleWebhookAction = async (
  pool: Pool,
  action: WebhookAction,
  github?: ConfigReader
): Promise<WebhookOutcome[]> => {
  if (action.kind === 'push') return refreshConfigs(pool, github, action);
  if (action.kind === 'pull_request_reviewed') return handleReview(pool, github, action);
  if (action.kind === 'pull_request_commented') return handleComment(pool, github, action);
  if (action.kind === 'pull_request_closed') return handleClosed(pool, action);
  if (action.kind === 'checks_failed') return handleChecksFailed(pool, github, action);

  // A merged learning pull request is not a task; it marks its learning applied.
  await markLearningsApplied(pool, action.repo, action.prNumber);
  const outcomes: WebhookOutcome[] = [];
  for (const taskId of await findTasksByPullRequest(pool, action.repo, action.prNumber)) {
    const result = await applyCommand(pool, { taskId, command: { type: 'merged' }, actor: ENGINE });
    outcomes.push(result.ok ? { taskId, ok: true } : { taskId, ok: false, error: result.error });
  }
  return outcomes;
};
