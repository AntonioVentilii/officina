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
  type ProjectConfig,
  type PushFacts,
  type Task
} from '@officina/core';
import {
  applyCommand,
  expectedHead,
  recordHeadCarried,
  type ApplyResult,
  latestBuild,
  linkPullRequest,
  loadTaskContext,
  stillRunning,
  type StoredTaskContext
} from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import type { Pool } from 'pg';
import { cancelTaskAutoMerge, stopAutoMergeOnLeaving } from './auto-merge';
import { eachTaskOnItsOwn, type TaskFailure } from './each-task';
import {
  implementedStatus,
  recordOwnStatusCommit,
  specPathIn,
  syncSpecStatus,
  taskLink,
  type SyncGitHubPort
} from './github-sync';

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
  if (!run || stillRunning(run)) return null;
  const built = run.result as Partial<PushedBuild> | null;
  return built?.outcome === 'pushed' && built.prTitle ? (built as PushedBuild) : null;
};

const bullets = (items: readonly string[]) =>
  items.map((item) => `- ${item}`).join('\n') || '- nothing reported';

/**
 * What the build wrote for the body: in the project's pull request template when it gave one (the
 * template's sections first, Officina's link after a rule), else Officina's own shape.
 */
const builtSections = (link: string, built: PushedBuild): string[] => {
  const source = `Implements the approved spec of ${link}.`;
  return built.prBody
    ? [built.prBody, `---\n\n${source}`]
    : [
        source,
        `Verified:\n${bullets(built.verified)}`,
        `Not verified:\n${bullets(built.notVerified)}`
      ];
};

const pullRequestBody = (link: string, built: PushedBuild, issue: number | null) =>
  [
    ...builtSections(link, built),
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
): Promise<TaskFailure[]> =>
  eachTaskOnItsOwn(taskIds, async (taskId) => {
    if (!awaitsPullRequest(await loadTaskContext(pool, taskId))) return;
    // A step still running opens its own pull request.
    const built = recordedPush(await latestBuild(pool, taskId, BUILD_ROLES));
    if (!built) return;
    await openTaskPullRequest(pool, github, { taskId, publicUrl, built });
  });

/** A task whose open pull request holds a head Officina took in, which someone else may move. */
type MovableContext = StoredTaskContext & { pullRequest: number; installationId: number };

const movableFromOutside = (context: StoredTaskContext | null): context is MovableContext =>
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
  Pick<
    GitHubClient,
    'pullRequest' | 'failedChecks' | 'cancelAutoMerge' | 'changeOf' | 'commitChanges'
  >;

/**
 * Sends a head that just reached review back to the builder when its checks are already red:
 * GitHub reported them before any task held that commit (a push from outside, a hand-in, or a
 * build whose checks failed before its push was applied), and nothing will report them again.
 * `null` when the head did not reach review or nothing failed on it.
 */
export const sendBackRedChecks = async (
  pool: Pool,
  github: Pick<GitHubClient, 'failedChecks'>,
  input: { readonly taskId: string; readonly ref: RepoRef; readonly branch: string },
  task: Task
): Promise<ApplyResult | null> => {
  if (task.stage !== 'reviewing' || !task.headSha) return null;
  const headSha = task.headSha;
  const failures = await github.failedChecks({ ...input.ref, sha: headSha, branch: input.branch });
  if (failures.length === 0) return null;
  return applyCommand(pool, {
    taskId: input.taskId,
    command: { type: 'ci_failed', headSha, details: failures.join('; ') },
    actor: ENGINE
  });
};

/**
 * What follows a head taken in: auto-merge off if the task left `merging`, since GitHub would land
 * the new head once its checks pass, and the checks already red on it sent to the builder.
 */
const afterAdoption = async (
  pool: Pool,
  github: AdoptPort,
  input: { taskId: string; ref: RepoRef; pullRequest: number; branch: string },
  adopted: ApplyResult
) => {
  await stopAutoMergeOnLeaving(pool, github, input, adopted);
  if (adopted.ok) await sendBackRedChecks(pool, github, input, adopted.task);
};

/**
 * Whether a new head carries exactly the change of the one people verified, file by file with the
 * same content: an update from the default branch that touched none of the change's files. When
 * GitHub may have cut either list, nothing can be said and the answer is no.
 */
const sameChange = async (
  github: AdoptPort,
  ref: RepoRef,
  input: { base: string; verified: string; head: string }
): Promise<boolean> => {
  const verified = await github.changeOf({ ...ref, base: input.base, head: input.verified });
  if (verified === null) return false;
  return verified === (await github.changeOf({ ...ref, base: input.base, head: input.head }));
};

