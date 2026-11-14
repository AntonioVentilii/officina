import type { AgentOutput } from '@officina/core';
import { appendRunEvent, finishRun, setRunExternalId } from '@officina/db';
import { executeRun, type RunReport, type RunnerRole } from '@officina/runner';
import type { ClaimedStep } from './claim';
import type { EngineDependencies, StepResult } from './step';

/** Learning is cheap reading; a cap well below any build keeps it that way. */
const LEARNER_BUDGET_CENTS = 300;

/** Runs the learner in one session on a read-only token, with a brief and the checks its result must pass. */
const runLearner = async (
  deps: EngineDependencies,
  step: ClaimedStep,
  brief: string,
  validate: (output: AgentOutput<RunnerRole>) => Promise<string[]>
): Promise<RunReport> => {
  const { context, agent, runId, repoRef, environmentId } = step;
  const token = await deps.github.installationToken(repoRef, { contents: 'read' });
  return executeRun(deps.agents, {
    role: 'learner',
    brief,
    session: {
      agentId: agent.externalAgentId,
      agentVersion: agent.version,
      environmentId,
      title: `Officina #${context.number} learner`,
      metadata: { task_id: context.task.id, run_id: runId, role: 'learner' },
      repository: {
        url: `https://github.com/${context.repo}`,
        token,
        branch: context.defaultBranch
      },
      budgetCents: LEARNER_BUDGET_CENTS
    },
    validate,
    // Only build runs are failed outside their step (`failTakenOverRuns`); a learner run never is.
    onSessionCreated: async (sessionId) => {
      await setRunExternalId(deps.pool, runId, sessionId);
    },
    onEvent: (event) => appendRunEvent(deps.pool, runId, event.type, event)
  });
};

/**
 * Runs the learner and records its run; `keep` stores a result, `lose` says what a run that ended
 * without one leaves behind. Learning is optional: a failed attempt is never retried or escalated.
 */
export const learnerRun = async (
  deps: EngineDependencies,
  step: ClaimedStep,
  input: {
    /** Built inside the run, so a brief that fails to build still finishes the run as failed. */
    readonly brief: () => Promise<string> | string;
    readonly validate: (output: AgentOutput<RunnerRole>) => Promise<string[]>;
    readonly keep: (output: AgentOutput<'learner'>) => Promise<void>;
    readonly lose: () => Promise<void>;
  }
): Promise<StepResult> => {
  const { pool } = deps;
  const { runId } = step;
  try {
    const report = await runLearner(deps, step, await input.brief(), input.validate);
    if (report.outcome.kind !== 'result') {
      await input.lose();
      await finishRun(pool, runId, {
        status: 'failed',
        costCents: report.costCents,
        result: report.outcome
      });
      return { status: 'discarded', reason: report.outcome.kind };
    }
    const output = report.outcome.output as AgentOutput<'learner'>;
    await input.keep(output);
    await finishRun(pool, runId, {
      status: 'succeeded',
      costCents: report.costCents,
      result: output
    });
    return { status: 'applied' };
  } catch (error) {
    await input.lose();
    await finishRun(pool, runId, {
      status: 'failed',
      costCents: null,
      result: { error: (error as Error).message }
    });
    throw error;
  }
};
