import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { Command } from '@officina/core';
import { applyCommand, createTask, runWasPaused, startRun, type NewRun } from '../src';
import { backendPid, untilWaitingOn } from './locks';
import { resetAndSeed, type Seeded } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('starting a run', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;
  let run: NewRun;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Rename settings title',
      requesterId: seeded.ownerId
    });
    run = {
      taskId: task.id,
      stage: 'request',
      role: 'interviewer',
      agentVersion: 1,
      runner: 'managed_agents'
    };
  });

  afterAll(async () => {
    await pool.end();
  });

  const runsOf = async (taskId: string) =>
    (await pool.query<{ status: string }>('select status from runs where task_id = $1', [taskId]))
      .rows;

  test('a paused task gets no run', async () => {
    await applyCommand(pool, {
      taskId: run.taskId,
      command: { type: 'pause' },
      actor: seeded.owner
    });
    expect(await startRun(pool, run)).toEqual({ ok: false, error: 'paused' });
    expect(await runsOf(run.taskId)).toEqual([]);
  });

  test('a claim that commits before the pause is marked by the pause, so its result never applies', async () => {
    const claiming = await pool.connect();
    await claiming.query('begin');
    const claim = await startRun(claiming, run);
    if (!claim.ok) throw new Error('claim failed');

    const pause = applyCommand(pool, {
      taskId: run.taskId,
      command: { type: 'pause' },
      actor: seeded.owner
    });
    await untilWaitingOn(pool, await backendPid(claiming));
    await claiming.query('commit');
    claiming.release();

    expect((await pause).ok).toBe(true);
    const reading = await pool.connect();
    try {
      expect(await runWasPaused(reading, claim.runId)).toBe(true);
    } finally {
      reading.release();
    }
  });

  test('a claim that read an open task gets no run once it is paused and then cancelled', async () => {
    const commands: Command[] = [{ type: 'pause' }, { type: 'cancel', reason: 'Not needed.' }];
    for (const command of commands) {
      const result = await applyCommand(pool, { taskId: run.taskId, command, actor: seeded.owner });
      expect(result.ok).toBe(true);
    }
    expect(await startRun(pool, run)).toEqual({ ok: false, error: 'paused' });
    expect(await runsOf(run.taskId)).toEqual([]);
  });

  test('a closed task left paused still gets its run, since nothing can resume it', async () => {
    await pool.query("update tasks set stage = 'done', paused = true where id = $1", [run.taskId]);
    const claim = await startRun(pool, { ...run, stage: 'done', role: 'learner' });
    expect(claim.ok).toBe(true);
    expect(await runsOf(run.taskId)).toEqual([{ status: 'running' }]);
  });
});
