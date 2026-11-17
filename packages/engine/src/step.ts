import {
  branchForTask,
  ENGINE,
  errorText,
  isBuildRole,
  nextAgentRoles,
  type Actor,
  type Task
} from '@officina/core';
import { applyCommand, finishRun } from '@officina/db';
import { type GitHubClient } from '@officina/github';
import {
  type ManagedAgentsPort,
  type RunnerRole,
  type RunOutcome,
  type RunReport
} from '@officina/runner';
import type { Pool, PoolClient } from 'pg';
import { claimStep, type ClaimedStep, type SkipReason } from './claim';
import { runLearnerStep } from './learner';
import type { SyncGitHubPort } from './github-sync';
import { applyResult, roleOutputOf, sameWork, type StepOutcome } from './step-apply';
import { withRunToken, type LiveRuns } from './live-runs';
import { guardRefs, recordStartingRefs } from './step-refs';
import { gatherInputs, runSession, RunStoppedError } from './step-session';

export type GitHubPort = Pick<
  GitHubClient,
  | 'installationToken'
  | 'runToken'
  | 'revokeToken'
  | 'openPullRequest'
  | 'refSnapshot'
  | 'refActivity'
  | 'appBotLogin'
  | 'isPullRequestMerge'
  | 'isOnBranch'
  | 'failedChecks'
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
  /** The sessions and run tokens of this process, for a shutdown to stop (`createLiveRuns`). */
  readonly liveRuns?: LiveRuns | undefined;
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

/** Asks a maintainer; with a `guard`, only while the task is still in the state it allows. */
const blockTask = (
  pool: Pool,
  taskId: string,
  question: string,
  guard?: (task: Task, client: PoolClient) => Promise<boolean>
) =>
  applyCommand(pool, {
    taskId,
    command: { type: 'block', question, askedOf: { role: 'maintainer' } },
    actor: ENGINE,
    ...(guard ? { guard } : {})
  });

/** One claimed run of a role on a task, and what every phase of the step reads. */
export interface Step extends ClaimedStep {
  readonly deps: EngineDependencies;
  readonly taskId: string;
  readonly role: RunnerRole;
  readonly actor: Actor;
  readonly taskBranch: string;
  readonly builds: boolean;
}

/**
 * Asks a maintainer and fails the run with what it left, so the scheduler does not retry it. Only
 * on the work the run saw, as for a result: a build a member took over is not blocked by the run
 * it replaced. Blocked first, while the run is still in progress, as the guard requires.
 */
const failAndBlock = async (
  step: Step,
  run: { readonly costCents: number | null; readonly result: unknown },
  question: string,
  reason: string
): Promise<StepResult> => {
  const blocked = await blockTask(
    step.deps.pool,
    step.taskId,
    question,
    sameWork(step.context.task, step.runId)
  );
  await finishRun(step.deps.pool, step.runId, { status: 'failed', ...run });
  return blocked.ok ? { status: 'blocked', reason } : { status: 'discarded', reason };
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
  // Before the token is minted: nothing can push until then, and nothing is left to revoke if
  // reading the refs fails.
  const refsBefore = step.builds ? await recordStartingRefs(step, Date.now()) : null;
  let report: RunReport;
  try {
    report = await withRunToken(step, (token, live) => runSession(step, inputs, token, live));
  } catch (error) {
    // A session that throws may have pushed somewhere too, and its retry starts from the refs as
    // they are then: they are checked now or never.
    const result = { error: errorText(error) };
    const moved = refsBefore
      ? await guardRefs(step, refsBefore, { costCents: null, result })
      : null;
    if (moved) return moved;
    throw error;
  }
  // Checked whatever the run reported: a failed run may still have pushed somewhere.
  const moved = refsBefore
    ? await guardRefs(step, refsBefore, {
        costCents: report.costCents,
        result: { outcome: report.outcome }
      })
    : null;
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
    // Failed already, by whoever stopped it, with the reason recorded on the run.
    if (error instanceof RunStoppedError) return { status: 'discarded', reason: error.message };
    const message = errorText(error);
    // Blocking stops the scheduler from retrying a step that fails the same way every time;
    // answering the question retries it. Blocked first, while the run is still in progress.
    await blockTask(
      deps.pool,
      taskId,
      `The ${role} step failed unexpectedly: ${message}. Answer this question to retry it.`,
      sameWork(step.context.task, step.runId)
    ).catch(() => {});
    await finishRun(deps.pool, step.runId, {
      status: 'failed',
      costCents: null,
      result: { error: message }
    });
    throw error;
  }
};
