import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { Actor, Command } from '@officina/core';
import {
  applyCommand,
  createTask,
  failOrphanedRuns,
  failStaleRuns,
  finishRun,
  loadTask,
  startRun
} from '../src';
import { PLAN, resetAndSeed } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('task store', () => {
  const pool = new Pool({ connectionString: url });
  let projectId: string;
  let antonio: Actor;
  let antonioId: string;

  beforeEach(async () => {
    const seeded = await resetAndSeed(pool);
    projectId = seeded.projectId;
    antonioId = seeded.ownerId;
    antonio = seeded.owner;
  });

  afterAll(async () => {
    await pool.end();
  });

  const apply = async (taskId: string, command: Command, actor: Actor) => {
    const result = await applyCommand(pool, { taskId, command, actor });
    if (!result.ok) throw new Error(`${command.type}: ${result.error}`);
    return result;
  };

  const agent = (
    role: 'spec' | 'builder' | 'reviewer_spec' | 'reviewer_correctness' | 'chooser'
  ): Actor => ({
    kind: 'agent',
    role,
    version: 1
  });

  const copyPaths = ['src/lib/constants/messages/en.ts'];

  test('persists a solo task from request to done with a full audit trail', async () => {
    const { task } = await createTask(pool, {
      projectId,
      title: 'Fix copy',
      requesterId: antonioId
    });
    const id = task.id;
    const engine: Actor = { kind: 'engine' };
    await apply(id, { type: 'submit_request' }, antonio);
    await apply(id, { type: 'accept' }, antonio);
    await apply(
      id,
      { type: 'post_spec', predictedPaths: copyPaths, userVisible: true },
      agent('spec')
    );
    await apply(id, { type: 'plan_approval', userVisible: true, plan: PLAN }, agent('chooser'));
    await apply(id, { type: 'approve' }, antonio);
    await apply(
      id,
      {
        type: 'dispatch',
        assignee: { kind: 'agent', role: 'builder' },
        openInLane: 0
      },
      engine
    );
    await apply(
      id,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: copyPaths,
        addedPaths: [],
        catalogPages: {},
        diffLines: 4
      },
      agent('builder')
    );
    await apply(id, { type: 'review', verdict: 'approve', notes: 'ok' }, agent('reviewer_spec'));
    await apply(
      id,
      { type: 'review', verdict: 'approve', notes: 'ok' },
      agent('reviewer_correctness')
    );
    await apply(id, { type: 'choose', userVisible: true, plan: PLAN }, agent('chooser'));
    await apply(id, { type: 'approve' }, antonio);
    const last = await apply(id, { type: 'merged' }, engine);

    expect(last.task.stage).toBe('done');
    expect(last.version).toBe(12);
    expect((await loadTask(pool, id))?.task).toEqual(last.task);

    const stages = await pool.query<{ to: string }>(
      `select payload->>'to' as to from task_events where task_id = $1 and type = 'stage_changed' order by id`,
      [id]
    );
    expect(stages.rows.map((row) => row.to)).toEqual([
      'triage',
      'speccing',
      'spec_review',
      'ready',
      'building',
      'reviewing',
      'choosing',
      'verifying',
      'merging',
      'done'
    ]);
    const approvals = await pool.query<{ gate: string; subject: string }>(
      'select gate, subject from approvals where task_id = $1 order by created_at',
      [id]
    );
    expect(approvals.rows).toEqual([
      { gate: 'spec_review', subject: 'spec:1' },
      { gate: 'verifying', subject: 'sha:abc' }
    ]);
    const firstEvent = await pool.query<{ type: string; actor: Actor }>(
      'select type, actor from task_events where task_id = $1 order by id limit 1',
      [id]
    );
    expect(firstEvent.rows[0]).toEqual({ type: 'created', actor: antonio });
  });

  test('a rejected command changes nothing', async () => {
    const { task } = await createTask(pool, { projectId, title: 'Nope', requesterId: antonioId });
    const result = await applyCommand(pool, {
      taskId: task.id,
      command: { type: 'merged' },
      actor: { kind: 'engine' }
    });
    expect(result).toEqual({ ok: false, error: 'wrong_stage' });
    const stored = await loadTask(pool, task.id);
    expect(stored?.version).toBe(0);
    const events = await pool.query('select 1 from task_events where task_id = $1', [task.id]);
    expect(events.rowCount).toBe(1);
  });

  test('a stale version is a conflict, and so is the loser of a concurrent write', async () => {
    const { task } = await createTask(pool, { projectId, title: 'Race', requesterId: antonioId });
    await apply(task.id, { type: 'submit_request' }, antonio);
    expect(
      await applyCommand(pool, {
        taskId: task.id,
        command: { type: 'accept' },
        actor: antonio,
        expectedVersion: 0
      })
    ).toEqual({ ok: false, error: 'conflict' });

    const results = await Promise.all([
      applyCommand(pool, {
        taskId: task.id,
        command: { type: 'accept' },
        actor: antonio,
        expectedVersion: 1
      }),
      applyCommand(pool, {
        taskId: task.id,
        command: { type: 'decline', reason: 'dup' },
        actor: antonio,
        expectedVersion: 1
      })
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: 'conflict' }]);
  });

  test('change requests are kept with their note and subject', async () => {
    const { task } = await createTask(pool, {
      projectId,
      title: 'Spec me',
      requesterId: antonioId
    });
    await apply(task.id, { type: 'submit_request' }, antonio);
    await apply(task.id, { type: 'accept' }, antonio);
    await apply(
      task.id,
      { type: 'post_spec', predictedPaths: copyPaths, userVisible: false },
      agent('spec')
    );
    await apply(task.id, { type: 'request_changes', note: 'cover Italian too' }, antonio);
    const rows = await pool.query(
      'select gate, subject, decision, note from approvals where task_id = $1',
      [task.id]
    );
    expect(rows.rows).toEqual([
      { gate: 'spec_review', subject: 'spec:1', decision: 'changes', note: 'cover Italian too' }
    ]);
  });

  test('task numbers are sequential per project', async () => {
    await createTask(pool, { projectId, title: 'One', requesterId: antonioId });
    await createTask(pool, { projectId, title: 'Two', requesterId: antonioId });
    const numbers = await pool.query<{ number: number }>(
      'select number from tasks where project_id = $1 order by number',
      [projectId]
    );
    expect(numbers.rows.map((row) => row.number)).toEqual([1, 2]);
  });

  test('an invalid project config stops every command', async () => {
    const { task } = await createTask(pool, {
      projectId,
      title: 'Bad config',
      requesterId: antonioId
    });
    await pool.query(`update projects set config = '{"version": 2}' where id = $1`, [projectId]);
    expect(
      await applyCommand(pool, {
        taskId: task.id,
        command: { type: 'submit_request' },
        actor: antonio
      })
    ).toEqual({ ok: false, error: 'invalid_config' });
  });

  test('runs left running by a previous process are failed so their step can run again', async () => {
    const { task } = await createTask(pool, { projectId, title: 'Orphan', requesterId: antonioId });
    const claim = await startRun(pool, {
      taskId: task.id,
      stage: 'speccing',
      role: 'spec',
      agentVersion: 1,
      runner: 'managed_agents'
    });
    if (!claim.ok) throw new Error('claim failed');
    await pool.query(`update runs set external_id = 'sesn_old' where id = $1`, [claim.runId]);

    expect(await failOrphanedRuns(pool)).toEqual([{ id: claim.runId, externalId: 'sesn_old' }]);
    expect(
      (
        await startRun(pool, {
          taskId: task.id,
          stage: 'speccing',
          role: 'spec',
          agentVersion: 1,
          runner: 'managed_agents'
        })
      ).ok
    ).toBe(true);
  });

  test('runs in progress long past their deadline are failed once, and recent ones are left', async () => {
    const claimFor = async (title: string) => {
      const { task } = await createTask(pool, { projectId, title, requesterId: antonioId });
      const claim = await startRun(pool, {
        taskId: task.id,
        stage: 'speccing',
        role: 'spec',
        agentVersion: 1,
        runner: 'managed_agents'
      });
      if (!claim.ok) throw new Error('claim failed');
      return claim.runId;
    };
    const stale = await claimFor('Hung');
    const recent = await claimFor('Working');
    await pool.query(
      `update runs set started_at = now() - interval '3 hours', external_id = 'sesn_hung'
       where id = $1`,
      [stale]
    );

    const twoHours = 2 * 60 * 60 * 1000;
    expect(await failStaleRuns(pool, twoHours)).toEqual([{ id: stale, externalId: 'sesn_hung' }]);
    expect(await failStaleRuns(pool, twoHours)).toEqual([]);
    const { rows } = await pool.query<{ id: string; status: string }>(
      'select id, status from runs where id = any($1::uuid[]) order by status',
      [[stale, recent]]
    );
    expect(rows).toEqual([
      { id: stale, status: 'failed' },
      { id: recent, status: 'running' }
    ]);

    await finishRun(pool, stale, { status: 'succeeded', costCents: 7, result: { late: true } });
    const late = await pool.query<{ status: string; cost: number; result: unknown }>(
      'select status, list_cost_cents as cost, result from runs where id = $1',
      [stale]
    );
    expect(late.rows).toEqual([
      {
        status: 'failed',
        cost: 7,
        result: { error: 'the run was still in progress long past its deadline', late: true }
      }
    ]);
  });
});
