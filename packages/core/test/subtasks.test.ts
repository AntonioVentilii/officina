import { describe, expect, test } from 'bun:test';
import { buildWait, linkProblem, parentCloses, type BuildLinks, type LinkPlan } from '../src';

const NONE: BuildLinks = { subtasks: [], after: [], siblings: [], paths: [] };
const PAGE = 'src/routes/+page.svelte';

describe('buildWait', () => {
  test('a parent with open sub-tasks is built through them', () => {
    expect(
      buildWait({
        ...NONE,
        subtasks: [
          { number: 4, stage: 'ready' },
          { number: 3, stage: 'building' },
          { number: 5, stage: 'done' }
        ]
      })
    ).toEqual({ kind: 'subtasks', numbers: [3, 4] });
    expect(buildWait({ ...NONE, subtasks: [{ number: 3, stage: 'cancelled' }] })).toBeNull();
  });

  test('a task waits for every task it waits for that has not merged, a cancelled one included', () => {
    expect(
      buildWait({
        ...NONE,
        after: [
          { number: 7, stage: 'cancelled' },
          { number: 2, stage: 'verifying' },
          { number: 1, stage: 'done' }
        ]
      })
    ).toEqual({ kind: 'after', numbers: [2, 7] });
  });

  test('a sibling in flight that changes one of its files holds a sub-task', () => {
    expect(
      buildWait({
        ...NONE,
        paths: [PAGE, 'src/a.ts'],
        siblings: [{ number: 5, stage: 'reviewing', paths: ['src/b.ts', PAGE] }]
      })
    ).toEqual({ kind: 'shared_paths', numbers: [5] });
  });

  test('a sibling not in flight, or one changing other files, holds nothing', () => {
    for (const sibling of [
      { number: 5, stage: 'ready' as const, paths: [PAGE] },
      { number: 5, stage: 'done' as const, paths: [PAGE] },
      { number: 5, stage: 'building' as const, paths: ['src/b.ts'] }
    ])
      expect(buildWait({ ...NONE, paths: [PAGE], siblings: [sibling] })).toBeNull();
  });

  test('sub-tasks come before the tasks waited for, which come before shared files', () => {
    const all: BuildLinks = {
      subtasks: [{ number: 2, stage: 'ready' }],
      after: [{ number: 3, stage: 'ready' }],
      siblings: [{ number: 4, stage: 'building', paths: [PAGE] }],
      paths: [PAGE]
    };
    expect(buildWait(all)?.kind).toBe('subtasks');
    expect(buildWait({ ...all, subtasks: [] })?.kind).toBe('after');
    expect(buildWait({ ...all, subtasks: [], after: [] })?.kind).toBe('shared_paths');
  });
});

describe('parentCloses', () => {
  test('a parent closes once every sub-task is closed and one merged', () => {
    expect(parentCloses([{ stage: 'done' }, { stage: 'done' }])).toBe(true);
    expect(parentCloses([{ stage: 'done' }, { stage: 'cancelled' }])).toBe(true);
  });

  test('a parent stays open with every sub-task dropped, one still open, or none', () => {
    expect(parentCloses([{ stage: 'cancelled' }, { stage: 'declined' }])).toBe(false);
    expect(parentCloses([{ stage: 'done' }, { stage: 'merging' }])).toBe(false);
    expect(parentCloses([])).toBe(false);
  });
});

describe('linkProblem', () => {
  const plan: LinkPlan = {
    task: { number: 4, stage: 'ready', hasSubtasks: false },
    parent: { number: 2, stage: 'spec_review', hasParent: false },
    after: [{ number: 3, stage: 'building' }],
    edges: [[5, 4]]
  };

  test('valid links have no problem', () => {
    expect(linkProblem(plan)).toBeNull();
    expect(linkProblem({ ...plan, parent: null, after: [] })).toBeNull();
  });

  test('a task is neither its own parent nor waits for itself', () => {
    expect(linkProblem({ ...plan, parent: { ...plan.parent!, number: 4 } })).toBe('self');
    expect(linkProblem({ ...plan, after: [{ number: 4, stage: 'ready' }] })).toBe('self');
  });

  test('links change only before the task and its parent are built', () => {
    expect(linkProblem({ ...plan, task: { ...plan.task, stage: 'building' } })).toBe(
      'task_started'
    );
    expect(linkProblem({ ...plan, task: { ...plan.task, stage: 'cancelled' } })).toBe(
      'task_started'
    );
    expect(linkProblem({ ...plan, parent: { ...plan.parent!, stage: 'reviewing' } })).toBe(
      'parent_started'
    );
  });

  test('sub-tasks go one level deep', () => {
    expect(linkProblem({ ...plan, parent: { ...plan.parent!, hasParent: true } })).toBe('nested');
    expect(linkProblem({ ...plan, task: { ...plan.task, hasSubtasks: true } })).toBe('nested');
  });

  test('a task never starts waiting for a closed task that did not merge', () => {
    expect(linkProblem({ ...plan, after: [{ number: 3, stage: 'declined' }] })).toBe(
      'dependency_closed'
    );
  });

  test('a wait that closes a loop is refused', () => {
    expect(
      linkProblem({
        ...plan,
        edges: [
          [3, 6],
          [6, 4]
        ]
      })
    ).toBe('cycle');
  });
});
