import { parseProjectConfig } from '@officina/core';
import {
  findTaskIdByNumber,
  loadTaskContext,
  predictedPaths,
  resolveProjectId,
  tasksBuildingSince
} from '@officina/db';
import {
  TrialError,
  firstBuildChoice,
  planTrialBuild,
  runTrialBuild,
  type TrialGitHub,
  type TrialPlan,
  type TrialReport
} from '@officina/engine';
import {
  PROMPTS_DIR,
  isTrialArm,
  measureSession,
  readSession,
  trialBuilders,
  type ManagedAgentsPort,
  type TierModels,
  type SessionMeasure,
  type TrialArm
} from '@officina/runner';
import type { Pool } from 'pg';

interface TrialBuildInput {
  readonly repo?: string | undefined;
  readonly number: number;
  readonly base: string;
  readonly arm: TrialArm;
  readonly attempt: number;
  readonly budgetCents: number;
  readonly promptsDir: string;
  readonly models: TierModels;
}

const trialInput = async (pool: Pool, input: TrialBuildInput) => {
  const projectId = await resolveProjectId(pool, input.repo);
  if (!projectId) throw new TrialError('project not found: pass --repo <owner/name>');
  const taskId = await findTaskIdByNumber(pool, projectId, input.number);
  const context = taskId ? await loadTaskContext(pool, taskId) : null;
  if (!taskId || !context) throw new TrialError(`task #${input.number} not found`);
  const config = parseProjectConfig(context.rawConfig);
  if (!config.ok) throw new TrialError("the project's config does not parse");
  const definition = (await trialBuilders(input.promptsDir, input.models))[input.arm];
  const choice = firstBuildChoice(context, config.config, await predictedPaths(pool, taskId));
  const model = { id: input.models[choice.tier], effort: choice.effort, reason: choice.reason };
  return {
    projectId,
    trial: { ...input, context, config: config.config, definition, model }
  };
};

/** What a trial would run, its brief included, with nothing written and nothing spent. */
const planTrial = async (
  pool: Pool,
  github: Pick<TrialGitHub, 'readFile'>,
  input: TrialBuildInput
): Promise<TrialPlan> => {
  const { prTemplate: _template, ...plan } = await planTrialBuild(
    github,
    (await trialInput(pool, input)).trial
  );
  return plan;
};

/**
 * Runs one arm of a trial, refused while a build of the project is running: its ref check would
 * take the trial's push for its own. Nothing stops the scheduler from starting one meanwhile, so
 * the builds that ran beside the trial are asked again once it ends and named among its problems;
 * the workflow has a person pause the project's tasks first.
 */
const runTrial = async (
  pool: Pool,
  deps: { readonly github: TrialGitHub; readonly agents: ManagedAgentsPort },
  input: TrialBuildInput
): Promise<TrialReport> => {
  const { projectId, trial } = await trialInput(pool, input);
  const started = new Date();
  const building = await tasksBuildingSince(pool, projectId, started);
  if (building.length > 0) {
    throw new TrialError(
      `wait for the builds of ${numbers(building)} to end: their ref check would count the trial's push`
    );
  }
  const report = await runTrialBuild(deps, trial);
  const beside = await tasksBuildingSince(pool, projectId, started);
  return {
    ...report,
    problems: [
      ...report.problems,
      ...(beside.length > 0
        ? [`builds of ${numbers(beside)} ran beside the trial: their ref check may have held them`]
        : [])
    ]
  };
};

const numbers = (tasks: readonly number[]): string => tasks.map((n) => `#${n}`).join(', ');

/** The flags the trial commands read, as the command line gave them. */
export interface TrialFlags {
  readonly repo?: string | undefined;
  readonly number?: string | undefined;
  readonly base?: string | undefined;
  readonly arm?: string | undefined;
  readonly attempt?: string | undefined;
  readonly 'budget-usd'?: string | undefined;
  readonly session?: string | undefined;
  readonly run?: boolean | undefined;
}

const required = (value: string | undefined, flag: string): string => {
  if (!value) throw new TrialError(`missing --${flag}`);
  return value;
};

const positive = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new TrialError(`--${flag} must be a positive whole number`);
  return parsed;
};

/** A dollar amount such as `0.50` or `8`, in whole cents, as a session budget takes it. */
const centsOf = (value: string): number => {
  const dollars = Number(value);
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || cents < 1)
    throw new TrialError('--budget-usd must be a dollar amount of at least 0.01');
  return cents;
};

/**
 * `trial-build` (a plan without `--run`, the run itself with it) and `trial-measure`, from the
 * command line's flags. The clients are built only for the command that needs them.
 */
export const trialCommand = async (
  pool: Pool,
  deps: {
    readonly agents: ManagedAgentsPort;
    readonly github: () => TrialGitHub;
    readonly models: () => Promise<TierModels>;
  },
  command: 'trial-build' | 'trial-measure',
  flags: TrialFlags
): Promise<TrialPlan | TrialReport | SessionMeasure> => {
  if (command === 'trial-measure') {
    return measureSession(await readSession(deps.agents, required(flags.session, 'session')));
  }
  const arm = required(flags.arm, 'arm');
  if (!isTrialArm(arm)) throw new TrialError('--arm must be reader or solo');
  const input = {
    repo: flags.repo,
    number: positive(required(flags.number, 'number'), 'number'),
    base: required(flags.base, 'base'),
    arm,
    attempt: positive(flags.attempt ?? '1', 'attempt'),
    budgetCents: centsOf(required(flags['budget-usd'], 'budget-usd')),
    promptsDir: PROMPTS_DIR,
    models: await deps.models()
  };
  return flags.run
    ? runTrial(pool, { github: deps.github(), agents: deps.agents }, input)
    : planTrial(pool, deps.github(), input);
};
