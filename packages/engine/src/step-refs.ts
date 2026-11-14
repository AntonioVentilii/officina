import { BUILD_ROLES, ENGINE, branchForLearning, branchForTask } from '@officina/core';
import {
  applyCommand,
  finishRun,
  learningsDecidedDuring,
  loadTaskContext,
  overlappingRunTasks,
  ownStatusCommitsDuring,
  recordRunRefs,
  runsWithRefs,
  type RunRefs
} from '@officina/db';
import type { RefSnapshot } from '@officina/github';
import type { EngineDependencies, Step, StepResult } from './step';

/** What checking a build run's refs reads of its step: the run, its task and where it may push. */
type RefStep = Pick<Step, 'deps' | 'taskId' | 'runId' | 'taskBranch' | 'repoRef'> & {
  readonly role: string;
  readonly context: Pick<Step['context'], 'defaultBranch'>;
};

/** GitHub's clock and ours may disagree; a push this much before the run began still counts. */
const CLOCK_SKEW_MS = 60_000;

/** The moment from which pushes count as made during a run that starts now. */
export const runWindowStart = (nowMs: number): Date => new Date(nowMs - CLOCK_SKEW_MS);

interface MovedRef {
  readonly name: string;
  readonly change: string;
}

/** Every ref of one kind created, moved or deleted between two snapshots, except those `allowed`. */
const movedRefs = (
  kind: 'branch' | 'tag',
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  allowed: (name: string) => boolean
): MovedRef[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name] && !allowed(name))
    .map((name) => {
      const [from, to] = [before[name], after[name]];
      if (from === undefined) return { name, change: `${kind} ${name} was created` };
      if (to === undefined) return { name, change: `${kind} ${name} was deleted` };
      return {
        name,
        change: `${kind} ${name} moved from ${from.slice(0, 7)} to ${to.slice(0, 7)}`
      };
    });

/**
 * The branches whose move during the run is expected: the task's own, and those of tasks building
 * alongside.
 */
const expectedBranches = async (step: RefStep): Promise<Set<string>> =>
  new Set([
    step.taskBranch,
    ...(await overlappingRunTasks(step.deps.pool, step.runId, BUILD_ROLES)).map(branchForTask)
  ]);

/**
 * The branches of learnings people accepted during the run that end on exactly the commit Officina
 * wrote there, on a commit of the default branch: Officina pushed that edit with the App's identity.
 * A learning branch holding anything else is checked like any other branch.
 */
const ownLearningBranches = async (
  step: RefStep,
  after: RefSnapshot,
  since: Date
): Promise<Set<string>> => {
  const own = new Set<string>();
  for (const learning of await learningsDecidedDuring(step.deps.pool, step.runId, since)) {
    const branch = branchForLearning(learning);
    const { branchSha, branchParentSha } = learning;
    if (branchSha === null || branchParentSha === null || after.branches[branch] !== branchSha)
      continue;
    const onDefault = await step.deps.github.isOnBranch({
      ...step.repoRef,
      sha: branchParentSha,
      branch: step.context.defaultBranch
    });
    if (onDefault) own.add(branch);
  }
  return own;
};

/** Whether the default branch moved forward only by a pull request merged on top of it. */
const mergedIntoDefault = async (
  step: RefStep,
  { name }: MovedRef,
  before: RefSnapshot,
  after: RefSnapshot
): Promise<boolean> => {
  const [since, sha] = [before.branches[name], after.branches[name]];
  return (
    name === step.context.defaultBranch &&
    since !== undefined &&
    sha !== undefined &&
    step.deps.github.isPullRequestMerge({ ...step.repoRef, sha, base: name, since })
  );
};

/**
 * Who moved a branch during the run, as far as it matters: Officina's identity (the App, which the
 * builder's token pushes as) unless the push is a status commit Officina recorded itself on that
 * branch, or nobody GitHub can name. A person or any other bot never stops the build.
 */
const movedAsOfficina = async (
  step: RefStep,
  { name }: MovedRef,
  window: { readonly since: Date; readonly own: ReadonlySet<string> }
): Promise<'officina' | 'unknown' | null> => {
  const { github } = step.deps;
  const log = await github.refActivity({
    ...step.repoRef,
    refName: `refs/heads/${name}`,
    since: window.since
  });
  const app = await github.appBotLogin();
  const officina = log.activities.some(
    (activity) => activity.actor === app && !window.own.has(`${name}@${activity.after}`)
  );
  if (officina) return 'officina';
  return log.complete && log.activities.length ? null : 'unknown';
};

const ATTRIBUTION = {
  officina: "with Officina's GitHub App",
  unknown: 'and GitHub shows no one who did it'
} as const;

