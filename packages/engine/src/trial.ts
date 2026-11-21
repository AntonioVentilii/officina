import { TASK_BRANCH_PREFIX, type ProjectConfig, type RunUsage } from '@officina/core';
import type { StoredTaskContext } from '@officina/db';
import type { RepoRef } from '@officina/github';
import {
  executeRun,
  measureSession,
  readSession,
  syncTrialBuilder,
  type AgentDefinition,
  type AgentModel,
  type AgentVersionRef,
  type ManagedAgentsPort,
  type RunOutcome,
  type SessionMeasure,
  type TrialArm
} from '@officina/runner';
import { buildBrief } from './brief';
import { chooseModel, type StepModel } from './model-choice';
import { revokeRunToken } from './live-runs';
import { bodyProblems, readPrTemplate } from './pr-template';
import type { GitHubPort } from './step';
import { taskBriefFields } from './step-session';
import { titleProblems } from './validators';

/**
 * A trial replays the first build of a past task on the commit it started from, once per arm, so
 * two ways of running the builder can be compared on the same work. It writes only its own agents
 * and its own branch, and records nothing on the board: the task, its runs and its costs stay as
 * they were. Its spend is the workspace's like any other session's.
 */
export type TrialGitHub = Pick<GitHubPort, 'runToken' | 'revokeToken' | 'refSnapshot' | 'readFile'>;

export class TrialError extends Error {}

export interface TrialInput {
  readonly context: StoredTaskContext;
  readonly config: ProjectConfig;
  readonly arm: TrialArm;
  readonly definition: AgentDefinition;
  /** The model and effort both arms run at: what a first build of the task gets today. */
  readonly model: AgentModel & { readonly reason: string };
  /** The full sha of the default branch's commit the original build started from. */
  readonly base: string;
  /** Which run of this arm on this task it is, so a repeat gets a branch of its own. */
  readonly attempt: number;
  readonly budgetCents: number;
}

export interface TrialPlan {
  readonly task: number;
  readonly arm: TrialArm;
  readonly base: string;
  readonly branch: string;
  readonly agentName: string;
  readonly readerName: string | null;
  readonly model: AgentModel & { readonly reason: string };
  readonly budgetCents: number;
  readonly brief: string;
}

export interface TrialReport extends Omit<TrialPlan, 'brief'> {
  readonly agent: AgentVersionRef;
  readonly sessionId: string;
  readonly outcome: RunOutcome;
  readonly usage: RunUsage;
  readonly measure: SessionMeasure;
  /** Refs other than the trial's branch that moved while it ran: none, unless something else pushed. */
  readonly otherRefsMoved: readonly string[];
  /** Whether GitHub took the run token back once the session stopped. */
  readonly tokenRevoked: boolean;
  /**
   * What a person must look at before trusting the trial or leaving it: a token still valid, a ref
   * moved besides the trial's own. The token can push anywhere, so a stray push is found here, after
   * the fact, as the production ref check finds it.
   */
  readonly problems: readonly string[];
}

/**
 * Under the prefix every build's branch must carry, but never `branchForTask`'s name, which is the
 * only one the engine and the webhooks take for a task's own: a trial's push is nobody's build.
 */
export const trialBranch = (taskNumber: number, arm: TrialArm, attempt: number): string =>
  `${TASK_BRANCH_PREFIX}trial-task-${taskNumber}-${arm}-${attempt}`;

/**
 * The model a first build of the task gets today, as `chooseModel` picks it with nothing pushed
 * yet and the tier a maintainer forced on the task, if any, so a trial measures what production would run rather than the role's default.
 */
export const firstBuildChoice = (
  context: StoredTaskContext,
  config: ProjectConfig,
  predictedPaths: readonly string[]
): StepModel =>
  chooseModel({
    role: 'builder',
    lane: context.task.lane,
    guards: context.task.guards,
    paths: predictedPaths,
    diffLines: null,
    strongPaths: config.models.strongPaths,
    fixRounds: 0,
    failedAttempts: 0,
    forcedTier: context.task.forcedModel
  });

const FULL_SHA = /^[0-9a-f]{40}$/;

const trialSection = (base: string): string =>
  `## Trial replay\n\nThis build replays a past task to measure how it is built. The workspace holds the default branch at commit \`${base}\`: create the task branch from that commit, and do not fetch, merge or rebase onto a newer default branch.`;

