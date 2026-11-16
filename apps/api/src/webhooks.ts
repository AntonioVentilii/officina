import { ENGINE, parseProjectConfigYaml } from '@officina/core';
import {
  applyCommand,
  findProjectsByRepo,
  findTasksByCommit,
  findTasksByPullRequest,
  loadTaskContext,
  markLearningsApplied,
  recordBotComment,
  reviewedHead,
  unlinkPullRequest,
  updateProjectConfig,
  type ApplyResult
} from '@officina/db';
import {
  forwardFeedback,
  holdAutoMerge,
  overviewNotes,
  reviewBotsIn,
  stopAutoMergeOnLeaving,
  type ReviewNotes
} from '@officina/engine';
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

/** The auto-merge call, when this deployment's GitHub client has one. */
const cancelPort = (github: ConfigReader | undefined) =>
  github?.cancelAutoMerge ? { cancelAutoMerge: github.cancelAutoMerge } : undefined;

/** Turns auto-merge off when the command moved the task out of `merging` (`stopAutoMergeOnLeaving`). */
const stopAutoMerge = async (
  pool: Pool,
  github: ConfigReader | undefined,
  input: { taskId: string; installationId: number; repo: string; prNumber: number },
  result: ApplyResult
) => {
  if (!github?.cancelAutoMerge) return;
  await stopAutoMergeOnLeaving(
    pool,
    { cancelAutoMerge: github.cancelAutoMerge },
    {
      taskId: input.taskId,
      ref: { installationId: input.installationId, repo: input.repo },
      pullRequest: input.prNumber
    },
    result
  );
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
      reviewBotsIn(await loadTaskContext(pool, taskId))
    );
    if (!review) continue;
    const forwarded = await forwardFeedback(pool, cancelPort(github), {
      taskId,
      ref: { installationId, repo: action.repo },
      pullRequest: action.prNumber,
      by: action.by,
      headSha: await reviewedHead(pool, taskId, action.commitId),
      source: { reviewId: action.reviewId },
      review
    });
    outcomes.push({ taskId, ...forwarded });
  }
  return outcomes;
};

/**
 * A comment on the pull request from a bot the project lists as a reviewer, such as a review
 * action's summary, is recorded with every edit; the scheduler hands it to the builder once it
 * stops changing (`forwardSettledComments`), so a placeholder the bot edits as it works is never
 * what the builder reads.
 */
const handleComment = async (
  pool: Pool,
  github: ConfigReader | undefined,
  action: Extract<WebhookAction, { kind: 'pull_request_commented' }>
): Promise<WebhookOutcome[]> => {
  const outcomes: WebhookOutcome[] = [];
  for (const taskId of await findTasksByPullRequest(pool, action.repo, action.prNumber)) {
    const context = await loadTaskContext(pool, taskId);
    if (!context || !reviewBotsIn(context).has(action.by)) continue;
    await recordBotComment(pool, taskId, {
      commentId: action.commentId,
      by: action.by,
      body: action.body,
      updatedAt: action.updatedAt
    });
    // GitHub must not merge while the comment settles: it may send the work back.
    const cancel = cancelPort(github);
    if (cancel && context.task.stage === 'merging' && context.installationId)
      await holdAutoMerge(pool, cancel, {
        taskId,
        ref: { installationId: context.installationId, repo: action.repo },
        pullRequest: action.prNumber
      });
    outcomes.push({ taskId, ok: true });
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
