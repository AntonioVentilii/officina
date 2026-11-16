import {
  branchForTask,
  memberActor,
  parseProjectConfig,
  type ConnectedApp,
  type Stage,
  type Task
} from '@officina/core';
import {
  appendTaskEvent,
  applyCommand,
  HAND_IN_EVENT,
  loadTask,
  loadTaskContext,
  type StoreError
} from '@officina/db';
import type { GitHubClient } from '@officina/github';
import type { Pool } from 'pg';
import {
  openTaskPullRequest,
  readPush,
  sendBackRedChecks,
  type PullRequestPort,
  type PushFactsPort
} from './pull-request';
import { titleProblems } from './validators';

export type HandInPort = PullRequestPort & PushFactsPort & Pick<GitHubClient, 'failedChecks'>;

export interface HandIn {
  readonly taskId: string;
  readonly memberId: string;
  /** The connected app the member handed it in through, absent from the board or the CLI. */
  readonly via?: ConnectedApp | undefined;
  /** The pull request title, in the repository's own format. */
  readonly prTitle: string;
  readonly verified: readonly string[];
  readonly notVerified: readonly string[];
}

export type HandInResult =
  | { readonly ok: true; readonly stage: string; readonly pullRequest: number | null }
  | { readonly ok: false; readonly error: StoreError | 'not_installed' }
  /** The title breaks the project's `pull_request.title_pattern`, as an agent's would. */
  | { readonly ok: false; readonly error: 'bad_title'; readonly problems: readonly string[] };

const theirs = (task: Task, memberId: string): boolean =>
  task.assignee?.kind === 'member' && task.assignee.memberId === memberId;

/** The member's push was applied already: the build moved on from `building` and is still theirs. */
const handedIn = (task: Task, memberId: string): boolean =>
  task.stage !== 'building' && theirs(task, memberId);

type ChecksInput = Parameters<typeof sendBackRedChecks>[2];

/** Where a hand-in reads from, or why it cannot. */
const handInSource = async (pool: Pool, taskId: string) => {
  const context = await loadTaskContext(pool, taskId);
  if (!context) return { ok: false as const, error: 'not_found' as const };
  if (context.installationId === null)
    return { ok: false as const, error: 'not_installed' as const };
  const config = parseProjectConfig(context.rawConfig);
  if (!config.ok) return { ok: false as const, error: 'invalid_config' as const };
  return {
    ok: true as const,
    context,
    installationId: context.installationId,
    config: config.config
  };
};

/**
 * Where a push handed in ends: back at the build when its checks were already red. When the task
 * moved while they were read, where it is now.
 */
const stageAfterChecks = async (
  deps: { readonly pool: Pool; readonly github: HandInPort },
  input: ChecksInput,
  task: Task
): Promise<Stage> => {
  const sentBack = await sendBackRedChecks(deps.pool, deps.github, input, task);
  if (!sentBack) return task.stage;
  if (sentBack.ok) return sentBack.task.stage;
  return (await loadTask(deps.pool, input.taskId))?.task.stage ?? task.stage;
};

/**
 * A head the member's build already holds, still on the branch with its checks still red: taken in
 * again it would only be sent back once more, spending a fix round. So a hand-in repeated after
 * its red checks sent it back changes nothing.
 */
const sentBackRed = async (
  github: HandInPort,
  input: ChecksInput & { readonly task: Task; readonly memberId: string; readonly head: string }
): Promise<boolean> =>
  input.task.stage === 'building' &&
  theirs(input.task, input.memberId) &&
  input.task.headSha === input.head &&
  (await github.failedChecks({ ...input.ref, sha: input.head, branch: input.branch })).length > 0;

/**
 * A developer who claimed a build hands in what they pushed to the task branch, built by hand or
 * with their own agents. Officina reads the push from GitHub, applies it as theirs through the
 * same `push` command an agent's build uses (lanes, guardrails, the catalog check), opens the
 * pull request, and sends it back to them when its checks were red before it was handed in. Safe
 * to repeat: once the push is applied, a second call only opens the pull request a failed first
 * call left and reads the checks again, and a head already sent back for red checks is not taken
 * in again while they stay red.
 */
export const handInBuild = async (
  deps: { readonly pool: Pool; readonly github: HandInPort; readonly publicUrl: string },
  input: HandIn
): Promise<HandInResult> => {
  const source = await handInSource(deps.pool, input.taskId);
  if (!source.ok) return source;
  const { context, installationId, config } = source;
  const branch = branchForTask(context.number);
  const built = {
    outcome: 'pushed' as const,
    branch,
    prTitle: input.prTitle,
    verified: [...input.verified],
    notVerified: [...input.notVerified]
  };
  // A person's title meets the same rule as an agent's: nothing is applied until it does.
  const problems = titleProblems(config.pullRequest.titlePattern)(built);
  if (problems.length) return { ok: false, error: 'bad_title', problems };
  const open = () =>
    openTaskPullRequest(deps.pool, deps.github, {
      taskId: input.taskId,
      publicUrl: deps.publicUrl,
      built
    });
  const checks = { taskId: input.taskId, ref: { installationId, repo: context.repo }, branch };
  if (handedIn(context.task, input.memberId)) {
    const pr = await open();
    const stage = await stageAfterChecks(deps, checks, context.task);
    return { ok: true, stage, pullRequest: pr?.number ?? context.pullRequest };
  }
  const facts = await readPush(deps.github, checks.ref, {
    base: context.defaultBranch,
    branch,
    catalogs: config.docs.standards.catalogs
  });
  const held = { task: context.task, memberId: input.memberId, head: facts.headSha };
  if (await sentBackRed(deps.github, { ...checks, ...held })) {
    return { ok: true, stage: context.task.stage, pullRequest: context.pullRequest };
  }
  const actor = memberActor(input.memberId, input.via);
  const applied = await applyCommand(deps.pool, {
    taskId: input.taskId,
    command: { type: 'push', ...facts },
    actor,
    // With the push, so a pull request that fails to open is opened later from this title and
    // these checks, not from an earlier agent round's.
    onApplied: (client) =>
      appendTaskEvent(client, { taskId: input.taskId, actor, type: HAND_IN_EVENT, payload: built })
  });
  if (!applied.ok) return applied;
  const pr = await open();
  const stage = await stageAfterChecks(deps, checks, applied.task);
  return { ok: true, stage, pullRequest: pr?.number ?? null };
};
