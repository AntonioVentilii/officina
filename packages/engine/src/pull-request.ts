import {
  BUILD_ROLES,
  ENGINE,
  GITHUB_REVIEWABLE,
  branchForTask,
  catalogPagesToRead,
  parseProjectConfig,
  type AgentOutput,
  type Catalog,
  type CatalogPages,
  type PushFacts
} from '@officina/core';
import {
  applyCommand,
  expectedHead,
  type ApplyResult,
  latestBuild,
  linkPullRequest,
  loadTaskContext,
  type StoredTaskContext
} from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { Pool } from 'pg';
import { stopAutoMergeOnLeaving } from './auto-merge';
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

/** A task whose build pushed but whose pull request is not linked yet. */
const awaitsPullRequest = (context: StoredTaskContext | null): context is StoredTaskContext =>
  context !== null &&
  context.pullRequest === null &&
  context.task.headSha !== null &&
  // Every stage after a push expects the task's pull request to be open.
  GITHUB_REVIEWABLE.has(context.task.stage);

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

/** A task whose open pull request holds a head Officina took in, which someone else may move. */
const movableFromOutside = (
  context: StoredTaskContext | null
): context is StoredTaskContext & { pullRequest: number; installationId: number } =>
  context !== null &&
  context.pullRequest !== null &&
  context.installationId !== null &&
  GITHUB_REVIEWABLE.has(context.task.stage) &&
  !context.task.blocked &&
  !context.task.paused;

/**
 * Takes in a head on a task's pull request that Officina did not push: a review bot's fix, a
 * person's commit, an update from the default branch. Read from the pull request on every pass, so
 * a missed webhook cannot hide one, and run before `finishVerifiedSpecs` in the same pass, so
 * Officina's own status commit is recorded before it is looked for. Skipped while a build run is
 * still going: its push, and the status commit after it, are not recorded yet.
 */
export type AdoptPort = PushFactsPort &
  Pick<GitHubClient, 'pullRequest' | 'failedChecks' | 'cancelAutoMerge'>;

/**
 * What follows a head taken in: auto-merge off if the task left `merging`, since GitHub would land
 * the new head once its checks pass, and the checks already red on it sent to the builder, since
 * GitHub reported them before any task held that commit and nothing will report them again.
 */
const afterAdoption = async (
  pool: Pool,
  github: AdoptPort,
  input: { taskId: string; ref: RepoRef; pullRequest: number; headSha: string },
  adopted: ApplyResult
) => {
  await stopAutoMergeOnLeaving(pool, github, input, adopted);
  if (!adopted.ok || adopted.task.stage !== 'reviewing') return;
  const failures = await github.failedChecks({ ...input.ref, sha: input.headSha });
  if (failures.length === 0) return;
  await applyCommand(pool, {
    taskId: input.taskId,
    command: { type: 'ci_failed', headSha: input.headSha, details: failures.join('; ') },
    actor: ENGINE
  });
};

export const adoptOutsidePushes = async (
  pool: Pool,
  github: AdoptPort,
  taskIds: readonly string[]
) => {
  for (const taskId of taskIds) {
    const context = await loadTaskContext(pool, taskId);
    if (!movableFromOutside(context)) continue;
    const { task } = context;
    if ((await latestBuild(pool, taskId, BUILD_ROLES))?.status === 'running') continue;
    const ref = { installationId: context.installationId, repo: context.repo };
    const expected = await expectedHead(pool, taskId);
    if (
      (await github.pullRequest({ ...ref, pullRequest: context.pullRequest })).head.sha === expected
    )
      continue;
    const config = parseProjectConfig(context.rawConfig);
    if (!config.ok) continue;
    const head = await readPush(github, ref, {
      base: context.defaultBranch,
      branch: branchForTask(context.number),
      catalogs: config.config.docs.standards.catalogs
    });
    if (head.headSha === expected) continue;
    const adopted = await applyCommand(pool, {
      taskId,
      command: { type: 'outside_push', ...head },
      actor: ENGINE,
      guard: (current) => current.stage === task.stage && current.headSha === task.headSha
    });
    await afterAdoption(
      pool,
      github,
      { taskId, ref, pullRequest: context.pullRequest, headSha: head.headSha },
      adopted
    );
  }
};
