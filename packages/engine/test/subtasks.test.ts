import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ENGINE, type Actor } from '@officina/core';
import { inTransaction, loadTask, setTaskLinks } from '@officina/db';
import { Pool } from 'pg';
import { PLAN, applyOrThrow, createReadyTask, resetAndSeed, type Seeded } from '../../db/test/seed';
import { collectDueSteps } from '../src';

const url = process.env.TEST_DATABASE_URL;
const SHARED = 'src/routes/settings/+page.svelte';

const agent = (role: 'builder' | 'reviewer_spec' | 'reviewer_correctness' | 'chooser'): Actor => ({
  kind: 'agent',
  role,
  version: 1
});

describe.skipIf(!url)('sub-tasks and their order', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const pass = async () => (await collectDueSteps({ pool }, seeded.projectId)).dispatched;

  const link = (taskId: string, links: { parent?: string; after?: readonly string[] }) =>
    inTransaction(pool, (client) =>
      setTaskLinks(client, {
        projectId: seeded.projectId,
        taskId,
        parentId: links.parent ?? null,
        after: links.after ?? [],
        actor: seeded.owner
      })
    );

  const stageOf = async (taskId: string) => (await loadTask(pool, taskId))?.task.stage;

  /** Takes a task the builder agent holds through review, verification and the merge. */
  const merge = async (taskId: string, paths: readonly string[]) => {
    const push = {
      type: 'push' as const,
      headSha: `sha-${taskId}`,
      changedPaths: paths,
      addedPaths: [],
      catalogPages: {},
      diffLines: 10
    };
    await applyOrThrow(pool, taskId, push, agent('builder'));
    const review = { type: 'review' as const, verdict: 'approve' as const, notes: 'ok' };
    await applyOrThrow(pool, taskId, review, agent('reviewer_spec'));
    await applyOrThrow(pool, taskId, review, agent('reviewer_correctness'));
    await applyOrThrow(
      pool,
      taskId,
      { type: 'choose', userVisible: false, plan: PLAN },
      agent('chooser')
    );
    await applyOrThrow(pool, taskId, { type: 'approve' }, seeded.owner);
    await applyOrThrow(pool, taskId, { type: 'merged' }, ENGINE);
  };

  test('a ready task with no links is dispatched as before', async () => {
    const task = await createReadyTask(pool, seeded, 'Title', [SHARED]);
    expect(await pass()).toEqual([task.id]);
    expect(await stageOf(task.id)).toBe('building');
  });

  test('a task waiting for another is dispatched on the pass after that one is merged', async () => {
    const first = await createReadyTask(pool, seeded, 'Title', ['src/a.ts']);
    const then = await createReadyTask(pool, seeded, 'Copy', ['src/b.ts']);
    await link(then.id, { after: [first.id] });

    expect(await pass()).toEqual([first.id]);
    expect(await stageOf(then.id)).toBe('ready');
    await merge(first.id, ['src/a.ts']);
    expect(await pass()).toEqual([then.id]);
  });

  test('siblings that change the same file are built one after the other, in order', async () => {
    const parent = await createReadyTask(pool, seeded, 'Settings', [SHARED]);
    const first = await createReadyTask(pool, seeded, 'Title', [SHARED, 'src/a.ts']);
    const second = await createReadyTask(pool, seeded, 'Copy', [SHARED]);
    await link(first.id, { parent: parent.id });
    await link(second.id, { parent: parent.id });

    expect(await pass()).toEqual([first.id]);
    expect(await pass()).toEqual([]);
    await merge(first.id, [SHARED]);
    expect(await pass()).toEqual([second.id]);
  });

  test('siblings with disjoint files are built side by side', async () => {
    const parent = await createReadyTask(pool, seeded, 'Settings', [SHARED]);
    const first = await createReadyTask(pool, seeded, 'Title', ['src/a.ts']);
    const second = await createReadyTask(pool, seeded, 'Copy', ['src/b.ts']);
    await link(first.id, { parent: parent.id });
    await link(second.id, { parent: parent.id });

    expect(await pass()).toEqual([first.id, second.id]);
  });

  test('a parent is never built, and closes on the pass after its last sub-task merged', async () => {
    const parent = await createReadyTask(pool, seeded, 'Settings', [SHARED]);
    const first = await createReadyTask(pool, seeded, 'Title', ['src/a.ts']);
    const second = await createReadyTask(pool, seeded, 'Copy', ['src/b.ts']);
    await link(first.id, { parent: parent.id });
    await link(second.id, { parent: parent.id });

    expect(await pass()).toEqual([first.id, second.id]);
    await merge(first.id, ['src/a.ts']);
    expect(await pass()).toEqual([]);
    expect(await stageOf(parent.id)).toBe('ready');
    await merge(second.id, ['src/b.ts']);

    expect(await pass()).toEqual([]);
    expect(await stageOf(parent.id)).toBe('done');
    const events = async () =>
      (
        await pool.query<{ type: string; payload: unknown }>(
          'select type, payload from task_events where task_id = $1 order by id',
          [parent.id]
        )
      ).rows.slice(-2);
    expect(await events()).toEqual([
      { type: 'subtasks_merged', payload: { subtasks: [first.number, second.number] } },
      { type: 'stage_changed', payload: { from: 'ready', to: 'done' } }
    ]);
    const count = await pool.query('select 1 from task_events where task_id = $1', [parent.id]);
    await pass();
    const again = await pool.query('select 1 from task_events where task_id = $1', [parent.id]);
    expect(again.rowCount).toBe(count.rowCount);
  });
});
