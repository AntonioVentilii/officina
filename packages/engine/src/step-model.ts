import { failedAttempts, latestPush, predictedPaths, recordRunModel } from '@officina/db';
import { PINNED_RESOLVER, ROLE_MODELS, type AgentModel, type RunnerRole } from '@officina/runner';
import type { ClaimedStep } from './claim';
import { chooseModel, type StepModel, type StepSignals } from './model-choice';
import type { EngineDependencies, Step } from './step';

/** What the rule reads about a step: the task, the project's config and the task's earlier runs. */
const signalsFor = async (step: Step): Promise<StepSignals> => {
  const { pool } = step.deps;
  const { task } = step.context;
  const [push, predicted, failed] = await Promise.all([
    latestPush(pool, step.taskId),
    predictedPaths(pool, step.taskId),
    failedAttempts(pool, step.taskId, step.role)
  ]);
  return {
    role: step.role,
    lane: task.lane,
    guards: task.guards,
    paths: push ? push.changedPaths : predicted,
    diffLines: push?.diffLines ?? null,
    strongPaths: step.config.models.strongPaths,
    fixRounds: task.fixRounds,
    failedAttempts: failed,
    forcedTier: task.forcedModel
  };
};

/** The choice with its tier resolved to an id, recorded on the run before its session starts. */
const settle = async (
  deps: EngineDependencies,
  runId: string,
  choice: StepModel
): Promise<AgentModel> => {
  const { id } = await (deps.models ?? PINNED_RESOLVER).resolve(choice.tier);
  await recordRunModel(deps.pool, runId, {
    model: id,
    effort: choice.effort,
    reason: choice.reason
  });
  return { id, effort: choice.effort };
};

/** The model a step's session runs at, chosen from the task by `chooseModel`. */
export const modelForStep = async (step: Step): Promise<AgentModel> =>
  settle(step.deps, step.runId, chooseModel(await signalsFor(step)));

/** A role's own model, for a run nothing about the task should change (the learner). */
export const roleModel = (
  deps: EngineDependencies,
  step: ClaimedStep,
  role: RunnerRole
): Promise<AgentModel> =>
  settle(deps, step.runId, { ...ROLE_MODELS[role], reason: 'role default' });