/** The branches outside those expected that Officina's identity moved, or nobody GitHub names. */
const branchChanges = async (
  step: RefStep,
  before: RefSnapshot,
  after: RefSnapshot,
  since: Date
): Promise<string[]> => {
  const expected = new Set([
    ...(await expectedBranches(step)),
    ...(await ownLearningBranches(step, after, since))
  ]);
  const own = new Set(
    (await ownStatusCommitsDuring(step.deps.pool, step.runId)).map(
      ({ taskNumber, sha }) => `${branchForTask(taskNumber)}@${sha}`
    )
  );
  const changes: string[] = [];
  for (const moved of movedRefs('branch', before.branches, after.branches, (name) =>
    expected.has(name)
  )) {
    if (await mergedIntoDefault(step, moved, before, after)) continue;
    const by = await movedAsOfficina(step, moved, { since, own });
    if (by) changes.push(`${moved.change} ${ATTRIBUTION[by]}`);
  }
  return changes;
};

/**
 * Every tag created, moved or deleted, but a new one on a commit already on the default branch, as
 * a release makes. Deploys run on tags, so a tag on anything else could ship unmerged code.
 */
const tagChanges = async (
  step: RefStep,
  before: RefSnapshot,
  after: RefSnapshot
): Promise<string[]> => {
  const branch = step.context.defaultBranch;
  const changes: string[] = [];
  for (const { name, change } of movedRefs('tag', before.tags, after.tags, () => false)) {
    const sha = after.tags[name];
    if (before.tags[name] !== undefined || sha === undefined) changes.push(change);
    else if (!(await step.deps.github.isOnBranch({ ...step.repoRef, sha, branch })))
      changes.push(`${change} on a commit that is not on ${branch}`);
  }
  return changes;
};

/**
 * What changed outside the task's own branch while a builder held a token that can write any ref,
 * and that the builder could have done. The default branch may move forward by a pull request
 * merged meanwhile, the branch of another task by that task's own build run alongside, and a
 * learning's branch by Officina pushing an edit people accepted, as long as it holds only that.
 * Any other branch counts only when Officina's identity moved it (or GitHub cannot say who did).
 * GitHub's activity does not record who moves tags, so a tag counts unless it is new and on a
 * commit already on the default branch.
 */
const refChanges = async (
  step: RefStep,
  before: RefSnapshot,
  after: RefSnapshot,
  since: Date
): Promise<string[]> => [
  ...(await branchChanges(step, before, after, since)),
  ...(await tagChanges(step, before, after))
];

/**
 * Takes the refs a build run starts from and keeps them on the run, before its session starts, so
 * nothing the builder does can land before them and a run this process never finishes can still be
 * checked.
 */
export const recordStartingRefs = async (step: Step, nowMs: number): Promise<RunRefs> => {
  const start = {
    refs: await step.deps.github.refSnapshot(step.repoRef),
    since: runWindowStart(nowMs)
  };
  await recordRunRefs(step.deps.pool, step.runId, start);
  return start;
};

/**
 * Compares the refs now with those a build run started from. When something the builder could have
 * done moved, the run fails with what moved and a maintainer is asked to check, whoever builds the
 * task now. A comparison GitHub cannot answer counts as a change: nothing would check again later.
 */
export const guardRefs = async (
  step: RefStep,
  before: RunRefs,
  run: { readonly costCents: number | null; readonly result: Record<string, unknown> }
): Promise<Extract<StepResult, { status: 'blocked' }> | null> => {
  const changes = await step.deps.github
    .refSnapshot(step.repoRef)
    .then((after) => refChanges(step, before.refs, after, before.since))
    .catch((error: unknown) => [`the refs could not be checked (${(error as Error).message})`]);
  if (!changes.length) return null;
  const { pool } = step.deps;
  const { role, taskBranch } = step;
  await finishRun(pool, step.runId, {
    status: 'failed',
    costCents: run.costCents,
    result: { ...run.result, refsChanged: changes }
  });
  await applyCommand(pool, {
    taskId: step.taskId,
    command: {
      type: 'block',
      question: `While the ${role} ran, ${changes.join('; ')}. The ${role} may only push ${taskBranch}. Check those refs on GitHub and restore them if the ${role} changed them, then answer to run the build again.`,
      askedOf: { role: 'maintainer' }
    },
    actor: ENGINE
  });
  return {
    status: 'blocked',
    reason: `refs outside ${taskBranch} changed during the build: ${changes.join('; ')}`
  };
};

/**
 * Checks the build runs a previous process left unfinished, among `runIds` (already failed), against
 * the refs each recorded before its session: the process that would have checked them is gone.
 */
export const guardOrphanedBuilds = async (
  deps: EngineDependencies,
  runIds: readonly string[]
): Promise<{ readonly runId: string; readonly reason: string }[]> => {
  const blocked = [];
  for (const run of await runsWithRefs(deps.pool, runIds)) {
    const context = await loadTaskContext(deps.pool, run.taskId);
    if (!context || context.installationId === null) continue;
    const step: RefStep = {
      deps,
      taskId: run.taskId,
      runId: run.runId,
      role: run.role,
      taskBranch: branchForTask(context.number),
      repoRef: { installationId: context.installationId, repo: context.repo },
      context
    };
    const result = run.result !== null && typeof run.result === 'object' ? run.result : {};
    const moved = await guardRefs(step, run, { costCents: null, result: { ...result } });
    if (moved) blocked.push({ runId: run.runId, reason: moved.reason });
  }
  return blocked;
};
