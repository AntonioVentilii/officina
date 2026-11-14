import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { findTaskIdByNumber } from '@officina/db';
import { Pool } from 'pg';
import { invite } from '../src/people';
import { PLAN, applyOrThrow, resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import {
  TaskCommandError,
  actOnTask,
  createRequest,
  createRequestAs,
  describeTask,
  listTasksText
} from '../src/tasks';

const url = process.env.TEST_DATABASE_URL;
const COPY = 'src/lib/constants/messages/en.ts';

describe.skipIf(!url)('task commands', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const request = {
    title: 'Replace "Wager"',
    request: 'Battle screens say Wager; use prediction wording.',
    skipInterview: true
  };

  test('create opens a request in triage with the request text as its first comment', async () => {
    expect(await createRequest(pool, request)).toEqual({ number: 1, stage: 'triage' });
    const comments = await pool.query('select body from comments');
    expect(comments.rows).toEqual([{ body: request.request }]);
    expect(await listTasksText(pool, {})).toContain('#1    triage');
  });

  test('a watcher cannot open a request, and no task is left behind', async () => {
    const watcher = (
      await pool.query<{ id: string }>(
        `with m as (insert into members (workspace_id, display_name, email)
                    select workspace_id, 'Wanda', 'wanda@example.com' from projects where id = $1
                    returning id)
         insert into project_roles (project_id, member_id, role)
         select $1, id, 'watcher' from m returning member_id as id`,
        [seeded.projectId]
      )
    ).rows[0]!.id;
    await expect(
      createRequestAs(pool, { projectId: seeded.projectId, memberId: watcher, ...request })
    ).rejects.toThrow('watchers can read but not open requests');
    expect((await pool.query('select id from tasks')).rows).toEqual([]);
  });

  test('accept, spec approval and change requests move the task and describe what comes next', async () => {
    await createRequest(pool, request);
    expect(await actOnTask(pool, { number: 1, action: { type: 'accept' } })).toEqual({
      stage: 'speccing'
    });
    expect(await describeTask(pool, { number: 1 })).toContain('Next: an agent is writing the spec');

    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    await applyOrThrow(
      pool,
      taskId,
      { type: 'post_spec', predictedPaths: [COPY], userVisible: true },
      { kind: 'agent', role: 'spec', version: 1 }
    );
    const unplanned = await describeTask(pool, { number: 1 });
    expect(unplanned).toContain('Waiting for the approval chooser to decide who approves.');
    // As on the board, nobody can approve before the chooser has planned the subject.
    expect(unplanned).not.toContain('Approval needed from');
    await applyOrThrow(
      pool,
      taskId,
      { type: 'plan_approval', userVisible: true, plan: PLAN },
      { kind: 'agent', role: 'chooser', version: 1 }
    );
    const described = await describeTask(pool, { number: 1, consoleWorkspace: 'wrkspc_1' });
    expect(described).toContain('Approval plan: check depth test. Ordinary change.');
    expect(described).toContain('Stage: spec_review   Lane: green');
    expect(described).toContain('Approval needed from: the requester, a maintainer');
    expect(described).toContain('Waived (nobody holds the role yet): a product approver');
    expect(described).toContain('Next: read the spec, then: task approve --number 1');

    expect(
      await actOnTask(pool, { number: 1, action: { type: 'changes', note: 'cover Italian too' } })
    ).toEqual({
      stage: 'speccing'
    });
  });

  test('task show lists agent runs and costs only for members who may see runs', async () => {
    await createRequest(pool, request);
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    await pool.query(
      `insert into runs (task_id, stage, runner, agent_role, agent_version, status, list_cost_cents)
       values ($1, 'speccing', 'managed_agents', 'spec', 1, 'succeeded', 120)`,
      [taskId]
    );
    await invite(pool, {
      publicUrl: 'https://officina.example',
      email: 'visitor@example.com',
      name: 'Visitor',
      role: 'watcher',
      domains: []
    });
    expect(await describeTask(pool, { number: 1 })).toContain('Agent runs:');
    const asWatcher = await describeTask(pool, { number: 1, asEmail: 'visitor@example.com' });
    expect(asWatcher).not.toContain('Agent runs:');
    expect(asWatcher).not.toContain('$1.20');
  });

  test('approving a spec moves it to ready', async () => {
    await createRequest(pool, request);
    await actOnTask(pool, { number: 1, action: { type: 'accept' } });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    await applyOrThrow(
      pool,
      taskId,
      { type: 'post_spec', predictedPaths: [COPY], userVisible: true },
      {
        kind: 'agent',
        role: 'spec',
        version: 1
      }
    );
    await applyOrThrow(
      pool,
      taskId,
      { type: 'plan_approval', userVisible: true, plan: PLAN },
      { kind: 'agent', role: 'chooser', version: 1 }
    );
    expect(await actOnTask(pool, { number: 1, action: { type: 'approve' } })).toEqual({
      stage: 'ready',
      satisfied: true
    });
  });

  test('mistakes come back as readable errors', async () => {
    await createRequest(pool, request);
    await expect(actOnTask(pool, { number: 9, action: { type: 'accept' } })).rejects.toThrow(
      'task #9 not found'
    );
    await expect(actOnTask(pool, { number: 1, action: { type: 'approve' } })).rejects.toThrow(
      'not at a stage where that is possible'
    );
    await expect(
      actOnTask(pool, { number: 1, asEmail: 'stranger@example.com', action: { type: 'accept' } })
    ).rejects.toBeInstanceOf(TaskCommandError);
  });

  test('without skipping, a request waits for the interviewer and can be submitted as is', async () => {
    const { skipInterview: _skip, ...plain } = request;
    expect(await createRequest(pool, plain)).toEqual({ number: 1, stage: 'request' });
    expect(await describeTask(pool, { number: 1 })).toContain(
      'the interviewer is reading the request'
    );
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    await applyOrThrow(
      pool,
      taskId,
      {
        type: 'block',
        question: 'Which screens: battles only, or leagues too?',
        askedOf: { memberId: seeded.ownerId }
      },
      { kind: 'agent', role: 'interviewer', version: 1 }
    );
    expect(await actOnTask(pool, { number: 1, action: { type: 'submit' } })).toEqual({
      stage: 'triage'
    });
    const task = await pool.query('select blocked from tasks where id = $1', [taskId]);
    expect(task.rows[0].blocked).toBeNull();
  });
});
