import { STAGES, TERMINAL_STAGES, WITH_PULL_REQUEST, type Stage } from './lifecycle';

/** A task another one is linked to, by its number and where it stands. */
export interface LinkedTask {
  readonly number: number;
  readonly stage: Stage;
}

/** A linked task with the files it changes. */
export type PathsOf = LinkedTask & { readonly paths: readonly string[] };

/** What decides whether a task may start its build: everything it is linked to. */
export interface BuildLinks {
  /** The tasks whose parent this is. */
  readonly subtasks: readonly LinkedTask[];
  /** The tasks it waits for. */
  readonly after: readonly LinkedTask[];
  /** The other sub-tasks of its parent. */
  readonly siblings: readonly PathsOf[];
  /** Its own files. */
  readonly paths: readonly string[];
}

/** What a ready task waits for before it is built, by the numbers of the tasks it waits on. */
export interface BuildWait {
  readonly kind: 'subtasks' | 'after' | 'shared_paths';
  readonly numbers: readonly number[];
}

const numbersOf = (tasks: readonly LinkedTask[]): number[] =>
  tasks.map((task) => task.number).sort((a, b) => a - b);

/**
 * Why a task may not start its build yet, or `null` when it waits for nothing. A parent is built
 * through its sub-tasks; a task waits until every task it waits for has merged; a sub-task waits
 * while a sibling in flight changes one of its files, so the two never conflict.
 */
export const buildWait = (links: BuildLinks): BuildWait | null => {
  const own = new Set(links.paths);
  const waits: BuildWait[] = [
    {
      kind: 'subtasks',
      numbers: numbersOf(links.subtasks.filter((task) => !TERMINAL_STAGES.has(task.stage)))
    },
    { kind: 'after', numbers: numbersOf(links.after.filter((task) => task.stage !== 'done')) },
    {
      kind: 'shared_paths',
      numbers: numbersOf(
        links.siblings.filter(
          (sibling) =>
            WITH_PULL_REQUEST.has(sibling.stage) && sibling.paths.some((path) => own.has(path))
        )
      )
    }
  ];
  return waits.find((wait) => wait.numbers.length > 0) ?? null;
};

/**
 * Whether a parent closes by itself: every sub-task is closed and at least one merged. Sub-tasks
 * people cancelled or declined count as dropped; a parent whose sub-tasks were all dropped stays
 * open for a person to cancel.
 */
export const parentCloses = (subtasks: readonly Pick<LinkedTask, 'stage'>[]): boolean =>
  subtasks.every((task) => TERMINAL_STAGES.has(task.stage)) &&
  subtasks.some((task) => task.stage === 'done');

export type LinkProblem =
  'self' | 'task_started' | 'parent_started' | 'nested' | 'dependency_closed' | 'cycle';

/** The links a maintainer asks a task to have, with what the project already holds. */
export interface LinkPlan {
  readonly task: { readonly number: number; readonly stage: Stage; readonly hasSubtasks: boolean };
  readonly parent: {
    readonly number: number;
    readonly stage: Stage;
    readonly hasParent: boolean;
  } | null;
  readonly after: readonly LinkedTask[];
  /** Every other wait link in the project as [task, waited-for task], without this task's own. */
  readonly edges: readonly (readonly [number, number])[];
}

/** Links change only before a build starts, so nothing already built is reordered. */
const notStarted = (stage: Stage): boolean =>
  !TERMINAL_STAGES.has(stage) && STAGES.indexOf(stage) <= STAGES.indexOf('ready');

/** Whether `target` is reachable from any of `from` along the wait links. */
const reaches = (
  edges: readonly (readonly [number, number])[],
  from: readonly number[],
  target: number
): boolean => {
  const seen = new Set<number>();
  const pending = [...from];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const [task, waited] of edges) if (task === current) pending.push(waited);
  }
  return false;
};

const isSelfLink = ({ task, parent, after }: LinkPlan): boolean =>
  parent?.number === task.number || after.some((other) => other.number === task.number);

/** Whether the task, or the parent it is given, is already past `ready`. */
const startedProblem = ({ task, parent }: LinkPlan): LinkProblem | null => {
  if (!notStarted(task.stage)) return 'task_started';
  return parent && !notStarted(parent.stage) ? 'parent_started' : null;
};

/** Why the planned links may not be set, or `null` when they may. */
export const linkProblem = (plan: LinkPlan): LinkProblem | null => {
  if (isSelfLink(plan)) return 'self';
  const started = startedProblem(plan);
  if (started) return started;
  const { task, parent, after } = plan;
  // One level only: a parent has no parent, and a task with sub-tasks is no sub-task.
  if (parent && (parent.hasParent || task.hasSubtasks)) return 'nested';
  if (after.some((other) => other.stage === 'declined' || other.stage === 'cancelled'))
    return 'dependency_closed';
  const waited = after.map((other) => other.number);
  return reaches(plan.edges, waited, task.number) ? 'cycle' : null;
};
