import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { RULED_PLAN_RATIONALE, type Actor } from '@officina/core';
import { createTask, loadTask } from '@officina/db';
import { Pool } from 'pg';
import { applyOrThrow, resetAndSeed, type Seeded } from '../../db/test/seed';
import { collectDueSteps } from '../src';

const url = process.env.TEST_DATABASE_URL;

const specAgent: Actor = { kind: 'agent', role: 'spec', version: 1 };

describe.skipIf(!url)('a spec planned by rule', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const toSpecReview = async (paths: readonly string[]) => {
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Satellite timeout',
      requesterId: seeded.ownerId
    });
    await applyOrThrow(pool, task.id, { type: 'submit_request' }, seeded.owner);
    await applyOrThrow(pool, task.id, { type: 'accept' }, seeded.owner);
    await applyOrThrow(
      pool,
      task.id,
      { type: 'post_spec', predictedPaths: paths, userVisible: false },
      specAgent
    );
    return task.id;
  };

  const plansRecorded = async (taskId: string) =>
    Number(
      (
        await pool.query<{ count: string }>(
          "select count(*) from task_events where task_id = $1 and type = 'approval_planned'",
          [taskId]
        )
      ).rows[0]!.count
    );

  test('a red-lane spec is planned by the engine, once, and no chooser session is due', async () => {
    const taskId = await toSpecReview(['src/satellite/main.rs']);
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([]);
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([]);
    const { task } = (await loadTask(pool, taskId))!;
    expect(task.approvalPlans.spec_review).toMatchObject({
      subject: 'spec:1',
      rationale: RULED_PLAN_RATIONALE,
      build: 'person'
    });
    expect(await plansRecorded(taskId)).toBe(1);
  });

  test('a spec an agent may build is left to the chooser', async () => {
    const taskId = await toSpecReview(['src/routes/+page.svelte']);
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([
      { taskId, role: 'chooser' }
    ]);
    expect(await plansRecorded(taskId)).toBe(0);
  });
});
