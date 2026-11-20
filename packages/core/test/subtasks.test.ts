import { describe, expect, test } from 'bun:test';
import {
  buildWait,
  linkProblem,
  parentCloses,
  type BuildLinks,
  type LinkPlan,
  type Stage
} from '../src';

const NO_LINKS: BuildLinks = { subtasks: [], after: [], siblings: [], paths: [] };
const SHARED = 'src/routes/settings/+page.svelte';

describe('buildWait', () => {
  test('a task with no links waits for nothing', () => {
    expect(buildWait(NO_LINKS)).toBeNull();
  });

  test('a parent with open sub-tasks is built through them', () => {
    expect(
      buildWait({
        ...NO_LINKS,
        subtasks: [
          { number: 4, stage: 'ready' },
          { number: 3, stage: 'building' },
          { number: 5, stage: 'done' }
        ]
      })
    ).toEqual({ kind: 'subtasks', numbers: [3, 4] });
  });

  test('a parent whose sub-tasks are all closed is not held by them', () => {
    expect(
      buildWait({
        ...NO_LINKS,
        subtasks: [
          { number: 3, stage: 'done' },
          { number: 4, stage: 'cancelled' }
        ]
      })
    ).toBeNull();
  });

  test('a task waits for every task it names that is not done, a cancelled one included', () => {
    expect(
      buildWait({
        ...NO_LINKS,
        after: [
          { number: 7, stage: 'cancelled' },
          { number: 3, stage: 'merging' },
          { number: 5, stage: 'done' }
        ]
      })
    ).toEqual({ kind: 'after', numbers: [3, 7] });
  });

  test('a sibling in review that changes one of its files holds it', () => {
    expect(
      buildWait({
        ...NO_LINKS,
        paths: [SHARED, 'src/lib/a.ts'],
        siblings: [{ number: 5, stage: 'reviewing', paths: [SHARED] }]
      })
    ).toEqual({ kind: 'shared_paths', numbers: [5] });
  });

  test('a sibling not in flight, or in flight with other files, holds nothing', () => {
    const paths = [SHARED];
    for (const stage of ['ready', 'done'] satisfies Stage[])
      expect(
        buildWait({ ...NO_LINKS, paths, siblings: [{ number: 5, stage, paths: [SHARED] }] })
      ).toBeNull();
    expect(
      buildWait({
        ...NO_LINKS,
        paths,
        siblings: [{ number: 5, stage: 'building', paths: ['src/lib/other.ts'] }]
      })
    ).toBeNull();
  });

  test('open sub-tasks come first, then the tasks it waits for, then shared files', () => {
    const all: BuildLinks = {
      subtasks: [{ number: 2, stage: 'ready' }],
      after: [{ number: 3, stage: 'building' }],
      siblings: [{ number: 4, stage: 'building', paths: [SHARED] }],
      paths: [SHARED]
    };
    expect(buildWait(all)?.kind).toBe('subtasks');
    expect(buildWait({ ...all, subtasks: [] })?.kind).toBe('after');
    expect(buildWait({ ...all, subtasks: [], after: [] })?.kind).toBe('shared_paths');
  });
});

describe('parentCloses', () => {
  test('a parent closes once every sub-task is done, or done and dropped', () => {
    expect(parentCloses([{ stage: 'done' }, { stage: 'done' }])).toBe(true);
    expect(parentCloses([{ stage: 'done' }, { stage: 'cancelled' }])).toBe(true);
  });

  test('a parent stays open with every sub-task dropped, one still open, or none', () => {
    expect(parentCloses([{ stage: 'cancelled' }, { stage: 'declined' }])).toBe(false);
    expect(parentCloses([{ stage: 'done' }, { stage: 'verifying' }])).toBe(false);
    expect(parentCloses([])).toBe(false);
  });
});

describe('linkProblem', () => {
  const valid: LinkPlan = {
    task: { number: 4, stage: 'ready', hasSubtasks: false },
    parent: { number: 2, stage: 'spec_review', hasParent: false },
    after: [{ number: 3, stage: 'building' }],
    edges: [[3, 5]]
  };

  test('a parent and tasks to wait for, before anything is built, may be linked', () => {
    expect(linkProblem(valid)).toBeNull();
    expect(linkProblem({ ...valid, parent: null, after: [] })).toBeNull();
  });

  test('a task is never its own parent nor waits for itself', () => {
    expect(linkProblem({ ...valid, parent: { ...valid.parent!, number: 4 } })).toBe('self');
    expect(linkProblem({ ...valid, after: [{ number: 4, stage: 'ready' }] })).toBe('self');
  });

  test('links change only while the task and its parent are at or before ready', () => {
    expect(linkProblem({ ...valid, task: { ...valid.task, stage: 'building' } })).toBe(
      'task_started'
    );
    expect(linkProblem({ ...valid, task: { ...valid.task, stage: 'cancelled' } })).toBe(
      'task_started'
    );
    expect(linkProblem({ ...valid, parent: { ...valid.parent!, stage: 'reviewing' } })).toBe(
      'parent_started'
    );
  });

  test('sub-tasks go one level deep', () => {
    expect(linkProblem({ ...valid, parent: { ...valid.parent!, hasParent: true } })).toBe('nested');
    expect(linkProblem({ ...valid, task: { ...valid.task, hasSubtasks: true } })).toBe('nested');
  });

  test('a task cannot wait for a task already cancelled or declined', () => {
    expect(linkProblem({ ...valid, after: [{ number: 3, stage: 'declined' }] })).toBe(
      'dependency_closed'
    );
  });

  test('links that would close a cycle are refused', () => {
    expect(
      linkProblem({
        ...valid,
        edges: [
          [3, 5],
          [5, 4]
        ]
      })
    ).toBe('cycle');
  });
});
