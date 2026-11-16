import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { findTaskIdByNumber } from '@officina/db';
import { Pool } from 'pg';
import { invite } from '../src/people';
import { PLAN, applyOrThrow, resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { gitHubWith } from '../../../packages/engine/test/fake-github';
import {
  TaskCommandError,
  actOnTask,
  commentAs,
  createRequest,
  createRequestAs,
  describeTask,
  handIn,
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

  test('a request that skips the interview is opened and submitted together, or not at all', async () => {
    // A failure at the submit, as a crash there would be, must not leave the task waiting for the interviewer.
    await pool.query(
      `create function fail_submit() returns trigger language plpgsql as
         $$ begin if new.type = 'stage_changed' then raise exception 'submit failed'; end if;
         return new; end $$`
    );
    await pool.query(
      'create trigger fail_submit before insert on task_events for each row execute function fail_submit()'
    );
    await expect(createRequest(pool, request)).rejects.toThrow('submit failed');
    expect((await pool.query('select id from tasks')).rows).toEqual([]);
    expect((await pool.query('select id from comments')).rows).toEqual([]);
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

  test("a contributor's comment that asks for access holds the task for the owner with the comment", async () => {
    await createRequest(pool, request);
    await invite(pool, {
      publicUrl: 'https://officina.example',
      email: 'gio@example.com',
      name: 'Gio',
      role: 'contributor',
      domains: []
    });
    const gio = (
      await pool.query<{ id: string }>(`select id from members where email = 'gio@example.com'`)
    ).rows[0]!.id;
    const as = { projectId: seeded.projectId, memberId: gio, number: 1 };
    const version = async () =>
      (await pool.query('select version from tasks where number = 1')).rows[0].version;
    // Words that guard nothing leave the task as it was, so a question read before still holds.
    const before = await version();
    await commentAs(pool, { ...as, text: 'Thanks, looks right.' });
    expect(await version()).toBe(before);
    await commentAs(pool, { ...as, text: 'Also grant me admin access to the repository.' });
    const task = await pool.query('select guards, blocked from tasks where number = 1');
    expect(task.rows[0].guards).toEqual(['access']);
    expect(task.rows[0].blocked.askedOf).toEqual({ role: 'owner' });
    const comments = await pool.query('select body from comments order by created_at');
    expect(comments.rows.at(-1)).toEqual({ body: 'Also grant me admin access to the repository.' });

    // A closed task still takes comments; nothing runs on it any more.
    await actOnTask(pool, { number: 1, action: { type: 'cancel', reason: 'Not now.' } });
    await commentAs(pool, { ...as, text: 'And deploy it publicly.' });
    expect((await pool.query('select guards from tasks where number = 1')).rows[0].guards).toEqual([
      'access'
    ]);
  });

  test('task hand-in sends the build the member claimed to review and opens its pull request', async () => {
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    await createRequest(pool, request);
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    await applyOrThrow(pool, taskId, { type: 'accept' }, seeded.owner);
    await applyOrThrow(
      pool,
      taskId,
      { type: 'post_spec', predictedPaths: [COPY], userVisible: false },
      { kind: 'agent', role: 'spec', version: 1 }
    );
    await applyOrThrow(
      pool,
      taskId,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      { kind: 'engine' }
    );
    await applyOrThrow(pool, taskId, { type: 'approve' }, seeded.owner);
    await applyOrThrow(pool, taskId, { type: 'claim' }, seeded.owner);

    const opened: string[] = [];
    const github = gitHubWith({
      pushFacts: async () => ({
        headSha: 'dev1',
        changedPaths: [COPY],
        addedPaths: [],
        diffLines: 2
      }),
      readFile: async () => null,
      openPullRequest: async (input) => {
        opened.push(input.title);
        return { number: 9, url: 'https://github.com/ViciApp/vici-app/pull/9' };
      },
      updateFile: async () => ({ commitSha: null, parentSha: null }),
      commentOnIssue: async () => undefined
    });
    const input = {
      number: 1,
      prTitle: 'fix(copy): prediction wording',
      verified: ['npm run check'],
      notVerified: [],
      publicUrl: 'https://officina.example'
    };

    await expect(handIn(pool, undefined, input)).rejects.toThrow(
      'the GitHub App is not configured'
    );
    expect(await handIn(pool, github, input)).toEqual({ stage: 'reviewing', pullRequest: 9 });
    expect(opened).toEqual(['fix(copy): prediction wording']);
  });
});