const repoRefOf = (context: StoredTaskContext): RepoRef => {
  if (context.installationId === null)
    throw new TrialError('the project has no GitHub installation');
  return { installationId: context.installationId, repo: context.repo };
};

const environmentOf = (context: StoredTaskContext): string => {
  if (context.environmentId === null) throw new TrialError('the project has no agent environment');
  return context.environmentId;
};

/** What a trial would run, read without writing anything or starting a session. */
export const planTrialBuild = async (
  github: Pick<TrialGitHub, 'readFile'>,
  input: TrialInput
): Promise<TrialPlan & { readonly prTemplate: Awaited<ReturnType<typeof readPrTemplate>> }> => {
  const { context, config, arm, definition, base } = input;
  if (!FULL_SHA.test(base)) throw new TrialError('the base must be a full commit sha');
  if (context.latestSpec === null) throw new TrialError(`task #${context.number} has no spec`);
  const branch = trialBranch(context.number, arm, input.attempt);
  const prTemplate = await readPrTemplate(github, repoRefOf(context), {
    path: config.docs.prTemplate,
    branch: base
  });
  const brief = buildBrief({
    ...taskBriefFields(context, config),
    role: 'builder',
    taskBranch: branch,
    requestThread: [],
    feedback: [],
    firstRound: true,
    prTemplate: prTemplate?.path ?? null,
    changedPaths: []
  });
  return {
    task: context.number,
    arm,
    base,
    branch,
    agentName: definition.name,
    readerName: definition.reader?.name ?? null,
    model: input.model,
    budgetCents: input.budgetCents,
    brief: `${brief}\n\n${trialSection(base)}`,
    prTemplate
  };
};

/** The refs that differ between two snapshots of one kind, by name. */
const movedRefs = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name])
    .sort();

/**
 * Runs one arm of a trial: refuses a branch already taken (each attempt gets its own), syncs the
 * arm's trial agents, runs the build on the base commit with a run token revoked at the end, and
 * measures every thread of the session once it has stopped.
 */
export const runTrialBuild = async (
  deps: { readonly github: TrialGitHub; readonly agents: ManagedAgentsPort },
  input: TrialInput
): Promise<TrialReport> => {
  const { github, agents } = deps;
  const { context, config } = input;
  const ref = repoRefOf(context);
  const { brief, prTemplate, ...plan } = await planTrialBuild(github, input);
  const before = await github.refSnapshot(ref);
  if (before.branches[plan.branch] !== undefined) {
    throw new TrialError(`${plan.branch} already exists: run this arm with the next --attempt`);
  }
  const agent = await syncTrialBuilder(agents, input.definition);
  const token = await github.runToken(ref, { contents: 'write' });
  let tokenRevoked = false;
  const report = await executeRun(agents, {
    role: 'builder',
    brief,
    session: {
      agentId: agent.id,
      agentVersion: agent.version,
      model: { id: input.model.id, effort: input.model.effort },
      environmentId: environmentOf(context),
      title: `Officina trial #${context.number} builder ${input.arm} ${input.attempt}`,
      metadata: { trial_arm: input.arm, task_id: context.task.id, base: input.base },
      repository: {
        url: `https://github.com/${context.repo}`,
        token,
        branch: context.defaultBranch,
        commit: input.base
      },
      budgetCents: input.budgetCents
    },
    validate: (output) => [
      ...titleProblems(config.pullRequest.titlePattern)(output),
      ...bodyProblems(prTemplate)(output)
    ]
  }).finally(async () => {
    tokenRevoked = await revokeRunToken(github, token);
  });
  const after = await github.refSnapshot(ref);
  const otherRefsMoved = [
    ...movedRefs(before.branches, after.branches).filter((name) => name !== plan.branch),
    ...movedRefs(before.tags, after.tags).map((tag) => `tag ${tag}`)
  ];
  return {
    ...plan,
    agent,
    sessionId: report.sessionId,
    outcome: report.outcome,
    usage: report.usage,
    measure: measureSession(await readSession(agents, report.sessionId)),
    otherRefsMoved,
    tokenRevoked,
    problems: [
      ...(tokenRevoked
        ? []
        : ['GitHub did not take the run token back: revoke it, or wait the hour it lasts']),
      ...otherRefsMoved.map((name) => `${name} moved while the trial ran: check who moved it`)
    ]
  };
};
