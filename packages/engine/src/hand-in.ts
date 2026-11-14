import { branchForTask, parseProjectConfig, type Task } from '@officina/core';
import {
  appendTaskEvent,
  applyCommand,
  HAND_IN_EVENT,
  loadTaskContext,
  type StoreError
} from '@officina/db';
import type { Pool } from 'pg';
import {
  openTaskPullRequest,
  readPush,
  type PullRequestPort,
  type PushFactsPort
} from './pull-request';
import { titleProblems } from './validators';

export type HandInPort = PullRequestPort & PushFactsPort;

export interface HandIn {
  readonly taskId: string;
  readonly memberId: string;
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

/** The member's push was applied already: the build moved on from `building` and is still theirs. */
const handedIn = (task: Task, memberId: string): boolean =>
  task.stage !== 'building' &&
  task.assignee?.kind === 'member' &&
  task.assignee.memberId === memberId;

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
 * A developer who claimed a build hands in what they pushed to the task branch, built by hand or
 * with their own agents. Officina reads the push from GitHub, applies it as theirs through the
 * same `push` command an agent's build uses (lanes, guardrails, the catalog check), and opens the
 * pull request. Safe to repeat: once the push is applied, a second call only opens the pull
 * request a failed first call left.
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
  if (handedIn(context.task, input.memberId)) {
    const pr = await open();
    return { ok: true, stage: context.task.stage, pullRequest: pr?.number ?? context.pullRequest };
  }
  const facts = await readPush(
    deps.github,
    { installationId, repo: context.repo },
    { base: context.defaultBranch, branch, catalogs: config.docs.standards.catalogs }
  );
  const actor = { kind: 'member' as const, memberId: input.memberId };
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
  return { ok: true, stage: applied.task.stage, pullRequest: pr?.number ?? null };
};
