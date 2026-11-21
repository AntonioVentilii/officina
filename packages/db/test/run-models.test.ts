import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { NO_USAGE } from '@officina/core';
import { Pool } from 'pg';
import { failedAttempts, finishRun, startRun } from '../src';
import { createReadyTask, resetAndSeed, type Seeded } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('failed attempts', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const finished = async (taskId: string, role: string, result: unknown) => {
    const run = await startRun(pool, {
      taskId,
      stage: 'building',
      role,
      agentVersion: 1,
      runner: 'managed_agents'
    });
    if (!run.ok) throw new Error('run not started');
    await finishRun(pool, run.runId, { status: 'failed', usage: NO_USAGE, result });
  };

  test('count the runs of a role that left nothing usable, however the step recorded them', async () => {
    const { id: taskId } = await createReadyTask(pool, seeded, 'Rename settings', ['src/a.ts']);
    await finished(taskId, 'builder', { kind: 'no_result' });
    await finished(taskId, 'builder', { kind: 'invalid_result', errors: ['no title'] });
    await finished(taskId, 'builder', { outcome: 'failed', why: 'verify stays red' });
    // Under the refs a build moved, the outcome is kept one level down.
    await finished(taskId, 'builder', { outcome: { kind: 'no_result' }, refsChanged: [] });
    await finished(taskId, 'builder', {
      outcome: { kind: 'result', output: { outcome: 'failed', why: 'x' } },
      refsChanged: []
    });
    expect(await failedAttempts(pool, taskId, 'builder')).toBe(5);
    expect(await failedAttempts(pool, taskId, 'spec')).toBe(0);
  });

  test("a session's own error, an unexpected one or a result applied does not count", async () => {
    const { id: taskId } = await createReadyTask(pool, seeded, 'Rename settings', ['src/a.ts']);
    await finished(taskId, 'builder', {
      kind: 'failed',
      reason: 'the session exhausted its retries',
      error: { type: 'billing_error', message: 'usage limits' }
    });
    await finished(taskId, 'builder', { error: 'GitHub 502' });
    await finished(taskId, 'builder', {
      outcome: { kind: 'result', output: { outcome: 'pushed' } }
    });
    expect(await failedAttempts(pool, taskId, 'builder')).toBe(0);
  });
});
