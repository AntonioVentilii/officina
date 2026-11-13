import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendRunEvent,
  appendTaskEvent,
  applyCommand,
  createOnboardingTask,
  findTaskIdByNumber,
  insertLearnings,
  listLearnings,
  startRun
} from '@officina/db';
import { parseProjectConfig } from '@officina/core';
import { Pool } from 'pg';
import { resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { createApp } from '../src/app';
import { logEntries } from '../src/board';
import { invite, loginLink } from '../src/people';
import { startRealtime, type BoardEvent } from '../src/realtime';
import { createRequest, createRequestAs } from '../src/tasks';

const url = process.env.TEST_DATABASE_URL;
const PUBLIC_URL = 'https://officina.example';

describe('run log', () => {
  test('keeps what people read and drops model bookkeeping', () => {
    const at = new Date();
    const entries = logEntries([
      { id: '1', type: 'span.model_request_start', payload: {}, createdAt: at },
      {
        id: '2',
        type: 'agent.message',
        payload: { content: [{ type: 'text', text: 'Reading the spec.' }] },
        createdAt: at
      },
      {
        id: '3',
        type: 'agent.tool_use',
        payload: { name: 'bash', input: { command: 'npm run check' } },
        createdAt: at
      },
      {
        id: '4',
        type: 'agent.tool_result',
        payload: { content: [{ type: 'text', text: 'x'.repeat(5_000) }] },
        createdAt: at
      },
      {
        id: '5',
        type: 'agent.custom_tool_use',
        payload: { name: 'submit_result', input: { result: { outcome: 'pushed' } } },
        createdAt: at
      },
      { id: '6', type: 'session.status_idle', payload: {}, createdAt: at }
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'tool',
      'tool_result',
      'submitted',
      'status'
    ]);
    expect(entries[1]).toMatchObject({ name: 'bash', summary: 'npm run check' });
    expect((entries[2] as { text: string }).text).toContain('1000 more characters');
    expect(entries[3]).toMatchObject({ outcome: 'pushed' });
  });
});

describe.skipIf(!url)('board api', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;
  const app = () =>
    createApp({ pool, webhookSecret: 'x'.repeat(32), board: { publicUrl: PUBLIC_URL } });

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Response bodies are checked field by field below, so their shape stays loose here.
  const json = async (response: Response): Promise<any> => response.json();

  const tokenFrom = (link: string) => link.slice(link.indexOf('#') + 1);

  const signIn = async (link: string) => {
    const response = await app().handle(
      new Request('http://local/auth/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-officina-request': '1' },
        body: JSON.stringify({ token: tokenFrom(link) })
      })
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    return cookie.split(';')[0]!;
  };

  const call = (cookie: string | null, path: string, body?: unknown, headers = true) =>
    app().handle(
      new Request(`http://local${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(headers && body !== undefined ? { 'x-officina-request': '1' } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    );

  test('a task ready to build says it waits for the agent docs while onboarding is open', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createRequest(pool, { title: 'Rename settings', request: 'Call it Preferences.' });
    await pool.query("update tasks set stage = 'ready', lane = 'standard'");
    const board = async () =>
      (await json(await call(cookie, `/api/projects/${seeded.projectId}/board`))).tasks;
    expect((await board())[0].waitingOn.label).toBe('Waiting for a build slot');

    const { rows } = await pool.query<{ config: unknown }>('select config from projects');
    const config = parseProjectConfig(rows[0]!.config);
    if (!config.ok) throw new Error(config.errors.join('\n'));
    await createOnboardingTask(pool, {
      projectId: seeded.projectId,
      requesterId: seeded.ownerId,
      title: 'Write the agent docs',
      spec: '# Agent docs',
      paths: ['AGENTS.md'],
      config: config.config
    });
    const tasks = await board();
    const request = tasks.find((task: { number: number }) => task.number === 1);
    expect(request.waitingOn).toEqual({
      kind: 'agent',
      label: 'Builds once the agent docs of task 2 are merged',
      me: false
    });
  });

  test('a sign-in link works once and opens a session', async () => {
    const link = await loginLink(pool, { publicUrl: PUBLIC_URL });
    expect(link.startsWith(`${PUBLIC_URL}/signin#`)).toBe(true);
    const cookie = await signIn(link);

    const me = await json(await call(cookie, '/api/me'));
    expect(me.member.name).toBe('Antonio');
    expect(me.projects).toEqual([
      expect.objectContaining({ id: seeded.projectId, repo: 'ViciApp/vici-app', role: 'owner' })
    ]);

    const again = await call(null, '/auth/redeem', { token: tokenFrom(link) });
    expect(again.status).toBe(410);
    expect((await call(null, '/api/me')).status).toBe(401);

    await call(cookie, '/auth/sign-out', {});
    expect((await call(cookie, '/api/me')).status).toBe(401);
  });

  test('the board shows what waits on the viewer and applies their decisions', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });

    const board = await json(await call(cookie, `/api/projects/${seeded.projectId}/board`));
    expect(board.tasks).toEqual([
      expect.objectContaining({
        number: 1,
        stage: 'triage',
        requester: 'Antonio',
        waitingOn: { kind: 'people', label: 'A maintainer accepts or declines it', me: true }
      })
    ]);

    const forged = await call(
      cookie,
      `/api/projects/${seeded.projectId}/tasks/1/actions`,
      { type: 'accept' },
      false
    );
    expect(forged.status).toBe(403);

    const accepted = await call(cookie, `/api/projects/${seeded.projectId}/tasks/1/actions`, {
      type: 'accept'
    });
    expect(await accepted.json()).toEqual({ stage: 'speccing' });

    const conflict = await call(cookie, `/api/projects/${seeded.projectId}/tasks/1/actions`, {
      type: 'accept'
    });
    expect(conflict.status).toBe(409);

    await call(cookie, `/api/projects/${seeded.projectId}/tasks/1/comments`, { body: 'Thanks!' });
    const task = await json(await call(cookie, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(task.request).toMatchObject({ author: 'Antonio', body: 'Call it Preferences.' });
    expect(task.comments).toEqual([
      expect.objectContaining({ author: 'Antonio', body: 'Thanks!' })
    ]);
    expect(task.events.map((event: { type: string }) => event.type)).toContain('stage_changed');
    expect(task.waitingOn).toMatchObject({ kind: 'agent', me: false });
    expect(task.actions).toEqual(['cancel', 'comment']);
  });

  test('every member sees every task in the project, with who asked and who approves', async () => {
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });
    const tim = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'tim@example.com',
        name: 'Tim',
        role: 'contributor',
        domains: ['product']
      })
    );
    const watcher = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'visitor@example.com',
        name: 'Visitor',
        role: 'watcher',
        domains: []
      })
    );

    for (const cookie of [tim, watcher]) {
      const board = await json(await call(cookie, `/api/projects/${seeded.projectId}/board`));
      expect(board.tasks).toEqual([expect.objectContaining({ number: 1, requester: 'Antonio' })]);
    }

    const me = await json(await call(tim, '/api/me'));
    expect(me.projects[0].can).toEqual([
      'see',
      'request',
      'comment',
      'answer',
      'approve_spec',
      'verify_result'
    ]);
    expect((await json(await call(watcher, '/api/me'))).projects[0].can).toEqual(['see']);

    const task = await json(await call(tim, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(task.people).toEqual({
      requester: 'Antonio',
      gates: [
        {
          gate: 'spec_review',
          does: 'Approve the plan',
          current: false,
          requirements: [{ label: 'an owner', who: ['Antonio'], waived: false, approvedBy: [] }],
          asked: []
        },
        {
          gate: 'verifying',
          does: 'Check the result',
          current: false,
          requirements: [{ label: 'an owner', who: ['Antonio'], waived: false, approvedBy: [] }],
          asked: []
        }
      ],
      merge: { by: 'person', who: ['Antonio'] }
    });

    // Without an owner, the owner requirement is waived and the maintainer floor still shows.
    await pool.query(`update project_roles set role = 'maintainer' where member_id = $1`, [
      seeded.ownerId
    ]);
    const ownerless = await json(await call(tim, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(ownerless.people.gates[0].requirements).toEqual([
      { label: 'an owner', who: [], waived: true, approvedBy: [] },
      { label: 'a maintainer', who: ['Antonio'], waived: false, approvedBy: [] }
    ]);
    await pool.query(`update project_roles set role = 'owner' where member_id = $1`, [
      seeded.ownerId
    ]);

    // Once the change is user-visible, the product approver joins the result's check.
    await pool.query('update tasks set user_visible = true');
    const visible = await json(await call(tim, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(visible.people.gates[1].requirements).toEqual([
      { label: 'a product approver', who: ['Tim'], waived: false, approvedBy: [] },
      { label: 'an owner', who: ['Antonio'], waived: false, approvedBy: [] }
    ]);
  });

  test('every decision route refuses a request without the request header and changes nothing', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const run = await pool.query<{ id: string }>(
      `insert into runs (task_id, stage, runner, agent_role, agent_version, status)
       values ($1, 'done', 'managed_agents', 'learner', 1, 'succeeded') returning id`,
      [taskId]
    );
    await insertLearnings(pool, {
      projectId: seeded.projectId,
      taskId,
      runId: run.rows[0]!.id,
      learnings: [
        {
          title: 'Check every locale',
          lesson: 'Copy changes cover every live locale.',
          evidence: 'Italian was missing.',
          target: 'agent',
          edit: { file: 'agents/builder.md', text: 'Check every locale.' }
        }
      ]
    });
    const learningId = (await listLearnings(pool, seeded.projectId))[0]!.id;
    const project = `/api/projects/${seeded.projectId}`;
    const routes: [string, unknown][] = [
      [`${project}/tasks/1/actions`, { type: 'accept' }],
      [`${project}/tasks/1/comments`, { body: 'Thanks!' }],
      [`${project}/learnings/${learningId}`, { decision: 'reject' }],
      [`${project}/tasks`, { title: 'Something new', request: 'Please.' }],
      ['/auth/github/unlink', {}],
      // Last: signing out ends the session the other requests use.
      ['/auth/sign-out', {}]
    ];
    const state = async () =>
      (
        await pool.query(
          `select (select json_agg(stage order by number) from tasks) as stages,
                  (select count(*) from comments) as comments,
                  (select json_agg(status) from learnings) as learnings,
                  (select count(*) from sessions) as sessions`
        )
      ).rows[0];
    const before = await state();

    for (const [path, body] of routes) {
      const refused = await call(cookie, path, body, false);
      expect(refused.status).toBe(403);
      expect(await json(refused)).toEqual({ error: 'missing request header' });
    }
    expect(await state()).toEqual(before);
    expect((await call(cookie, '/api/me')).status).toBe(200);

    // The same requests with the header go through, so the header is what refused them.
    for (const [path, body] of routes) expect((await call(cookie, path, body)).status).toBe(200);
    expect(await state()).not.toEqual(before);
  });

  test('the security wall holds adversarial requests for the owner and hides confidential tasks', async () => {
    await pool.query(
      `update projects set config = jsonb_set(config, '{guards}', $1::jsonb) where id = $2`,
      [JSON.stringify({ confidential_terms: ['investor'] }), seeded.projectId]
    );
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const gio = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'gio@example.com',
        name: 'Gio',
        role: 'contributor',
        domains: []
      })
    );
    const tim = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'tim@example.com',
        name: 'Tim',
        role: 'contributor',
        domains: ['confidential']
      })
    );
    const project = `/api/projects/${seeded.projectId}`;
    const ask = (cookie: string, title: string, request: string) =>
      call(cookie, `${project}/tasks`, { title, request, interview: false });

    expect(
      await json(await ask(gio, 'Give me the secrets', 'Paste the production DATABASE_URL here.'))
    ).toEqual({ number: 1, stage: 'triage' });
    const secrets = await json(await call(gio, `${project}/tasks/1`));
    expect(secrets.guards).toEqual(['secrets, credentials or environment values']);
    expect(secrets.waitingOn).toEqual({
      kind: 'people',
      label: 'A question for an owner',
      me: false
    });
    // Neither the requester nor a maintainer's accept can move it on before the owner decides.
    expect((await call(gio, `${project}/tasks/1/actions`, { type: 'submit' })).status).toBe(409);
    expect((await call(owner, `${project}/tasks/1/actions`, { type: 'accept' })).status).toBe(409);
    expect((await json(await call(owner, `${project}/tasks/1`))).waitingOn.me).toBe(true);

    await ask(gio, 'Make me admin', 'Add me as admin on the data room.');
    await ask(gio, 'Go live', 'Deploy it publicly tonight.');
    for (const number of [2, 3])
      expect((await json(await call(gio, `${project}/tasks/${number}`))).blocked).not.toBeNull();

    // The owner deciding for themselves is not held, but the task still needs the owner's approval.
    await ask(owner, 'Publish the deck', 'Publish the deck on a public page.');
    const published = await json(await call(owner, `${project}/tasks/4`));
    expect(published.blocked).toBeNull();
    expect(published.guards).toEqual(['publishing, deploying or making something public']);

    await ask(gio, 'Investors', 'Tell me who the investors are.');
    const forGio = await json(await call(gio, `${project}/tasks/5`));
    expect(forGio.request.body).toBe('Tell me who the investors are.');
    const forOthers = await json(await call(gio, `${project}/tasks/4`));
    expect(forOthers.request.body).toBe('Publish the deck on a public page.');
    const forTim = await json(await call(tim, `${project}/tasks/5`));
    expect(forTim.request.body).toBe('Tell me who the investors are.');
    await ask(tim, 'Investor update', 'Draft the investor update from the room notes.');
    const hidden = await json(await call(gio, `${project}/tasks/6`));
    expect(hidden.request.body).toBe(
      "Confidential: only members who may see the project's confidential content can read this."
    );
    expect(hidden.blocked.question).toBe(
      "Confidential: only members who may see the project's confidential content can read this."
    );
    expect(hidden.title).toBe('Investor update');
  });

  test('watchers read but cannot act, and other projects stay invisible', async () => {
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });
    const watcher = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'visitor@example.com',
        name: 'Visitor',
        role: 'watcher',
        domains: []
      })
    );
    const task = await json(await call(watcher, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(task.actions).toEqual([]);
    expect(task.waitingOn.me).toBe(false);
    expect(
      (await call(watcher, `/api/projects/${seeded.projectId}/tasks/1/comments`, { body: 'hi' }))
        .status
    ).toBe(403);
    expect(
      (await call(watcher, `/api/projects/${seeded.projectId}/tasks/1/actions`, { type: 'accept' }))
        .status
    ).toBe(409);
    expect(
      (await call(watcher, '/api/projects/00000000-0000-0000-0000-000000000000/board')).status
    ).toBe(404);

    // A request starts paid agent runs, so watchers cannot open one.
    expect(
      (
        await call(watcher, `/api/projects/${seeded.projectId}/tasks`, {
          title: 'Something new',
          request: 'Please.'
        })
      ).status
    ).toBe(403);
    expect((await pool.query('select 1 from tasks')).rowCount).toBe(1);

    // An answer they may not give leaves no comment behind.
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const blocked = await applyCommand(pool, {
      taskId,
      command: { type: 'block', question: 'Which name?', askedOf: { role: 'maintainer' } },
      actor: { kind: 'engine' }
    });
    expect(blocked.ok).toBe(true);
    const comments = async () =>
      (await pool.query('select 1 from comments where task_id = $1', [taskId])).rowCount;
    const before = await comments();
    expect(
      (
        await call(watcher, `/api/projects/${seeded.projectId}/tasks/1/actions`, {
          type: 'answer',
          text: 'spam'
        })
      ).status
    ).toBe(409);
    expect(await comments()).toBe(before);
  });

  test('run logs are readable only by members of the run project', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const run = await startRun(pool, {
      taskId,
      stage: 'speccing',
      role: 'spec',
      agentVersion: 1,
      runner: 'managed_agents'
    });
    if (!run.ok) throw new Error('run not started');
    await appendRunEvent(pool, run.runId, 'agent.message', {
      content: [{ type: 'text', text: 'Hello' }]
    });
    const log = await json(await call(cookie, `/api/runs/${run.runId}/log`));
    expect(log.entries).toEqual([expect.objectContaining({ kind: 'message', text: 'Hello' })]);
    const later = await json(await call(cookie, `/api/runs/${run.runId}/log?after=${log.cursor}`));
    expect(later.entries).toEqual([]);
    expect((await call(null, `/api/runs/${run.runId}/log`)).status).toBe(401);
  });

  test("a question's options reach whoever may answer it, and picking one answers in its words", async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const contributor = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'tim@example.com',
        name: 'Tim',
        role: 'contributor',
        domains: []
      })
    );
    await createRequest(pool, { title: 'Hypothesis copy', request: 'Say it right.' });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    await applyCommand(pool, {
      taskId,
      actor: { kind: 'agent', role: 'interviewer', version: 1 },
      command: {
        type: 'block',
        question: 'What should the public room say?',
        askedOf: { memberId: seeded.ownerId },
        options: [
          { label: 'Call it a hypothesis OPTION_A' },
          {
            label: 'Lead with evidence',
            preview: { kind: 'markdown', body: '## Evidence\n\nThree pilots.' }
          }
        ]
      }
    });
    const project = `/api/projects/${seeded.projectId}`;

    const seen = await json(await call(owner, `${project}/tasks/1`));
    expect(seen.blocked.options).toEqual([
      { key: 'a', label: 'Call it a hypothesis OPTION_A' },
      {
        key: 'b',
        label: 'Lead with evidence',
        preview: { kind: 'markdown', body: '## Evidence\n\nThree pilots.' }
      }
    ]);
    const other = await json(await call(contributor, `${project}/tasks/1`));
    expect(other.blocked.options).toEqual([]);
    expect(JSON.stringify(other)).not.toContain('OPTION_A');

    const actions = `${project}/tasks/1/actions`;
    expect((await call(owner, actions, { type: 'answer' })).status).toBe(400);
    expect((await call(owner, actions, { type: 'answer', option: 'c' })).status).toBe(409);
    const answered = await call(owner, actions, { type: 'answer', option: 'b', text: 'Short.' });
    expect(answered.status).toBe(200);
    const after = await json(await call(owner, `${project}/tasks/1`));
    expect(after.blocked).toBeNull();
    expect(after.comments.at(-1)).toMatchObject({
      author: 'Antonio',
      body: 'Option (b): Lead with evidence\n\nShort.'
    });
  });

  test("an owner of one project cannot read, act on or decide another project's work", async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    // A real second project in the same workspace, owned by someone else, with a task, a run and a learning.
    const { rows } = await pool.query<{ project_id: string; member_id: string }>(
      `with m as (insert into members (workspace_id, display_name, email)
                  select workspace_id, 'Bianca', 'bianca@example.com' from projects where id = $1
                  returning id, workspace_id),
       p as (insert into projects (workspace_id, name, github_repo, config)
             select m.workspace_id, 'other-app', 'ViciApp/other-app', config
             from m, projects where projects.id = $1 returning id)
       insert into project_roles (project_id, member_id, role)
       select p.id, m.id, 'owner' from p, m returning project_id, member_id`,
      [seeded.projectId]
    );
    const other = rows[0]!.project_id;
    await createRequestAs(pool, {
      projectId: other,
      memberId: rows[0]!.member_id,
      title: 'Their task',
      request: 'Only for their project.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, other, 1))!;
    const run = await startRun(pool, {
      taskId,
      stage: 'speccing',
      role: 'spec',
      agentVersion: 1,
      runner: 'managed_agents'
    });
    if (!run.ok) throw new Error('run not started');
    await appendRunEvent(pool, run.runId, 'agent.message', {
      content: [{ type: 'text', text: 'Hello' }]
    });
    await insertLearnings(pool, {
      projectId: other,
      taskId,
      runId: run.runId,
      learnings: [
        {
          title: 'Their lesson',
          lesson: 'Only for their project.',
          evidence: 'Seen in their task.',
          target: 'agent',
          edit: { file: 'agents/builder.md', text: 'Their rule.' }
        }
      ]
    });
    const learningId = (await listLearnings(pool, other))[0]!.id;
    const theirs = `/api/projects/${other}`;
    const reads = [
      `${theirs}/board`,
      `${theirs}/tasks/1`,
      `${theirs}/runs`,
      `${theirs}/learnings`,
      `/api/runs/${run.runId}/log`
    ];
    const state = async () =>
      (
        await pool.query(
          `select (select json_agg(stage) from tasks) as stages,
                  (select count(*) from comments) as comments,
                  (select json_agg(status) from learnings) as learnings`
        )
      ).rows[0];
    const before = await state();
    const decideThroughOwn = () =>
      call(cookie, `/api/projects/${seeded.projectId}/learnings/${learningId}`, {
        decision: 'accept'
      });

    for (const path of reads) expect((await call(cookie, path)).status).toBe(404);
    expect((await call(cookie, `${theirs}/tasks/1/actions`, { type: 'accept' })).status).toBe(404);
    expect((await call(cookie, `${theirs}/tasks/1/comments`, { body: 'Hi' })).status).toBe(404);
    expect(
      (await call(cookie, `${theirs}/learnings/${learningId}`, { decision: 'accept' })).status
    ).toBe(404);
    const crossed = await decideThroughOwn();
    expect(crossed.status).toBe(409);
    expect(await json(crossed)).toEqual({ error: 'learning not found' });
    expect(await state()).toEqual(before);

    // Once they are given a role there, the same requests work, so membership is what refused them;
    // a learning is still decided only through the URL of the project it belongs to.
    await pool.query(
      `insert into project_roles (project_id, member_id, role) values ($1, $2, 'maintainer')`,
      [other, seeded.ownerId]
    );
    for (const path of reads) expect((await call(cookie, path)).status).toBe(200);
    expect((await decideThroughOwn()).status).toBe(409);
    expect(
      (await call(cookie, `${theirs}/learnings/${learningId}`, { decision: 'accept' })).status
    ).toBe(200);
  });

  test('contributors get the decisions and the trail, not agent runs, costs or learnings', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const run = await startRun(pool, {
      taskId,
      stage: 'speccing',
      role: 'spec',
      agentVersion: 1,
      runner: 'managed_agents'
    });
    if (!run.ok) throw new Error('run not started');
    const contributor = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'stakeholder@example.com',
        name: 'Stakeholder',
        role: 'contributor',
        domains: ['product']
      })
    );
    const project = `/api/projects/${seeded.projectId}`;

    const seen = await json(await call(contributor, `${project}/tasks/1`));
    expect(seen).toMatchObject({ title: 'Rename settings', costCents: null, runs: [] });
    expect(seen.events.length).toBeGreaterThan(0);
    const board = await json(await call(contributor, `${project}/board`));
    expect(board.tasks[0].costCents).toBeNull();
    // Every member gets the role names the board shows outside runs.
    expect(board.roleLabels).toMatchObject({ chooser: 'Approval chooser', learner: 'Learner' });
    for (const path of [`${project}/runs`, `${project}/learnings`, `/api/runs/${run.runId}/log`])
      expect((await call(contributor, path)).status).toBe(403);

    const full = await json(await call(owner, `${project}/tasks/1`));
    expect(full.costCents).toBe(0);
    expect(full.runs).toHaveLength(1);
    const runs = await call(owner, `${project}/runs`);
    expect(runs.status).toBe(200);
    // The Agents page takes each role's name and description from here, not its own copy.
    expect((await json(runs)).agents).toEqual([
      {
        role: 'spec',
        label: 'Spec writer',
        does: 'Reads the repo and writes a spec in its template'
      },
      {
        role: 'builder',
        label: 'Builder',
        does: 'Implements the approved spec on the task branch'
      },
      {
        role: 'reviewer_spec',
        label: 'Spec reviewer',
        does: 'Checks the diff does what the spec says, no more'
      },
      {
        role: 'reviewer_correctness',
        label: 'Code reviewer',
        does: 'Checks correctness and project conventions'
      },
      {
        role: 'chooser',
        label: 'Approval chooser',
        does: 'Decides who approves and how closely; can only raise the bar'
      },
      {
        role: 'onboarder',
        label: 'Onboarder',
        does: "Writes a new project's agent docs before anything else is built"
      }
    ]);

    // Technical detail in the trail: check output, GitHub errors, a failure asked of a maintainer.
    const engine = { kind: 'engine' } as const;
    await appendTaskEvent(pool, {
      taskId,
      actor: engine,
      type: 'ci_failed',
      payload: { details: 'SECRET check output' }
    });
    await appendTaskEvent(pool, {
      taskId,
      actor: seeded.owner,
      type: 'github_approval_failed',
      payload: { login: 'antonio', error: 'GitHub 422: SECRET body' }
    });
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'block',
        question: 'The builder step failed unexpectedly: GitHub 500 SECRET.',
        askedOf: { role: 'maintainer' }
      },
      actor: engine
    });
    const trail = await json(await call(contributor, `${project}/tasks/1`));
    expect(JSON.stringify(trail)).not.toContain('SECRET');
    expect(trail.blocked.question).toContain('for someone else to answer');
    expect(
      trail.events.find((event: { type: string }) => event.type === 'github_approval_failed')
        .payload
    ).toEqual({ login: 'antonio' });
    const cardBoard = await json(await call(contributor, `${project}/board`));
    expect(JSON.stringify(cardBoard)).not.toContain('SECRET');
    const ownerTrail = await json(await call(owner, `${project}/tasks/1`));
    expect(ownerTrail.blocked.question).toContain('GitHub 500 SECRET');
    expect(JSON.stringify(ownerTrail.events)).toContain('SECRET check output');

    // A question for one member is theirs: other contributors see only that one is open.
    await applyCommand(pool, {
      taskId,
      command: { type: 'answer', text: 'Retry it.' },
      actor: seeded.owner
    });
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'block',
        question: 'For the requester: GitHub 404 SECRET2.',
        askedOf: { memberId: seeded.ownerId }
      },
      actor: engine
    });
    const asked = await json(await call(contributor, `${project}/tasks/1`));
    expect(JSON.stringify(asked)).not.toContain('SECRET2');
    expect((await json(await call(owner, `${project}/tasks/1`))).blocked.question).toContain(
      'SECRET2'
    );
  });

  test('owners and maintainers see who accepted their invite; only owners send a fresh link', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const invited = (name: string, role: string) =>
      invite(pool, {
        publicUrl: PUBLIC_URL,
        email: `${name.toLowerCase()}@example.com`,
        name,
        role,
        domains: []
      });
    const maintainer = await signIn(await invited('Mia', 'maintainer'));
    const contributor = await signIn(await invited('Carla', 'contributor'));
    await invited('Tim', 'contributor');
    const project = `/api/projects/${seeded.projectId}`;
    interface Listed {
      id: string;
      name: string;
      firstSignedInAt: string | null;
      link: { state: string } | null;
      invitable: boolean;
    }
    const members = async (cookie: string): Promise<Listed[]> =>
      (await json(await call(cookie, `${project}/members`))).members;

    const listed = await members(owner);
    expect(listed.map((member) => [member.name, member.link?.state, member.invitable])).toEqual([
      ['Antonio', 'used', false],
      ['Mia', 'used', false],
      ['Carla', 'used', false],
      ['Tim', 'pending', true]
    ]);
    const tim = listed.find((member) => member.name === 'Tim')!;
    expect(tim.firstSignedInAt).toBeNull();
    expect(typeof listed[0]!.firstSignedInAt).toBe('string');

    expect((await members(maintainer)).some((member) => member.invitable)).toBe(false);
    expect((await call(contributor, `${project}/members`)).status).toBe(403);

    const link = `${project}/members/${tim.id}/link`;
    expect((await call(maintainer, link, {})).status).toBe(403);
    expect((await call(owner, link, {}, false)).status).toBe(403);
    const fresh = await call(owner, link, {});
    expect(fresh.status).toBe(200);
    const { url: freshUrl } = await json(fresh);
    expect(freshUrl).toStartWith(`${PUBLIC_URL}/signin#`);
    await signIn(freshUrl);
    const again = await call(owner, link, {});
    expect(again.status).toBe(409);
    expect((await json(again)).error).toBe('Tim has already signed in');
  });

  test('an accepted invite reaches the owner Inbox and leaves it once read', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const project = `/api/projects/${seeded.projectId}`;
    expect((await json(await call(owner, `${project}/notifications`))).notifications).toEqual([]);
    const tim = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'tim@example.com',
        name: 'Tim',
        role: 'contributor',
        domains: []
      })
    );

    const [notice] = (await json(await call(owner, `${project}/notifications`))).notifications;
    expect(notice).toMatchObject({
      kind: 'invite_accepted',
      text: 'Tim accepted the invite to vici-app'
    });
    expect((await json(await call(tim, `${project}/notifications`))).notifications).toEqual([]);

    const read = `/api/notifications/${notice.id}/read`;
    expect((await call(owner, read, {}, false)).status).toBe(403);
    expect((await call(tim, read, {})).status).toBe(404);
    expect((await call(owner, read, {})).status).toBe(200);
    expect((await json(await call(owner, `${project}/notifications`))).notifications).toEqual([]);
  });

  test('the stream sends a member only the events of their own projects', async () => {
    const listeners = new Set<(event: BoardEvent) => void>();
    const realtime = {
      subscribe: (listener: (event: BoardEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: async () => {}
    };
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    // A real project in the same workspace where the member has no role, so the filter is what drops it.
    const other = await pool.query<{ id: string }>(
      `insert into projects (workspace_id, name, github_repo, config)
       select workspace_id, 'other-app', 'ViciApp/other-app', config from projects where id = $1
       returning id`,
      [seeded.projectId]
    );
    const response = await createApp({
      pool,
      webhookSecret: 'x'.repeat(32),
      board: { publicUrl: PUBLIC_URL, realtime }
    }).handle(new Request('http://local/api/stream', { headers: { cookie } }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': connected')) text += decoder.decode((await reader.read()).value);
    for (const listener of listeners) {
      listener({ kind: 'task', projectId: other.rows[0]!.id, number: 7 });
      listener({ kind: 'task', projectId: seeded.projectId, number: 1 });
    }
    while (!text.includes('"number":1')) text += decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(text).toContain(`"projectId":"${seeded.projectId}"`);
    expect(text).not.toContain('"number":7');
  });

  test('database changes reach open boards as events', async () => {
    const hub = await startRealtime({ connectionString: url!, pool, log: () => {} });
    const received: BoardEvent[] = [];
    const unsubscribe = hub.subscribe((event) => received.push(event));
    try {
      await createRequest(pool, {
        title: 'Rename settings',
        request: 'Call it Preferences.',
        skipInterview: true
      });
      for (let attempt = 0; attempt < 50 && received.length === 0; attempt++) await Bun.sleep(20);
      expect(received[0]).toEqual({ kind: 'task', projectId: seeded.projectId, number: 1 });
    } finally {
      unsubscribe();
      await hub.close();
    }
  });

  test('the listening connection is pinged so it never looks idle', async () => {
    const hub = await startRealtime({
      connectionString: url!,
      pool,
      log: () => {},
      keepaliveMs: 20
    });
    try {
      let last: string | undefined;
      for (let attempt = 0; attempt < 50 && last !== 'select 1'; attempt++) {
        await Bun.sleep(20);
        const { rows } = await pool.query<{ query: string }>(
          "select query from pg_stat_activity where application_name = 'officina-realtime'"
        );
        last = rows[0]?.query;
      }
      expect(last).toBe('select 1');
    } finally {
      await hub.close();
    }
  });
});
