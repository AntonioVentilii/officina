import {
  branchForTask,
  buildsTask,
  memberActor,
  parseProjectConfig,
  type ConnectedApp,
  type Stage,
  type Task
} from '@officina/core';
import {
  appendTaskEvent,
  applyCommand,
  claimHandIn,
  HAND_IN_EVENT,
  holdHandIn,
  loadProjectMember,
  loadTask,
  loadTaskContext,
  releaseHandIn,
  type StoreError,
  type StoredTaskContext
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
import { bodyProblems, readPrTemplate } from './pr-template';
import { titleProblems } from './validators';

export type HandInPort = PullRequestPort & PushFactsPort & Pick<GitHubClient, 'failedChecks'>;

export interface HandIn {
  readonly taskId: string;
  readonly memberId: string;
  /** The connected app the member handed it in through, absent from the board or the CLI. */
  readonly via?: ConnectedApp | undefined;
  /** The pull request title, in the repository's own format. */
  readonly prTitle: string;
  /** The pull request body, required in the sections of the project's template when it has one. */
  readonly prBody?: string | undefined;
  readonly verified: readonly string[];
  readonly notVerified: readonly string[];
}

export type HandInResult =
  | { readonly ok: true; readonly stage: string; readonly pullRequest: number | null }
  /** `handing_in`: another hand-in of the task is under way, on a board or from the CLI. */
  | { readonly ok: false; readonly error: StoreError | 'not_installed' | 'handing_in' }
  /**
   * The title breaks the project's `pull_request.title_pattern`, or the body leaves its pull request
   * template out, as an agent's would.
   */
  | {
      readonly ok: false;
      readonly error: 'bad_pull_request';
      readonly problems: readonly string[];
    };

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

type Source = Extract<Awaited<ReturnType<typeof handInSource>>, { ok: true }>;

/** What the member hands in, as the builder's pushed result. */
const builtFrom = (input: HandIn, branch: string) => ({
  outcome: 'pushed' as const,
  branch,
  prTitle: input.prTitle,
  ...(input.prBody ? { prBody: input.prBody } : {}),
  verified: [...input.verified],
  notVerified: [...input.notVerified]
});

/**
 * A person's title and body meet the same rules as an agent's (the title pattern, the pull request
 * template), so nothing is applied until they do.
 */
const pullRequestProblems = async (
  github: HandInPort,
  source: Source,
  built: ReturnType<typeof builtFrom>
): Promise<string[]> => {
  const { context, config } = source;
  const template = await readPrTemplate(
    github,
    { installationId: source.installationId, repo: context.repo },
    { path: config.docs.prTemplate, branch: context.defaultBranch }
  );
  return [
    ...titleProblems(config.pullRequest.titlePattern)(built),
    ...bodyProblems(template)(built)
  ];
};

/**
 * A hand-in repeated once its push was applied: it opens the pull request a failed first call left
 * and reads the checks again. No lifecycle command runs here, so whoever may no longer build the
 * task, as `push` requires, opens nothing.
 */
const handInAgain = async (
  deps: { readonly pool: Pool; readonly github: HandInPort },
  input: {
    readonly context: Pick<StoredTaskContext, 'projectId' | 'task' | 'pullRequest'>;
    readonly memberId: string;
    readonly checks: ChecksInput;
    readonly open: () => ReturnType<typeof openTaskPullRequest>;
  }
): Promise<HandInResult> => {
  const { context } = input;
  const builder = await loadProjectMember(deps.pool, context.projectId, input.memberId);
  if (!builder || !buildsTask(builder, context.task)) return { ok: false, error: 'not_allowed' };
  const pr = await input.open();
  const stage = await stageAfterChecks(deps, input.checks, context.task);
  return { ok: true, stage, pullRequest: pr?.number ?? context.pullRequest };
};

/** What a hand-in that lost its claim to another one answers: that one goes on, this one stops. */
const TAKEN_OVER = { ok: false, error: 'handing_in' } as const;

/**
 * A hand-in under its claim, as `handInBuild` describes. `held` renews the claim before each
 * GitHub call and before the push is applied, and says whether it is still this hand-in's.
 */
const handInClaimed = async (
  deps: { readonly pool: Pool; readonly github: HandInPort; readonly publicUrl: string },
  input: HandIn,
  source: Source,
  held: () => Promise<boolean>
): Promise<HandInResult> => {
  const { context, installationId, config } = source;
  const branch = branchForTask(context.number);
  const built = builtFrom(input, branch);
  const problems = await pullRequestProblems(deps.github, source, built);
  if (problems.length) return { ok: false, error: 'bad_pull_request', problems };
  // A pull request a hand-in that lost its claim did not open is opened by the one that took over.
  const open = async () =>
    (await held())
      ? openTaskPullRequest(deps.pool, deps.github, {
          taskId: input.taskId,
          publicUrl: deps.publicUrl,
          built
        })
      : null;
  const checks = { taskId: input.taskId, ref: { installationId, repo: context.repo }, branch };
  if (handedIn(context.task, input.memberId))
    return handInAgain(deps, { context, memberId: input.memberId, checks, open });
  if (!(await held())) return TAKEN_OVER;
  const facts = await readPush(deps.github, checks.ref, {
    base: context.defaultBranch,
    branch,
    catalogs: config.docs.standards.catalogs
  });
  const pushed = { task: context.task, memberId: input.memberId, head: facts.headSha };
  if (await sentBackRed(deps.github, { ...checks, ...pushed })) {
    return { ok: true, stage: context.task.stage, pullRequest: context.pullRequest };
  }
  if (!(await held())) return TAKEN_OVER;
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
  // Only the member whose build it is hands it in, checked before the claim so nobody else makes
  // every board show a hand-in; the push command checks it again, for a build taken meanwhile.
  if (!theirs(source.context.task, input.memberId)) return { ok: false, error: 'not_allowed' };
  // One hand-in at a time: the second is refused plainly, and every board shows the first at work.
  const claim = await claimHandIn(deps.pool, input.taskId, input.memberId);
  if (!claim) return { ok: false, error: 'handing_in' };
  try {
    return await handInClaimed(deps, input, source, () =>
      holdHandIn(deps.pool, input.taskId, claim)
    );
  } finally {
    await releaseHandIn(deps.pool, input.taskId, claim);
  }
};
