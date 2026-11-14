import { ENGINE, parseProjectConfigYaml, type Command } from '@officina/core';
import {
  answeredOverviewLast,
  appendTaskEvent,
  applyCommand,
  findProjectsByRepo,
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

/**
 * A review left on the pull request becomes notes for the builder. A bot counts when it left inline
 * comments, and Copilot also when it left none but gave a verdict: a green or blue one can
 * still name a risk in its overview, and the builder checks each point as it would an inline one.
 * A person counts when they asked for changes, because a plain comment may only be a question.
 */
const reviewNotes = async (
  github: ConfigReader,
  installationId: number,
  action: Extract<WebhookAction, { kind: 'pull_request_reviewed' }>
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
  const overviewOnly = action.bot && comments.length === 0;
  // Only Copilot's verdict is read from the body; another bot with nothing inline asks for nothing.
  if (overviewOnly && (!COPILOT_REVIEWERS.has(action.by) || copilotVerdict(action.body) === null))
    return null;
  const notes = [
    overviewOnly
      ? `Review by @${action.by} on the pull request, with no comment on the code. Check each point of its verdict and overview against the code: change what is right, and say in \`reviewReply\` what you checked and why the rest needs no change. Finish \`unchanged\` when nothing does.`
      : `Review by @${action.by} on the pull request. Address each point, or explain in the code why it does not apply.`,
    action.body.trim(),
    ...comments.map(
      (comment) => `- \`${comment.path}${comment.line ? `:${comment.line}` : ''}\`: ${comment.body}`
    )
  ]
    .filter(Boolean)
    .join('\n\n');
  return { notes, overviewOnly };
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

const handleReview = async (
  pool: Pool,
  github: ConfigReader | undefined,
  action: Extract<WebhookAction, { kind: 'pull_request_reviewed' }>
): Promise<WebhookOutcome[]> => {
  if (!github) return [];
  const taskIds = await findTasksByPullRequest(pool, action.repo, action.prNumber);
  if (taskIds.length === 0) return [];
  const project = (await findProjectsByRepo(pool, action.repo)).find(
    (candidate) => candidate.installationId !== null
  );
  if (!project?.installationId) return [];
  const review = await reviewNotes(github, project.installationId, action);
  if (!review) return [];
  const outcomes: WebhookOutcome[] = [];
  for (const taskId of taskIds) {
    if (review.overviewOnly && (await answeredOverviewLast(pool, taskId, action.by))) {
      outcomes.push({ taskId, ok: false, error: 'overview_already_answered' });
      continue;
    }
    const result = await applyCommand(pool, {
      taskId,
      command: {
        type: 'github_review',
        headSha: await reviewedHead(pool, taskId, action.commitId),
        by: action.by,
        reviewId: action.reviewId,
        notes: review.notes,
        overviewOnly: review.overviewOnly
      },
      actor: ENGINE
    });
    outcomes.push(result.ok ? { taskId, ok: true } : { taskId, ok: false, error: result.error });
    await stopAutoMerge(
      pool,
      github,
      {
        taskId,
        installationId: project.installationId,
        repo: action.repo,
        prNumber: action.prNumber
      },
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
  if (action.kind === 'pull_request_closed') return handleClosed(pool, action);

  const targets: { prNumber: number; command: Command }[] =
    action.kind === 'pull_request_merged'
      ? [{ prNumber: action.prNumber, command: { type: 'merged' } }]
      : action.prNumbers.map((prNumber) => ({
          prNumber,
          command: { type: 'ci_failed', details: action.details }
        }));

  const outcomes: WebhookOutcome[] = [];
  const installationId = (await findProjectsByRepo(pool, action.repo)).find(
    (candidate) => candidate.installationId !== null
  )?.installationId;
  // A merged learning pull request is not a task; it marks its learning applied.
  if (action.kind === 'pull_request_merged')
    await markLearningsApplied(pool, action.repo, action.prNumber);
  for (const { prNumber, command } of targets) {
    for (const taskId of await findTasksByPullRequest(pool, action.repo, prNumber)) {
      const result = await applyCommand(pool, { taskId, command, actor: ENGINE });
      outcomes.push(result.ok ? { taskId, ok: true } : { taskId, ok: false, error: result.error });
      if (installationId)
        await stopAutoMerge(
          pool,
          github,
          { taskId, installationId, repo: action.repo, prNumber },
          result
        );
    }
  }
  return outcomes;
};

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
