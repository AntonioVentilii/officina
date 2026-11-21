import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { findTaskIdByNumber } from '@officina/db';
import type { HandInPort } from '@officina/engine';
import { GitHubError } from '@officina/github';
import { Pool } from 'pg';
import { taskActionFor } from '../src/cli';
import { invite } from '../src/people';
import {
  PLAN,
  applyOrThrow,
  createReadyTask,
  resetAndSeed,
  type Seeded
} from '../../../packages/db/test/seed';
import { gitHubWith } from '../../../packages/engine/test/fake-github';
import {
  TaskCommandError,
  actOnTask,
  commentAs,
  createRequest,
  createRequestAs,
  describeTask,
  handIn,
  linkTask,
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

  test('a request sent again with the same id finds the task the first one opened', async () => {
    const named = { ...request, skipInterview: false, requestId: 'form-1' };
    const sent = await Promise.all([createRequest(pool, named), createRequest(pool, named)]);
    expect(sent).toEqual([
      { number: 1, stage: 'request' },
      { number: 1, stage: 'request' }
    ]);
    expect(await createRequest(pool, named)).toEqual({ number: 1, stage: 'request' });
    expect((await pool.query('select id from tasks')).rows).toHaveLength(1);
    expect((await pool.query('select id from comments')).rows).toHaveLength(1);

    // Another id, or none, is another request.
    expect(await createRequest(pool, { ...named, requestId: 'form-2' })).toMatchObject({
      number: 2
    });
    expect(await createRequest(pool, { ...request, skipInterview: false })).toMatchObject({
      number: 3
    });
  });

  test('a request id is only ever matched against the same requester', async () => {
    await createRequest(pool, { ...request, requestId: 'form-1' });
    const other = await invite(pool, {
      publicUrl: 'x',
      email: 'gio@example.com',
      name: 'Gio',
      role: 'contributor',
      domains: []
    });
    expect(other).toContain('/signin#');
    const gio = (
      await pool.query<{ id: string }>("select id from members where email = 'gio@example.com'")
    ).rows[0]!.id;
    expect(
      await createRequestAs(pool, {
        projectId: seeded.projectId,
        memberId: gio,
        ...request,
        requestId: 'form-1'
      })
    ).toMatchObject({ number: 2 });
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

  test('a maintainer links tasks once, and a contributor may not link them', async () => {
    await createReadyTask(pool, seeded, 'Title', ['src/a.ts']);
    await createReadyTask(pool, seeded, 'Copy', ['src/b.ts']);
    const task = await createReadyTask(pool, seeded, 'Icon', ['src/c.ts']);
    for (const [email, role] of [
      ['mara@example.com', 'maintainer'],
      ['gio@example.com', 'contributor']
    ] as const)
      await invite(pool, { publicUrl: 'x', email, name: role, role, domains: [] });
    const links = { number: task.number, parent: 1, after: [2], asEmail: 'mara@example.com' };

    expect(await linkTask(pool, links)).toBe('Task #3: parent task 1, waits for task 2.');
    expect(await linkTask(pool, links)).toBe('Task #3: parent task 1, waits for task 2.');
    const events = await pool.query(
      "select 1 from task_events where task_id = $1 and type = 'links_changed'",
      [task.id]
    );
    expect(events.rowCount).toBe(1);

    await expect(
      linkTask(pool, { number: task.number, after: [], asEmail: 'gio@example.com' })
    ).rejects.toMatchObject({ status: 403 });
    expect(await linkTask(pool, { number: task.number, after: [] })).toBe('Task #3: no links.');
  });

  test('a task linked to itself or into a cycle is refused with why', async () => {
    await createReadyTask(pool, seeded, 'Title', ['src/a.ts']);
    await createReadyTask(pool, seeded, 'Copy', ['src/b.ts']);
    await expect(linkTask(pool, { number: 1, after: [1] })).rejects.toThrow(
      'a task cannot be its own parent or wait for itself'
    );
    await linkTask(pool, { number: 2, after: [1] });
    await expect(linkTask(pool, { number: 1, after: [2] })).rejects.toThrow(
      'these links would make the tasks wait for each other forever'
    );
  });

  test('task show says what a ready task waits for before it is built', async () => {
    await createReadyTask(pool, seeded, 'Title', ['src/a.ts']);
    await createReadyTask(pool, seeded, 'Copy', ['src/b.ts']);
    await linkTask(pool, { number: 2, after: [1] });
    expect(await describeTask(pool, { number: 2 })).toEndWith('Next: Builds once task 1 is merged');
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

  /** Opens task 1 on the copy path and claims its build as the owner. */
  const claimedBuild = async () => {
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
    return taskId;
  };

  test('task show offers to allow an oversized change, and task answer grants it for the task', async () => {
    const taskId = await claimedBuild();
    const push = (headSha: string, diffLines: number) =>
      applyOrThrow(
        pool,
        taskId,
        {
          type: 'push',
          headSha,
          changedPaths: [COPY],
          addedPaths: [],
          catalogPages: {},
          diffLines
        },
        seeded.owner
      );
    await push('big', 700);
    const held = await describeTask(pool, { number: 1 });
    expect(held).toContain('(c) Allow 700 lines for this task');
    const version = Number(/--version (\d+)/.exec(held)?.[1]);
    expect(held).toContain(`Next: task answer --number 1 --option <letter> --version ${version}`);

    const action = taskActionFor('answer', { option: 'c', version: String(version) });
    if (!action) throw new Error('answer applies no action');
    await actOnTask(pool, { number: 1, action });
    const shown = await describeTask(pool, { number: 1 });
    expect(shown).toContain(
      'Size allowed for this task: up to 700 lines in the green lane, by Antonio on'
    );
    const comments = await pool.query<{ body: string }>(
      'select body from comments where task_id = $1 order by created_at',
      [taskId]
    );
    expect(comments.rows.at(-1)?.body).toBe('Option (c): Allow 700 lines for this task');

    await push('fits', 700);
    expect((await pool.query('select stage from tasks where id = $1', [taskId])).rows[0]).toEqual({
      stage: 'reviewing'
    });

    // A head that turns the task stricter leaves the green allowance out of force, and says so.
    await applyOrThrow(
      pool,
      taskId,
      {
        type: 'outside_push',
        headSha: 'wider',
        changedPaths: [COPY, 'src/routes/+page.svelte'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 700
      },
      { kind: 'engine' }
    );
    expect(await describeTask(pool, { number: 1 })).not.toContain('Size allowed');
  });

  test('task hand-back gives the claimed build back, and the task waits in ready again', async () => {
    const taskId = await claimedBuild();
    const action = taskActionFor('hand-back', {});
    if (!action) throw new Error('hand-back applies no action');
    expect(await actOnTask(pool, { number: 1, action })).toEqual({ stage: 'ready' });
    const task = await pool.query('select stage, assignee from tasks where id = $1', [taskId]);
    expect(task.rows[0]).toEqual({ stage: 'ready', assignee: null });
  });

  const handInInput = {
    number: 1,
    prTitle: 'fix(copy): prediction wording',
    verified: ['npm run check'],
    notVerified: [],
    publicUrl: 'https://officina.example'
  };

  test('task hand-in sends the build the member claimed to review and opens its pull request', async () => {
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    await claimedBuild();

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
      commentOnIssue: async () => ({ id: 1 }),
      failedChecks: async () => []
    });
    const input = handInInput;

    await expect(handIn(pool, undefined, input)).rejects.toThrow(
      'the GitHub App is not configured'
    );
    expect(await handIn(pool, github, input)).toEqual({ stage: 'reviewing', pullRequest: 9 });
    expect(opened).toEqual(['fix(copy): prediction wording']);
  });

  test('task show prints what the reviewers found on the build they sent back, for who may read it', async () => {
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const taskId = await claimedBuild();
    const github = gitHubWith({
      pushFacts: async () => ({
        headSha: 'dev1',
        changedPaths: [COPY],
        addedPaths: [],
        diffLines: 2
      }),
      readFile: async () => null,
      openPullRequest: async () => ({
        number: 9,
        url: 'https://github.com/ViciApp/vici-app/pull/9'
      }),
      updateFile: async () => ({ commitSha: null, parentSha: null }),
      commentOnIssue: async () => ({ id: 1 }),
      failedChecks: async () => []
    });
    await handIn(pool, github, handInInput);
    await pool.query(
      `insert into runs (task_id, stage, runner, agent_role, agent_version, status, result)
       values ($1, 'reviewing', 'managed_agents', 'reviewer_correctness', 1, 'succeeded', $2)`,
      [
        taskId,
        JSON.stringify({
          outcome: 'changes',
          items: [{ file: COPY, line: 4, issue: 'Wager is still there.' }]
        })
      ]
    );
    // The other reviewer's verdict first: changes go back to the build once both have reviewed.
    await applyOrThrow(
      pool,
      taskId,
      { type: 'review', verdict: 'approve', notes: '' },
      { kind: 'agent', role: 'reviewer_spec', version: 1 }
    );
    await applyOrThrow(
      pool,
      taskId,
      { type: 'review', verdict: 'changes', notes: 'one finding' },
      { kind: 'agent', role: 'reviewer_correctness', version: 1 }
    );
    await invite(pool, {
      publicUrl: 'https://officina.example',
      email: 'visitor@example.com',
      name: 'Visitor',
      role: 'watcher',
      domains: []
    });

    const shown = await describeTask(pool, { number: 1 });
    expect(shown).toContain(
      [
        'Reviews of build 1, the most recent first:',
        '- Code reviewer asked for changes (1 finding):',
        `    1. ${COPY}:4 Wager is still there.`
      ].join('\n')
    );
    expect(shown).toEndWith(
      'Next: the reviewers sent the latest build back with changes; what to fix is under Reviews'
    );
    const asWatcher = await describeTask(pool, { number: 1, asEmail: 'visitor@example.com' });
    expect(asWatcher).not.toContain('Reviews of build');
    expect(asWatcher).not.toContain('Wager is still there.');
  });

  test('a hand-in GitHub cannot read, or on a repository without the App, is refused with why', async () => {
    const taskId = await claimedBuild();
    const unreadable = gitHubWith({
      pushFacts: async () => {
        throw new GitHubError(404, '/repos/ViciApp/vici-app/compare', 'Not Found');
      }
    });
    const refusal = (github: HandInPort) =>
      handIn(pool, github, handInInput).then(
        () => null,
        (error: unknown) => error
      );

    const notInstalled = await refusal(unreadable);
    expect(notInstalled).toBeInstanceOf(TaskCommandError);
    expect(notInstalled).toMatchObject({
      status: 409,
      message: 'the GitHub App is not installed on this repository'
    });

    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const notPushed = await refusal(unreadable);
    expect(notPushed).toBeInstanceOf(TaskCommandError);
    expect(notPushed).toMatchObject({
      status: 409,
      message:
        'could not read the task branch on GitHub; push it first (GitHub 404 on /repos/ViciApp/vici-app/compare: Not Found)'
    });
    // Nothing was applied: the build is still the member's to hand in.
    const stage = await pool.query<{ stage: string }>('select stage from tasks where id = $1', [
      taskId
    ]);
    expect(stage.rows[0]!.stage).toBe('building');
  });
});
