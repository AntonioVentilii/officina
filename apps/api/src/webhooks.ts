import { parseProjectConfigYaml, type Actor, type Command } from '@officina/core';
import {
  appendTaskEvent,
  applyCommand,
  findProjectsByRepo,
  findTasksByPullRequest,
  markLearningsApplied,
  unlinkPullRequest,
  updateProjectConfig
} from '@officina/db';
import type { GitHubClient, WebhookAction } from '@officina/github';
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

const ENGINE: Actor = { kind: 'engine' };

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
 * A review left on the pull request becomes notes for the builder. A bot (Copilot) counts when it
 * left inline comments, since a summary alone asks for nothing; a person counts when they asked for
 * changes, because a plain comment may only be a question.
 */
const reviewNotes = async (
  github: ConfigReader,
  installationId: number,
  action: Extract<WebhookAction, { kind: 'pull_request_reviewed' }>
): Promise<string | null> => {
  if (!action.bot && action.state !== 'changes_requested') return null;
  const comments = github.reviewComments
    ? await github.reviewComments({
        installationId,
        repo: action.repo,
        pullRequest: action.prNumber,
        reviewId: action.reviewId
      })
    : [];
  if (action.bot && comments.length === 0) return null;
  return [
    `Review by @${action.by} on the pull request. Address each point, or explain in the code why it does not apply.`,
    action.body.trim(),
    ...comments.map(
      (comment) => `- \`${comment.path}${comment.line ? `:${comment.line}` : ''}\`: ${comment.body}`
    )
  ]
    .filter(Boolean)
    .join('\n\n');
};

/**
 * The head a review is about, in the task's terms. Officina's own commits that only set the spec's
 * status line sit on top of the reviewed work, so a review of one of them is a review of the task's
 * head; any other commit is passed through and judged by the lifecycle.
 */
const reviewedHead = async (pool: Pool, taskId: string, commitId: string): Promise<string> => {
  const row = (
    await pool.query<{ head_sha: string | null }>(
      `select t.head_sha from tasks t
       where t.id = $1 and exists (
         select 1 from task_events e where e.task_id = t.id and e.type = 'spec_status_set'
           and e.payload->>'commitSha' = $2
           and e.id > coalesce((select max(p.id) from task_events p
             where p.task_id = t.id and p.type = 'pushed'), 0))`,
      [taskId, commitId]
    )
  ).rows[0];
  return row?.head_sha ?? commitId;
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
  const notes = await reviewNotes(github, project.installationId, action);
  if (!notes) return [];
  const outcomes: WebhookOutcome[] = [];
  for (const taskId of taskIds) {
    const result = await applyCommand(pool, {
      taskId,
      command: {
        type: 'github_review',
        headSha: await reviewedHead(pool, taskId, action.commitId),
        by: action.by,
        reviewId: action.reviewId,
        notes
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
