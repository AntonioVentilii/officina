import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ENGINE } from '@officina/core';
import { Pool } from 'pg';
import { applyCommand, buildLinksOf, inTransaction, setTaskLinks } from '../src';
import { applyOrThrow, createReadyTask, resetAndSeed, type Seeded } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('task links', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const link = (taskId: string, parentId: string | null, after: readonly string[]) =>
    inTransaction(pool, (client) =>
      setTaskLinks(client, {
        projectId: seeded.projectId,
        taskId,
        parentId,
        after,
        actor: seeded.owner
      })
    );

  const linkEvents = async (taskId: string) =>
    (
      await pool.query<{ payload: unknown }>(
        "select payload from task_events where task_id = $1 and type = 'links_changed' order by id",
        [taskId]
      )
    ).rows.map((row) => row.payload);

  const dependencies = async () =>
    (
      await pool.query<{ task: number; waited: number }>(
        `select t.number as task, w.number as waited from task_dependencies d
           join tasks t on t.id = d.task_id join tasks w on w.id = d.depends_on
          order by t.number, w.number`
      )
    ).rows;

  test('links replace the earlier ones, and the same links set twice record one event', async () => {
    const parent = await createReadyTask(pool, seeded, 'Settings', ['src/a.ts']);
    const first = await createReadyTask(pool, seeded, 'Title', ['src/b.ts']);
    const second = await createReadyTask(pool, seeded, 'Copy', ['src/c.ts']);
    const task = await createReadyTask(pool, seeded, 'Icon', ['src/d.ts']);

    expect(await link(task.id, parent.id, [second.id, first.id])).toEqual({
      changed: true,
      problem: null
    });
    expect(await link(task.id, parent.id, [first.id, second.id])).toEqual({
      changed: false,
      problem: null
    });
    expect(await link(task.id, null, [second.id])).toEqual({ changed: true, problem: null });

    expect(await linkEvents(task.id)).toEqual([
      { parent: parent.number, after: [first.number, second.number] },
      { parent: null, after: [second.number] }
    ]);
    expect(await dependencies()).toEqual([{ task: task.number, waited: second.number }]);
    const { rows } = await pool.query('select parent_id from tasks where id = $1', [task.id]);
    expect(rows[0]).toEqual({ parent_id: null });
  });

  test('links that would close a cycle are refused and write nothing', async () => {
    const first = await createReadyTask(pool, seeded, 'Title', ['src/a.ts']);
    const second = await createReadyTask(pool, seeded, 'Copy', ['src/b.ts']);
    await link(second.id, null, [first.id]);

    expect(await link(first.id, null, [second.id])).toEqual({ changed: false, problem: 'cycle' });
    expect(await linkEvents(first.id)).toEqual([]);
    expect(await dependencies()).toEqual([{ task: second.number, waited: first.number }]);
  });

  test('a sub-task that waits for its parent through another task is refused', async () => {
    const parent = await createReadyTask(pool, seeded, 'Settings', ['src/a.ts']);
    const other = await createReadyTask(pool, seeded, 'Title', ['src/b.ts']);
    const sub = await createReadyTask(pool, seeded, 'Copy', ['src/c.ts']);
    await link(other.id, null, [parent.id]);

    expect(await link(sub.id, parent.id, [other.id])).toEqual({ changed: false, problem: 'cycle' });
    await link(sub.id, parent.id, []);
    expect(await link(other.id, null, [sub.id])).toEqual({ changed: true, problem: null });
  });

  test("a task's files are its current spec's paths, and a sibling in flight adds what it pushed", async () => {
    const parent = await createReadyTask(pool, seeded, 'Settings', ['src/a.ts']);
    const built = await createReadyTask(pool, seeded, 'Title', ['src/title.ts']);
    const waiting = await createReadyTask(pool, seeded, 'Copy', ['src/copy.ts']);
    await link(built.id, parent.id, []);
    await link(waiting.id, parent.id, []);

    expect(await buildLinksOf(pool, waiting.id)).toEqual({
      subtasks: [],
      after: [],
      siblings: [{ number: built.number, stage: 'ready', paths: ['src/title.ts'] }],
      paths: ['src/copy.ts']
    });

    await applyOrThrow(
      pool,
      built.id,
      { type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane: 0 },
      ENGINE
    );
    await applyOrThrow(
      pool,
      built.id,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: ['src/title.ts', 'src/copy.ts'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 10
      },
      { kind: 'agent', role: 'builder', version: 1 }
    );
    const links = await buildLinksOf(pool, waiting.id);
    expect(links.siblings).toEqual([
      {
        number: built.number,
        stage: 'reviewing',
        paths: ['src/copy.ts', 'src/title.ts']
      }
    ]);
    expect(await buildLinksOf(pool, parent.id)).toMatchObject({
      subtasks: [
        { number: built.number, stage: 'reviewing' },
        { number: waiting.number, stage: 'ready' }
      ]
    });
    const refused = await applyCommand(pool, {
      taskId: waiting.id,
      command: { type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane: 0 },
      actor: ENGINE
    });
    expect(refused).toEqual({ ok: false, error: 'awaiting_tasks' });
  });
});
