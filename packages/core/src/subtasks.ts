import { STAGES, TERMINAL_STAGES, WITH_PULL_REQUEST, type Stage } from './lifecycle';

/** A task another one is linked to: its parent, one of its sub-tasks, or a task it waits for. */
export interface LinkedTask {
  readonly number: number;
  readonly stage: Stage;
}

/** A linked task with the files it changes. */
export type PathsOf = LinkedTask & { readonly paths: readonly string[] };

/** What decides whether a task may be built now, as the store reads it. */
export interface BuildLinks {
  /** The tasks whose parent this is. */
  readonly subtasks: readonly LinkedTask[];
  /** The tasks it waits for. */
  readonly after: readonly LinkedTask[];
  /** The other sub-tasks of its parent, each with its files. */
  readonly siblings: readonly PathsOf[];
  /** Its own files: the paths its current spec predicted. */
  readonly paths: readonly string[];
}

/**
 * Why a task may not be built yet, with the numbers of the tasks it waits on, ascending.
 * `subtasks_closed` is a parent whose sub-tasks are all closed: it is never built itself, so it
 * waits to close with them, or, when they were all dropped, for a person to cancel it.
 */
export interface BuildWait {
  readonly kind: 'subtasks' | 'subtasks_closed' | 'after' | 'shared_paths';
  readonly numbers: readonly number[];
}

const numbersOf = (tasks: readonly LinkedTask[]): number[] =>
  tasks.map((task) => task.number).sort((a, b) => a - b);

/**
 * What the task waits for before it may be built, or `null` when nothing holds it: a parent is built
 * through its sub-tasks and never itself, a task waits for every task it names until that one is
 * done, and a sub-task waits for a sibling in flight that changes one of its files.
 */
export const buildWait = (links: BuildLinks): BuildWait | null => {
  const own = new Set(links.paths);
  const waits: BuildWait[] = [
    {
      kind: 'subtasks',
      numbers: numbersOf(links.subtasks.filter((task) => !TERMINAL_STAGES.has(task.stage)))
    },
    { kind: 'subtasks_closed', numbers: numbersOf(links.subtasks) },
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
 * Whether a parent closes: every sub-task is closed and at least one merged. Sub-tasks people
 * cancelled or declined count as dropped; a parent whose sub-tasks were all dropped stays open.
 */
export const parentCloses = (subtasks: readonly Pick<LinkedTask, 'stage'>[]): boolean =>
  subtasks.every((task) => TERMINAL_STAGES.has(task.stage)) &&
  subtasks.some((task) => task.stage === 'done');

export type LinkProblem =
  'self' | 'task_started' | 'parent_started' | 'nested' | 'dependency_closed' | 'cycle';

/** The links a person asks for, with what deciding them needs to know. */
export interface LinkPlan {
  readonly task: { readonly number: number; readonly stage: Stage; readonly hasSubtasks: boolean };
  readonly parent: {
    readonly number: number;
    readonly stage: Stage;
    readonly hasParent: boolean;
  } | null;
  readonly after: readonly LinkedTask[];
  /**
   * Every other wait in the project as [task, waited-for task], without this task's own links: the
   * tasks each one waits for, and each parent waiting for its sub-tasks, since it closes with them.
   */
  readonly edges: readonly (readonly [number, number])[];
}

const READY = STAGES.indexOf('ready');

/** At or before `ready`, and still open: nothing has been built yet. */
const notStarted = (stage: Stage): boolean =>
  !TERMINAL_STAGES.has(stage) && STAGES.indexOf(stage) <= READY;

/** Whether `target` can be reached from any of `from` along the edges. */
const reaches = (
  edges: readonly (readonly [number, number])[],
  from: readonly number[],
  target: number
): boolean => {
  const next = new Map<number, number[]>();
  for (const [task, waited] of edges) next.set(task, [...(next.get(task) ?? []), waited]);
  const seen = new Set<number>();
  const stack = [...from];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(next.get(current) ?? []));
  }
  return false;
};

/** Why the task may not get this parent: it is past `ready`, or it would nest a level deeper. */
const problemWithParent = (
  task: LinkPlan['task'],
  parent: NonNullable<LinkPlan['parent']>
): LinkProblem | null => {
  if (!notStarted(parent.stage)) return 'parent_started';
  return parent.hasParent || task.hasSubtasks ? 'nested' : null;
};

/**
 * Why the links asked for may not be set, or `null` when they may. Links change only before a
 * build starts, on one level (a parent has no parent), never towards a task already dropped, and
 * never into a cycle, which would wait forever: a sub-task that waits, even through other tasks, for
 * its own parent is one, since the parent closes only after it.
 */
export const linkProblem = (plan: LinkPlan): LinkProblem | null => {
  const { task, parent, after } = plan;
  if (parent?.number === task.number || after.some((other) => other.number === task.number))
    return 'self';
  if (!notStarted(task.stage)) return 'task_started';
  const parentProblem = parent && problemWithParent(task, parent);
  if (parentProblem) return parentProblem;
  if (after.some((other) => other.stage === 'declined' || other.stage === 'cancelled'))
    return 'dependency_closed';
  const waited = after.map((other) => other.number);
  const waitsOnItself = [task.number, ...(parent ? [parent.number] : [])].some((number) =>
    reaches(plan.edges, waited, number)
  );
  return waitsOnItself ? 'cycle' : null;
};
