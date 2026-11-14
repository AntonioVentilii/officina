import {
  BUILD_ROLES,
  branchForTask,
  catalogPagesToRead,
  parseProjectConfig,
  type AgentOutput,
  type Catalog,
  type CatalogPages,
  type PushFacts,
  type Stage
} from '@officina/core';
import {
  latestBuild,
  linkPullRequest,
  loadTaskContext,
  type StoredTaskContext
} from '@officina/db';
import type { GitHubClient } from '@officina/github';
import type { Pool } from 'pg';
import { syncSpecStatus, taskLink, type SyncGitHubPort } from './github-sync';

export type PullRequestPort = Pick<GitHubClient, 'openPullRequest'> & SyncGitHubPort;

export type PushFactsPort = Pick<GitHubClient, 'pushFacts' | 'readFile'>;

/**
 * What was really pushed to a task branch, read from GitHub, never from whoever pushed it, with the
 * catalog pages as pushed: an edit that does not name a new file does not pass for listing it.
 */
export const readPush = async (
  github: PushFactsPort,
  ref: { readonly installationId: number; readonly repo: string },
  input: { readonly base: string; readonly branch: string; readonly catalogs: readonly Catalog[] }
): Promise<PushFacts & { readonly catalogPages: CatalogPages }> => {
  const facts = await github.pushFacts({ ...ref, base: input.base, branch: input.branch });
  const catalogPages: Record<string, string | null> = {};
  for (const page of catalogPagesToRead(input.catalogs, facts.addedPaths)) {
    // At the head the diff was read from, so a later push cannot change what is checked.
    catalogPages[page] =
      (await github.readFile({ ...ref, path: page, branch: facts.headSha }))?.text ?? null;
  }
  return { ...facts, catalogPages };
};

/** What a build round that pushed tells the pull request. */
export type PushedBuild = Extract<AgentOutput<'builder' | 'onboarder'>, { outcome: 'pushed' }>;

/** Every stage after a push expects the task's pull request to be open. */
const AWAITS_PULL_REQUEST: ReadonlySet<Stage> = new Set([
  'reviewing',
  'choosing',
  'verifying',
  'merging'
]);

/** A task whose build pushed but whose pull request is not linked yet. */
const awaitsPullRequest = (context: StoredTaskContext | null): context is StoredTaskContext =>
  context !== null &&
  context.pullRequest === null &&
  context.task.headSha !== null &&
  AWAITS_PULL_REQUEST.has(context.task.stage);

/** The pushed result a finished build recorded, if it left one to open the pull request from. */
const recordedPush = (run: { status: string; result: unknown } | null): PushedBuild | null => {
  if (!run || run.status === 'running') return null;
  const built = run.result as Partial<PushedBuild> | null;
  return built?.outcome === 'pushed' && built.prTitle ? (built as PushedBuild) : null;
};

const bullets = (items: readonly string[]) =>
  items.map((item) => `- ${item}`).join('\n') || '- nothing reported';

const pullRequestBody = (link: string, built: PushedBuild, issue: number | null) =>
  [
    `Implements the approved spec of ${link}.`,
    `Verified:\n${bullets(built.verified)}`,
    `Not verified:\n${bullets(built.notVerified)}`,
    'followUps' in built
      ? `Follow-ups, smells found while reading the code and left for their own changes:\n${bullets(built.followUps)}`
      : null,
    issue ? `Closes #${issue}` : null
  ]
    .filter(Boolean)
    .join('\n\n');

/**
 * Opens a built task's pull request, marks the spec in progress and links it, last: until the link
 * is stored the task still awaits its pull request, so a failure anywhere is retried by the next
 * catch-up. Safe to run again: `openPullRequest` returns the one already open from the task branch,
 * and the spec status is written once. `null` when the task has one already or does not await one.
 */
export const openTaskPullRequest = async (
  pool: Pool,
  github: PullRequestPort,
  input: { readonly taskId: string; readonly publicUrl: string; readonly built: PushedBuild }
): Promise<{ number: number; url: string } | null> => {
  const context = await loadTaskContext(pool, input.taskId);
  if (!awaitsPullRequest(context) || context.installationId === null) return null;
  const config = parseProjectConfig(context.rawConfig);
  const ref = { installationId: context.installationId, repo: context.repo };
  const branch = branchForTask(context.number);
  const pr = await github.openPullRequest({
    ...ref,
    base: context.defaultBranch,
    branch,
    title: input.built.prTitle,
    body: pullRequestBody(
      taskLink(input.publicUrl, context.projectId, context.number),
      input.built,
      context.issue
    )
  });
  await syncSpecStatus(pool, github, {
    taskId: input.taskId,
    ref,
    branch,
    base: context.defaultBranch,
    specDir: config.ok ? config.config.docs.specDir : null,
    status: `In progress (#${pr.number})`
  });
  await linkPullRequest(pool, input.taskId, pr.number);
  return pr;
};

/**
 * The scheduler's catch-up for a pull request a build failed to open after its round was applied
 * (GitHub down, the process dying). It opens it from the latest build's own title and checks: the
 * result an agent's round recorded, or a developer's hand-in, whichever came last. Each
 * task is tried on its own, so one failing does not hold up the others; the failures are returned
 * for the log and retried on the next pass.
 */
export const openMissingPullRequests = async (
  pool: Pool,
  github: PullRequestPort,
  taskIds: readonly string[],
  publicUrl: string
): Promise<{ taskId: string; error: string }[]> => {
  const failures: { taskId: string; error: string }[] = [];
  for (const taskId of taskIds) {
    if (!awaitsPullRequest(await loadTaskContext(pool, taskId))) continue;
    // A step still running opens its own pull request.
    const built = recordedPush(await latestBuild(pool, taskId, BUILD_ROLES));
    if (!built) continue;
    await openTaskPullRequest(pool, github, { taskId, publicUrl, built }).catch((error: unknown) =>
      failures.push({ taskId, error: (error as Error).message })
    );
  }
  return failures;
};
