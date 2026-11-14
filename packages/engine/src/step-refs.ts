import { BUILD_ROLES, branchForLearning, branchForTask } from '@officina/core';
import { learningsDecidedDuring, overlappingRunTasks, ownStatusCommitsDuring } from '@officina/db';
import type { RefSnapshot } from '@officina/github';
import type { Step } from './step';

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
 * The branches whose move during the run is expected: the task's own, those of tasks building
 * alongside, and those of learnings people accepted meanwhile, which Officina pushes their edit to
 * (the branch of the edit as it stands, and the first one, which an accept before a rewrite used).
 */
const expectedBranches = async (step: Step, since: Date): Promise<Set<string>> => {
  const { pool } = step.deps;
  const learnings = await learningsDecidedDuring(pool, step.runId, since);
  return new Set([
    step.taskBranch,
    ...(await overlappingRunTasks(pool, step.runId, BUILD_ROLES)).map(branchForTask),
    ...learnings.flatMap((learning) => [
      branchForLearning(learning),
      branchForLearning({ ...learning, rewrittenAt: null })
    ])
  ]);
};

/** Whether the default branch moved forward only by a pull request merged on top of it. */
const mergedIntoDefault = async (
  step: Step,
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
  step: Step,
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
  step: Step,
  before: RefSnapshot,
  after: RefSnapshot,
  since: Date
): Promise<string[]> => {
  const expected = await expectedBranches(step, since);
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
  step: Step,
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
 * learning's branch by Officina pushing an edit people accepted. Any other branch counts only when
 * Officina's identity moved it (or GitHub cannot say who did). GitHub's activity does not record
 * who moves tags, so a tag counts unless it is new and on a commit already on the default branch.
 */
export const refChanges = async (
  step: Step,
  before: RefSnapshot,
  after: RefSnapshot,
  since: Date
): Promise<string[]> => [
  ...(await branchChanges(step, before, after, since)),
  ...(await tagChanges(step, before, after))
];