/**
 * Keeps the review and the verification for a new head with the same change, recorded as
 * `head_carried` so it stands for the task's head: feedback on it counts for the task, and at
 * merging the approval and the merge are done again for it. At merging, auto-merge pinned to the
 * old commit is turned off first and the carry waits for the next pass when GitHub refuses, so an
 * auto-merge nobody confirmed off never lands the new head. Checks already red on it still send
 * the work back.
 */
const carryHead = async (
  pool: Pool,
  github: AdoptPort,
  input: { context: MovableContext; ref: RepoRef; headSha: string; from: string }
) => {
  const { context, ref } = input;
  const { task } = context;
  if (!task.headSha) return;
  if (task.stage === 'merging') {
    const off = await cancelTaskAutoMerge(pool, github, {
      id: task.id,
      ...ref,
      pullRequest: context.pullRequest
    }).then(
      () => true,
      () => false
    );
    if (!off) return;
  }
  const carried = await recordHeadCarried(pool, {
    taskId: task.id,
    stage: task.stage,
    taskHead: task.headSha,
    from: input.from,
    headSha: input.headSha
  });
  if (!carried) return;
  const failures = await github.failedChecks({
    ...ref,
    sha: input.headSha,
    branch: branchForTask(context.number)
  });
  if (failures.length === 0) return;
  const result = await applyCommand(pool, {
    taskId: task.id,
    command: { type: 'ci_failed', headSha: task.headSha, details: failures.join('; ') },
    actor: ENGINE
  });
  await stopAutoMergeOnLeaving(
    pool,
    github,
    { taskId: task.id, ref, pullRequest: context.pullRequest },
    result
  );
};

/**
 * The branch head to take in from outside, or `null` when there is none: the head is the expected
 * one after all, or the Implemented status commit an earlier pass wrote at merging but never
 * recorded (its answer lost, or the process gone right after the write), which is recorded now as
 * the task's head instead, so the verified task is not sent back for Officina's own commit.
 */
const outsideHead = async (
  pool: Pool,
  github: AdoptPort,
  input: { context: MovableContext; ref: RepoRef; expected: string; config: ProjectConfig }
): Promise<(PushFacts & { readonly catalogPages: CatalogPages }) | null> => {
  const { context, config } = input;
  const head = await readPush(github, input.ref, {
    base: context.defaultBranch,
    branch: branchForTask(context.number),
    catalogs: config.docs.standards.catalogs
  });
  if (head.headSha === input.expected) return null;
  const path = specPathIn(head.changedPaths, config.docs.specDir);
  if (context.task.stage !== 'merging' || !path) return head;
  const own = await recordOwnStatusCommit(pool, github, {
    taskId: context.task.id,
    ref: input.ref,
    status: implementedStatus(context.pullRequest),
    head: head.headSha,
    expected: input.expected,
    path,
    at: { stage: context.task.stage, headSha: context.task.headSha }
  });
  return own ? null : head;
};

const adoptOutsidePush = async (pool: Pool, github: AdoptPort, taskId: string) => {
  const context = await loadTaskContext(pool, taskId);
  if (!movableFromOutside(context)) return;
  const { task } = context;
  const build = await latestBuild(pool, taskId, BUILD_ROLES);
  if (build && stillRunning(build)) return;
  const ref = { installationId: context.installationId, repo: context.repo };
  const expected = await expectedHead(pool, taskId);
  const prHead = (await github.pullRequest({ ...ref, pullRequest: context.pullRequest })).head.sha;
  if (!expected || prHead === expected) return;
  const base = context.defaultBranch;
  if (await sameChange(github, ref, { base, verified: expected, head: prHead })) {
    await carryHead(pool, github, { context, ref, headSha: prHead, from: expected });
    return;
  }
  const config = parseProjectConfig(context.rawConfig);
  if (!config.ok) return;
  const head = await outsideHead(pool, github, { context, ref, expected, config: config.config });
  if (!head) return;
  const branch = branchForTask(context.number);
  const adopted = await applyCommand(pool, {
    taskId,
    command: { type: 'outside_push', ...head },
    actor: ENGINE,
    guard: (current) => current.stage === task.stage && current.headSha === task.headSha
  });
  await afterAdoption(
    pool,
    github,
    { taskId, ref, pullRequest: context.pullRequest, branch },
    adopted
  );
};

/** Each task on its own; the failures are returned for the log and tried again on the next pass. */
export const adoptOutsidePushes = async (
  pool: Pool,
  github: AdoptPort,
  taskIds: readonly string[]
): Promise<TaskFailure[]> =>
  eachTaskOnItsOwn(taskIds, (taskId) => adoptOutsidePush(pool, github, taskId));
