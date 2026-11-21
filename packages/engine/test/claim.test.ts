import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { applyCommandIn, createTask, saveAgentVersion } from '@officina/db';
import { RUNNER_ROLES } from '@officina/runner';
import { Pool } from 'pg';
import { backendPid, untilWaitingOn } from '../../db/test/locks';
import { resetAndSeed, type Seeded } from '../../db/test/seed';
import { createFakePort } from '../../runner/test/fake-port';
import { runAgentStep } from '../src';
import { gitHubWith } from './fake-github';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('claiming a step', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
    await pool.query(
      "update projects set github_installation_id = 99, agent_environment_id = 'env_1' where id = $1",
      [seeded.projectId]
    );
    for (const role of RUNNER_ROLES) {
      await saveAgentVersion(pool, {
        role,
        externalAgentId: `agent_${role}`,
        version: 1,
        definitionHash: 'h'
      });
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  test('a pause that lands while the claim is in flight leaves no run started', async () => {
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Rename settings title',
      requesterId: seeded.ownerId
    });
    const pausing = await pool.connect();
    await pausing.query('begin');
    const paused = await applyCommandIn(pausing, {
      taskId: task.id,
      command: { type: 'pause' },
      actor: seeded.owner
    });
    expect(paused.ok).toBe(true);

    // The claim reads the task before the pause commits, so it finds the interviewer due.
    const deps = {
      pool,
      github: gitHubWith({}),
      agents: createFakePort(() => []),
      publicUrl: 'x'
    };
    const step = runAgentStep(deps, task.id, 'interviewer');
    await untilWaitingOn(pool, await backendPid(pausing));
    await pausing.query('commit');
    pausing.release();

    expect(await step).toEqual({ status: 'skipped', reason: 'not_due' });
    const runs = await pool.query('select 1 from runs where task_id = $1', [task.id]);
    expect(runs.rowCount).toBe(0);
  });
});
