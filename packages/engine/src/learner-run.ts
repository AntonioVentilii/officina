import { errorText, NO_USAGE, type AgentOutput, type RunUsage } from '@officina/core';
import { appendRunEvent, finishRun, setRunExternalId } from '@officina/db';
import { executeRun, type RunReport, type RunnerRole } from '@officina/runner';
import type { ClaimedStep } from './claim';
import { runBudgetCents } from './spend';
import type { EngineDependencies, StepResult } from './step';
import { roleModel } from './step-model';

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
      model: await roleModel(deps, step, 'learner'),
      environmentId,
      title: `Officina #${context.number} learner`,
      metadata: { task_id: context.task.id, run_id: runId, role: 'learner' },
      repository: {
        url: `https://github.com/${context.repo}`,
        token,
        branch: context.defaultBranch
      },
      // Learning is cheap reading; the role's cap keeps it well below any build.
      budgetCents: runBudgetCents('learner', Infinity)
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
  // Kept for the catch: what the session used still counts when what follows it fails.
  let usage: RunUsage = NO_USAGE;
  try {
    const report = await runLearner(deps, step, await input.brief(), input.validate);
    usage = report.usage;
    if (report.outcome.kind !== 'result') {
      await input.lose();
      await finishRun(pool, runId, {
        status: 'failed',
        usage: report.usage,
        result: report.outcome
      });
      return { status: 'discarded', reason: report.outcome.kind };
    }
    const output = report.outcome.output as AgentOutput<'learner'>;
    await input.keep(output);
    await finishRun(pool, runId, {
      status: 'succeeded',
      usage: report.usage,
      result: output
    });
    return { status: 'applied' };
  } catch (error) {
    await input.lose();
    await finishRun(pool, runId, {
      status: 'failed',
      usage,
      result: { error: errorText(error) }
    });
    throw error;
  }
};
