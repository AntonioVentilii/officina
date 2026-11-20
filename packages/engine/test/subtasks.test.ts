import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ENGINE, type Actor, type Command } from '@officina/core';
import { createTask, inTransaction, loadTask, setTaskLinks } from '@officina/db';
import { Pool } from 'pg';
import {
  PLAN,
  applyOrThrow,
  createReadyTask,
  createTaskInMerging,
  resetAndSeed,
  type Seeded
} from '../../db/test/seed';
import { collectDueSteps } from '../src';

const url = process.env.TEST_DATABASE_URL;

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

  /** Takes a task the builder agent holds through review and verification to `done`. */
  const merge = async (taskId: string, paths: readonly string[]) => {
    const steps: [Command, Actor][] = [
      [
        {
          type: 'push',
          headSha: 'abc',
          changedPaths: paths,
          addedPaths: [],
          catalogPages: {},
          diffLines: 10
        },
        agent('builder')
      ],
      [{ type: 'review', verdict: 'approve', notes: 'ok' }, agent('reviewer_spec')],
      [{ type: 'review', verdict: 'approve', notes: 'ok' }, agent('reviewer_correctness')],
      [{ type: 'choose', userVisible: false, plan: PLAN }, agent('chooser')],
      [{ type: 'approve' }, seeded.owner],
      [{ type: 'merged' }, ENGINE]
    ];
    for (const [command, actor] of steps) await applyOrThrow(pool, taskId, command, actor);
  };

  const stageOf = async (taskId: string) => (await loadTask(pool, taskId))!.task.stage;

  test('a task waiting for another is dispatched on the pass after that one merges', async () => {
    const merging = await createTaskInMerging(pool, seeded);
    const waiting = await createReadyTask(pool, seeded, ['src/routes/a.svelte']);
    await link(waiting, { after: [merging] });

    expect(await pass()).toEqual([]);
    await applyOrThrow(pool, merging, { type: 'merged' }, ENGINE);
    expect(await pass()).toEqual([waiting]);
  });

  test('of two sub-tasks that change the same file, the first is built, then the other', async () => {
    const parent = await createReadyTask(pool, seeded, ['src/routes/a.svelte']);
    const first = await createReadyTask(pool, seeded, ['src/routes/a.svelte']);
    const second = await createReadyTask(pool, seeded, ['src/routes/a.svelte', 'src/b.ts']);
    await link(first, { parent });
    await link(second, { parent });

    expect(await pass()).toEqual([first]);
    expect(await pass()).toEqual([]);
    await merge(first, ['src/routes/a.svelte']);
    expect(await pass()).toEqual([second]);
  });

  test('sub-tasks that change different files are built side by side', async () => {
    const parent = await createReadyTask(pool, seeded, ['src/routes/a.svelte']);
    const first = await createReadyTask(pool, seeded, ['src/routes/a.svelte']);
    const second = await createReadyTask(pool, seeded, ['src/b.ts']);
    await link(first, { parent });
    await link(second, { parent });

    expect(await pass()).toEqual([first, second]);
  });

  test('a ready task with no links is dispatched as before', async () => {
    const plain = await createReadyTask(pool, seeded, ['src/routes/a.svelte']);
    expect(await pass()).toEqual([plain]);
    expect(await stageOf(plain)).toBe('building');
  });

  test('a parent is never built and closes itself once its last sub-task merges, once', async () => {
    const parent = await createReadyTask(pool, seeded, ['src/routes/a.svelte']);
    const sub = await createReadyTask(pool, seeded, ['src/routes/a.svelte']);
    const dropped = (
      await createTask(pool, {
        projectId: seeded.projectId,
        title: 'Dropped part',
        requesterId: seeded.ownerId
      })
    ).task.id;
    await link(sub, { parent });
    await link(dropped, { parent });
    await applyOrThrow(pool, dropped, { type: 'cancel', reason: 'Not needed.' }, seeded.owner);

    expect(await pass()).toEqual([sub]);
    expect(await stageOf(parent)).toBe('ready');
    await merge(sub, ['src/routes/a.svelte']);

    expect(await pass()).toEqual([]);
    expect(await stageOf(parent)).toBe('done');
    const events = async () =>
      (
        await pool.query<{ type: string; payload: unknown }>(
          'select type, payload from task_events where task_id = $1 order by id',
          [parent]
        )
      ).rows;
    const closed = await events();
    expect(closed.slice(-2)).toEqual([
      { type: 'subtasks_merged', payload: { subtasks: [2] } },
      { type: 'stage_changed', payload: { from: 'ready', to: 'done' } }
    ]);
    await pass();
    expect(await events()).toEqual(closed);
  });
});
