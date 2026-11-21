import { parseProjectConfig } from '@officina/core';
import {
  findTaskIdByNumber,
  loadTaskContext,
  resolveProjectId,
  tasksBuildingNow
} from '@officina/db';
import {
  TrialError,
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
  type ModelTier,
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
  readonly models: Readonly<Record<ModelTier, string>>;
}

const trialInput = async (pool: Pool, input: TrialBuildInput) => {
  const projectId = await resolveProjectId(pool, input.repo);
  if (!projectId) throw new TrialError('project not found: pass --repo <owner/name>');
  const taskId = await findTaskIdByNumber(pool, projectId, input.number);
  const context = taskId ? await loadTaskContext(pool, taskId) : null;
  if (!context) throw new TrialError(`task #${input.number} not found`);
  const config = parseProjectConfig(context.rawConfig);
  if (!config.ok) throw new TrialError("the project's config does not parse");
  const definition = (await trialBuilders(input.promptsDir, input.models))[input.arm];
  return {
    projectId,
    trial: { ...input, context, config: config.config, definition }
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
 * take the trial's push for its own.
 */
const runTrial = async (
  pool: Pool,
  deps: { readonly github: TrialGitHub; readonly agents: ManagedAgentsPort },
  input: TrialBuildInput
): Promise<TrialReport> => {
  const { projectId, trial } = await trialInput(pool, input);
  const building = await tasksBuildingNow(pool, projectId);
  if (building.length > 0) {
    throw new TrialError(
      `wait for the builds of ${building.map((n) => `#${n}`).join(', ')} to end: their ref check would count the trial's push`
    );
  }
  return runTrialBuild(deps, trial);
};

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

/**
 * `trial-build` (a plan without `--run`, the run itself with it) and `trial-measure`, from the
 * command line's flags. The clients are built only for the command that needs them.
 */
export const trialCommand = async (
  pool: Pool,
  deps: {
    readonly agents: ManagedAgentsPort;
    readonly github: () => TrialGitHub;
    readonly models: () => Promise<Readonly<Record<ModelTier, string>>>;
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
    budgetCents: positive(required(flags['budget-usd'], 'budget-usd'), 'budget-usd') * 100,
    promptsDir: PROMPTS_DIR,
    models: await deps.models()
  };
  return flags.run
    ? runTrial(pool, { github: deps.github(), agents: deps.agents }, input)
    : planTrial(pool, deps.github(), input);
};
