import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { findTaskIdByNumber } from '@officina/db';
import { Pool } from 'pg';
import { applyOrThrow, resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import {
  TaskCommandError,
  actOnTask,
  createRequest,
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
    request: 'Battle screens say Wager; use prediction wording.'
  };

  test('create opens a request in triage with the request text as its first comment', async () => {
    expect(await createRequest(pool, request)).toEqual({ number: 1, stage: 'triage' });
    const comments = await pool.query('select body from comments');
    expect(comments.rows).toEqual([{ body: request.request }]);
    expect(await listTasksText(pool, {})).toContain('#1    triage');
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
    const described = await describeTask(pool, { number: 1, consoleWorkspace: 'wrkspc_1' });
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
});
