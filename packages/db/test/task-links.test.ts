import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ENGINE, type Actor, type Command } from '@officina/core';
import { Pool } from 'pg';
import { buildLinksOf, createTask, inTransaction, saveSpecVersion, setTaskLinks } from '../src';
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

  const newTask = async () =>
    (
      await createTask(pool, {
        projectId: seeded.projectId,
        title: 'Part',
        requesterId: seeded.ownerId
      })
    ).task.id;

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

  const linksOf = async (taskId: string) => ({
    parent: (
      await pool.query<{ parent: number | null }>(
        'select p.number as parent from tasks t left join tasks p on p.id = t.parent_id where t.id = $1',
        [taskId]
      )
    ).rows[0]!.parent,
    after: (
      await pool.query<{ number: number }>(
        `select t.number from task_dependencies d join tasks t on t.id = d.depends_on
         where d.task_id = $1 order by t.number`,
        [taskId]
      )
    ).rows.map((row) => row.number),
    events: (
      await pool.query(
        "select payload from task_events where task_id = $1 and type = 'links_changed' order by id",
        [taskId]
      )
    ).rows.map((row: { payload: unknown }) => row.payload)
  });

  test('links are replaced by exactly what is given, and the same links twice are recorded once', async () => {
    const [first, second, third, fourth] = [
      await newTask(),
      await newTask(),
      await newTask(),
      await newTask()
    ];
    expect(await link(fourth, first, [third, second])).toEqual({ changed: true, problem: null });
    expect(await link(fourth, first, [second, third])).toEqual({ changed: false, problem: null });
    expect(await linksOf(fourth)).toEqual({
      parent: 1,
      after: [2, 3],
      events: [{ parent: 1, after: [2, 3] }]
    });

    expect(await link(fourth, null, [third])).toEqual({ changed: true, problem: null });
    expect(await linksOf(fourth)).toMatchObject({ parent: null, after: [3] });
    expect((await linksOf(fourth)).events).toHaveLength(2);
  });

  test('a link that closes a loop is refused and writes nothing', async () => {
    const [first, second] = [await newTask(), await newTask()];
    await link(first, null, [second]);
    expect(await link(second, null, [first])).toEqual({ changed: false, problem: 'cycle' });
    expect(await linksOf(second)).toEqual({ parent: null, after: [], events: [] });
  });

  test("a build waits on its spec's current paths, and on what a sibling in flight pushed", async () => {
    const parent = await newTask();
    const building = await createReadyTask(pool, seeded, ['src/a.ts']);
    const ready = await createReadyTask(pool, seeded, ['src/b.ts']);
    await link(building, parent, []);
    await link(ready, parent, []);
    // An earlier version of the waiting task's spec predicted other paths.
    await saveSpecVersion(pool, {
      taskId: ready,
      version: 0,
      body: 'An earlier spec.',
      createdBy: ENGINE,
      predictedPaths: ['src/old.ts']
    });
    const builder: Actor = { kind: 'agent', role: 'builder', version: 1 };
    const steps: [Command, Actor][] = [
      [{ type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane: 0 }, ENGINE],
      [
        {
          type: 'push',
          headSha: 'abc',
          changedPaths: ['src/a.ts', 'src/c.ts'],
          addedPaths: [],
          catalogPages: {},
          diffLines: 10
        },
        builder
      ]
    ];
    for (const [command, actor] of steps) await applyOrThrow(pool, building, command, actor);

    expect(await buildLinksOf(pool, ready)).toEqual({
      subtasks: [],
      after: [],
      siblings: [{ number: 2, stage: 'reviewing', paths: ['src/a.ts', 'src/a.ts', 'src/c.ts'] }],
      paths: ['src/b.ts']
    });
  });
});
