import { branchForTask, ENGINE, isBuildRole, nextAgentRoles, type Actor } from '@officina/core';
import { applyCommand, finishRun } from '@officina/db';
import { type GitHubClient, type RefSnapshot, type RepoRef } from '@officina/github';
import {
  type ManagedAgentsPort,
  type RunnerRole,
  type RunOutcome,
  type RunReport
} from '@officina/runner';
import type { Pool } from 'pg';
import { claimStep, type ClaimedStep, type SkipReason } from './claim';
import { runLearnerStep } from './learner';
import { taskLink, type SyncGitHubPort } from './github-sync';
import { applyResult, roleOutputOf, type StepOutcome } from './step-apply';
import { gatherInputs, runSession } from './step-session';

export { taskLink };

export type GitHubPort = Pick<
  GitHubClient,
  'installationToken' | 'openPullRequest' | 'refSnapshot' | 'isPullRequestMerge'
> &
  SyncGitHubPort;

export interface EngineDependencies {
  readonly pool: Pool;
  readonly github: GitHubPort;
  readonly agents: ManagedAgentsPort;
  /** Where people open a task, e.g. `https://officina.example`; task links in pull requests use it. */
  readonly publicUrl: string;
  /** Officina's own role prompts, so the learner's edits to them can be checked before people see them. */
  readonly promptsDir?: string | undefined;
}

export type StepResult =
  | { readonly status: 'applied' }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'discarded'; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: SkipReason };

const describeOutcome = (outcome: Exclude<RunOutcome, { kind: 'result' }>): string => {
  switch (outcome.kind) {
    case 'invalid_result':
      return `its result did not match the contract: ${outcome.errors.join('; ')}`;
    case 'no_result':
      return 'it finished without submitting a result';
    case 'budget_reached':
      return 'it reached the spending limit for this step';
    case 'failed':
      return outcome.reason;
  }
};

/**
 * What changed outside the task's own branch while a builder held a token that can write any ref.
 * The default branch may move forward by a pull request merged meanwhile, which went through the
 * branch rules; any other move, and any tag created, moved or deleted, is reported.
 */
const refChanges = async (
  github: GitHubPort,
  ref: RepoRef & { readonly defaultBranch: string },
  before: RefSnapshot,
  after: RefSnapshot
): Promise<string[]> => {
  const changes: string[] = [];
  if (
    before.defaultHead !== after.defaultHead &&
    !(await github.isPullRequestMerge({
      ...ref,
      sha: after.defaultHead,
      base: ref.defaultBranch,
      since: before.defaultHead
    }))
  ) {
    changes.push(
      `${ref.defaultBranch} moved from ${before.defaultHead.slice(0, 7)} to ${after.defaultHead.slice(0, 7)}`
    );
  }
  for (const [tag, sha] of Object.entries(after.tags)) {
    if (!(tag in before.tags)) changes.push(`tag ${tag} was created`);
    else if (before.tags[tag] !== sha) changes.push(`tag ${tag} was moved`);
  }
  for (const tag of Object.keys(before.tags)) {
    if (!(tag in after.tags)) changes.push(`tag ${tag} was deleted`);
  }
  return changes;
};

const blockTask = async (pool: Pool, taskId: string, question: string) => {
  await applyCommand(pool, {
    taskId,
    command: { type: 'block', question, askedOf: { role: 'maintainer' } },
    actor: ENGINE
  });
};

/** One claimed run of a role on a task, and what every phase of the step reads. */
export interface Step extends ClaimedStep {
  readonly deps: EngineDependencies;
  readonly taskId: string;
  readonly role: RunnerRole;
  readonly actor: Actor;
  readonly taskBranch: string;
  readonly builds: boolean;
}

/** Fails the run with what it left and asks a maintainer, so the scheduler does not retry it. */
const failAndBlock = async (
  step: Step,
  run: { readonly costCents: number | null; readonly result: unknown },
  question: string,
  reason: string
): Promise<StepResult> => {
  await finishRun(step.deps.pool, step.runId, { status: 'failed', ...run });
  await blockTask(step.deps.pool, step.taskId, question);
  return { status: 'blocked', reason };
};

/** The refs a builder could have moved besides its own branch, checked after every build run. */
const guardRefs = async (step: Step, before: RefSnapshot, report: RunReport) => {
  const guarded = { ...step.repoRef, defaultBranch: step.context.defaultBranch };
  const after = await step.deps.github.refSnapshot(guarded);
  const changes = await refChanges(step.deps.github, guarded, before, after);
  if (!changes.length) return null;
  const { role, taskBranch } = step;
  return failAndBlock(
    step,
    { costCents: report.costCents, result: { refsChanged: changes, outcome: report.outcome } },
    `While the ${role} ran, ${changes.join('; ')}. The ${role} may only push ${taskBranch}. Check those refs on GitHub and restore them if the ${role} changed them; if a person made the change, answer to run the build again.`,
    `refs outside ${taskBranch} changed during the build: ${changes.join('; ')}`
  );
};

/** The result to apply, or why the run left none: no valid result, or a push to the wrong branch. */
const outcomeOf = async (
  step: Step,
  report: RunReport
): Promise<StepOutcome | { readonly reason: string; readonly result: unknown }> => {
  const { outcome, costCents } = report;
  if (outcome.kind !== 'result') return { reason: describeOutcome(outcome), result: outcome };
  const roleOutput = await roleOutputOf(step, outcome.output);
  if ('wrongBranch' in roleOutput) {
    const reason = `it pushed to ${roleOutput.wrongBranch} instead of ${step.taskBranch}`;
    return { reason, result: outcome.output };
  }
  return { output: outcome.output, roleOutput, costCents };
};

/** From the session to the applied result, for a run already claimed. */
const runClaimed = async (step: Step): Promise<StepResult> => {
  const inputs = await gatherInputs(step);
  const { github } = step.deps;
  // Only the build roles get a token that can push; every other role reads.
  const token = await github.installationToken(step.repoRef, {
    contents: step.builds ? 'write' : 'read'
  });
  // Taken before the session starts, so nothing the builder does can land before it.
  const refsBefore = step.builds
    ? await github.refSnapshot({ ...step.repoRef, defaultBranch: step.context.defaultBranch })
    : null;
  const report = await runSession(step, inputs, token);
  // Checked whatever the run reported: a failed run may still have pushed somewhere.
  const moved = refsBefore ? await guardRefs(step, refsBefore, report) : null;
  if (moved) return moved;
  const outcome = await outcomeOf(step, report);
  if ('reason' in outcome) {
    return failAndBlock(
      step,
      { costCents: report.costCents, result: outcome.result },
      `The ${step.role} agent could not complete its step: ${outcome.reason}.`,
      outcome.reason
    );
  }
  return applyResult(step, outcome, inputs);
};

/** Runs one agent role for one task, from claiming the run to applying (or discarding) its result. */
export const runAgentStep = async (
  deps: EngineDependencies,
  taskId: string,
  role: RunnerRole
): Promise<StepResult> => {
  if (role === 'learner') return runLearnerStep(deps, taskId);
  const claimed = await claimStep(deps.pool, {
    taskId,
    role,
    isDue: (context) => nextAgentRoles(context.task).includes(role)
  });
  if (!claimed.ok) return { status: 'skipped', reason: claimed.reason };
  const step: Step = {
    ...claimed.step,
    deps,
    taskId,
    role,
    actor: { kind: 'agent', role, version: claimed.step.agent.version },
    taskBranch: branchForTask(claimed.step.context.number),
    builds: isBuildRole(role)
  };
  try {
    return await runClaimed(step);
  } catch (error) {
    const message = (error as Error).message;
    await finishRun(deps.pool, step.runId, {
      status: 'failed',
      costCents: null,
      result: { error: message }
    });
    // Blocking stops the scheduler from retrying a step that fails the same way every time;
    // answering the question retries it.
    await blockTask(
      deps.pool,
      taskId,
      `The ${role} step failed unexpectedly: ${message}. Answer this question to retry it.`
    ).catch(() => {});
    throw error;
  }
};
