import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendRunEvent,
  appendTaskEvent,
  applyCommand,
  createOnboardingTask,
  findTaskIdByNumber,
  finishRun,
  HAND_IN_LEASE,
  insertLearnings,
  listLearnings,
  recordRunModel,
  renameMember,
  startRun
} from '@officina/db';
import { ENGINE, parseProjectConfig } from '@officina/core';
import { Pool } from 'pg';
import {
  applyOrThrow,
  createAutoVerifiedTask,
  createDoneTaskWithLearningPullRequest,
  createReadyTask,
  createTaskInMerging,
  createTaskInVerifying,
  createTaskWithSplit,
  PLAN,
  recordChooserChecklist,
  resetAndSeed,
  type Seeded
} from '../../../packages/db/test/seed';
import { createApp } from '../src/app';
import { agentsView, logEntries, RUN_LOG_PAGE } from '../src/board';
import { invite, loginLink } from '../src/people';
import { startRealtime, type BoardEvent } from '../src/realtime';
import { createRequest, createRequestAs, describeTask, linkTask } from '../src/tasks';
import { handleWebhookAction } from '../src/webhooks';

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

describe('agents page', () => {
  const run = (role: string, status: string, costCents: number | null) => ({
    id: `${role}-${status}`,
    taskNumber: 1,
    taskTitle: 'Rename settings',
    role,
    label: role,
    agentVersion: 1,
    stage: 'building',
    status,
    model: null,
    effort: null,
    modelReason: null,
    costCents,
    // In proportion to the cost, so each role's totals are easy to read off.
    tokens:
      costCents === null
        ? null
        : {
            input: costCents,
            output: costCents * 10,
            cacheRead: costCents * 100,
            cacheWrite: costCents * 5
          },
    startedAt: new Date(),
    finishedAt: null,
    eventCount: 0,
    consoleUrl: null,
    result: null
  });

  test('each role counts its runs, its share of finished ones that succeeded, their cost and tokens', () => {
    const view = agentsView([
      run('builder', 'succeeded', 120),
      run('builder', 'succeeded', 80),
      run('builder', 'failed', 50),
      run('builder', 'cancelled', null),
      run('builder', 'running', null),
      run('learner', 'succeeded', 30)
    ]);
    expect(view.agents.find((agent) => agent.role === 'builder')).toMatchObject({
      running: true,
      runs: 5,
      success: 67,
      costCents: 250,
      tokens: { input: 250, output: 2_500, cacheRead: 25_000, cacheWrite: 1_250 }
    });
    expect(view.agents.find((agent) => agent.role === 'spec')).toMatchObject({
      running: false,
      runs: 0,
      success: null,
      costCents: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    });
    // The learner is not listed, but what its runs cost is in the total.
    expect(view.agents.some((agent) => agent.role === 'learner')).toBe(false);
    expect(view.costCents).toBe(280);
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

  test('a proposed split shows as the latest version, waiting on a maintainer, with nothing to approve', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createTaskWithSplit(pool, seeded);
    const task = await json(await call(cookie, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(task.specs).toEqual([
      expect.objectContaining({
        version: 1,
        split: true,
        body: expect.stringContaining('**Proposed split into 2 sub-tasks.**')
      })
    ]);
    expect(task.waitingOn).toEqual({
      kind: 'people',
      label: 'A maintainer decides on the proposed split',
      me: false
    });
    expect(task.actions).not.toContain('approve');
  });

  test('a ready task that waits for other tasks says which, and offers no claim', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const shared = 'src/routes/settings/+page.svelte';
    await createReadyTask(pool, seeded, 'Settings', [shared]);
    const first = await createReadyTask(pool, seeded, 'Title', [shared]);
    const second = await createReadyTask(pool, seeded, 'Copy', [shared]);
    await createReadyTask(pool, seeded, 'Icon', ['src/lib/icon.ts']);
    await linkTask(pool, { number: 2, parent: 1, after: [] });
    await linkTask(pool, { number: 3, parent: 1, after: [] });
    await linkTask(pool, { number: 4, after: [2, 3] });
    await applyOrThrow(
      pool,
      first.id,
      { type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane: 0 },
      ENGINE
    );

    const tasks = (await json(await call(cookie, `/api/projects/${seeded.projectId}/board`))).tasks;
    const label = (number: number) =>
      tasks.find((task: { number: number }) => task.number === number).waitingOn.label;
    expect(label(1)).toBe('Built through its sub-tasks: task 2 and task 3');
    expect(label(3)).toBe('Builds once task 2 is merged: they change the same files');
    expect(label(4)).toBe('Builds once task 2 and task 3 are merged');
    for (const number of [1, 3, 4]) {
      const task = await json(
        await call(cookie, `/api/projects/${seeded.projectId}/tasks/${number}`)
      );
      expect(task.waitingOn).toEqual({ kind: 'agent', label: label(number), me: false });
      expect(task.actions).not.toContain('claim');
    }

    for (const { id } of [first, second])
      await applyOrThrow(pool, id, { type: 'cancel', reason: 'Dropped' }, seeded.owner);
    const parent = await json(await call(cookie, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(parent.waitingOn.label).toBe(
      'Never built itself: its sub-tasks (task 2 and task 3) are closed'
    );
    expect(parent.actions).not.toContain('claim');
  });

  test('a verifier records checks on the board, and the task page shows each with who and how', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const taskId = await createTaskInVerifying(pool, seeded);
    await recordChooserChecklist(pool, taskId, ['Read the title', 'Open the page']);
    const path = `/api/projects/${seeded.projectId}/tasks/1`;

    const refused = await call(cookie, `${path}/checks`, { item: 1, outcome: 'maybe' });
    expect(refused.status).toBe(400);
    const bare = await call(cookie, `${path}/checks`, { item: 1, outcome: 'ok', evidence: ' ' });
    expect(bare.status).toBe(400);
    const sent = await call(cookie, `${path}/checks`, {
      item: 2,
      outcome: 'problem',
      evidence: 'the page\nanswers 404'
    });
    expect(await json(sent)).toEqual({ recorded: true });

    const { checklist } = await json(await call(cookie, path));
    expect(checklist).toMatchObject({
      checklist: ['Read the title', 'Open the page'],
      headSha: 'abc',
      canCheck: true,
      outcomes: [
        { value: 'ok', label: 'ok' },
        { value: 'problem', label: 'problem' },
        { value: 'partial', label: 'partly checked' }
      ]
    });
    expect(checklist.checks).toMatchObject([
      {
        item: 1,
        outcome: 'problem',
        outcomeLabel: 'problem',
        by: 'Antonio on the board',
        evidence: 'the page answers 404'
      }
    ]);
    // `task show` reads the same checks.
    const cli = await describeTask(pool, { number: 1 });
    expect(cli).toContain(
      'Checklist:\n1. Read the title [not checked]\n2. Open the page [problem, Antonio on the board: the page answers 404]'
    );
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
    expect(me.limits.title).toEqual({ min: 3, max: 200 });
    expect(me.limits.prTitle).toEqual({ min: 3, max: 120 });
    expect(me.connectorUrl).toBe(`${PUBLIC_URL}/mcp`);

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
          skipped: null,
          requirements: [
            { label: 'an owner', who: [{ name: 'Antonio', approved: false }], waived: false }
          ],
          asked: []
        },
        {
          gate: 'verifying',
          does: 'Check the result',
          current: false,
          skipped: null,
          requirements: [
            { label: 'an owner', who: [{ name: 'Antonio', approved: false }], waived: false }
          ],
          asked: []
        }
      ],
      build: { by: 'agent', reason: null, who: [] },
      merge: { by: 'person', who: ['Antonio'] }
    });

    // Without an owner, the owner requirement is waived and the maintainer floor still shows.
    await pool.query(`update project_roles set role = 'maintainer' where member_id = $1`, [
      seeded.ownerId
    ]);
    const ownerless = await json(await call(tim, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(ownerless.people.gates[0].requirements).toEqual([
      { label: 'an owner', who: [], waived: true },
      { label: 'a maintainer', who: [{ name: 'Antonio', approved: false }], waived: false }
    ]);
    await pool.query(`update project_roles set role = 'owner' where member_id = $1`, [
      seeded.ownerId
    ]);

    // Once the change is user-visible, the product approver joins the result's check.
    await pool.query('update tasks set user_visible = true');
    const visible = await json(await call(tim, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(visible.people.gates[1].requirements).toEqual([
      { label: 'a product approver', who: [{ name: 'Tim', approved: false }], waived: false },
      { label: 'an owner', who: [{ name: 'Antonio', approved: false }], waived: false }
    ]);

    // A publishing guard asks for the owner the lane already asks for: still one line per gate.
    await pool.query(`update tasks set user_visible = false, guards = '{publishing}'`);
    const guarded = await json(await call(tim, `/api/projects/${seeded.projectId}/tasks/1`));
    for (const gate of guarded.people.gates) {
      expect(gate.requirements).toEqual([
        { label: 'an owner', who: [{ name: 'Antonio', approved: false }], waived: false }
      ]);
    }
  });

  test('two members with the same name each show whether they approved', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await invite(pool, {
      publicUrl: PUBLIC_URL,
      email: 'antonio.too@example.com',
      name: 'Antonio',
      role: 'owner',
      domains: []
    });
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const path = `/api/projects/${seeded.projectId}/tasks/1`;
    await call(owner, `${path}/actions`, { type: 'accept' });
    await applyCommand(pool, {
      taskId,
      command: { type: 'post_spec', predictedPaths: ['src/settings.ts'], userVisible: false },
      actor: { kind: 'agent', role: 'spec', version: 1 }
    });
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'plan_approval',
        userVisible: false,
        plan: { depth: 'glance', rationale: 'A label.', extra: [], verifiers: [] }
      },
      actor: { kind: 'engine' }
    });
    await applyCommand(pool, {
      taskId,
      command: { type: 'approve' },
      actor: { kind: 'member', memberId: seeded.ownerId }
    });

    const [requirement] = (await json(await call(owner, path))).people.gates[0].requirements;
    expect(requirement.who).toHaveLength(2);
    expect(requirement.who).toEqual(
      expect.arrayContaining([
        { name: 'Antonio', approved: true },
        { name: 'Antonio', approved: false }
      ])
    );
  });

  test('a gate already passed shows what it waived then, not who joined since', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    // The copy lane asks for a product approver on the plan; nobody holds the domain yet.
    await createTaskInMerging(pool, seeded);
    await invite(pool, {
      publicUrl: PUBLIC_URL,
      email: 'tim@example.com',
      name: 'Tim',
      role: 'contributor',
      domains: ['product']
    });

    const task = await json(await call(owner, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(task.people.gates[0].requirements).toContainEqual({
      label: 'a product approver',
      who: [],
      waived: true
    });
  });

  test('a result the lifecycle let skip the people check names no approvers', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createAutoVerifiedTask(pool, seeded);

    const task = await json(await call(owner, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(task.stage).toBe('merging');
    expect(task.people.gates[1]).toMatchObject({
      gate: 'verifying',
      skipped: expect.stringContaining('low-risk'),
      requirements: []
    });
    expect(task.people.gates[0].skipped).toBeNull();
  });

  test('the approval plan shows whom the chooser asked, and waits on them while approval is pending', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const join = (email: string, name: string, role: 'contributor' | 'watcher') =>
      invite(pool, { publicUrl: PUBLIC_URL, email, name, role, domains: [] }).then(signIn);
    const gio = await join('gio@example.com', 'Gio', 'contributor');
    const visitor = await join('visitor@example.com', 'Visitor', 'watcher');
    const tim = await join('tim@example.com', 'Tim', 'contributor');
    const idOf = async (email: string) =>
      (await pool.query<{ id: string }>('select id from members where email = $1', [email]))
        .rows[0]!.id;
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const path = `/api/projects/${seeded.projectId}/tasks/1`;
    await call(owner, `${path}/actions`, { type: 'accept' });
    await applyCommand(pool, {
      taskId,
      command: { type: 'post_spec', predictedPaths: ['src/settings.ts'], userVisible: true },
      actor: { kind: 'agent', role: 'spec', version: 1 }
    });
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'plan_approval',
        userVisible: true,
        plan: {
          depth: 'glance',
          rationale: 'A label.',
          extra: [{ requirement: { role: 'owner' }, reason: 'The settings screen is theirs.' }],
          verifiers: [{ memberId: await idOf('gio@example.com'), reason: 'Knows the screen.' }]
        }
      },
      actor: { kind: 'agent', role: 'chooser', version: 1 }
    });

    const forGio = await json(await call(gio, path));
    expect(forGio.plan).toEqual({
      gate: 'spec_review',
      current: true,
      merge: null,
      depth: 'glance',
      depthLabel: 'A careful read is enough',
      rationale: 'A label.',
      extra: [{ label: 'an owner', reason: 'The settings screen is theirs.' }],
      verifiers: [{ name: 'Gio', reason: 'Knows the screen.' }]
    });
    // Asked and allowed to approve a plan: it waits on Gio too, though the policy names an owner.
    expect(forGio.waitingOn).toEqual({
      kind: 'people',
      label: 'Plan approval by an owner',
      me: true
    });
    expect((await json(await call(owner, path))).waitingOn.me).toBe(true);
    // Nobody else is waited on: not a contributor nobody asked, not a watcher.
    expect((await json(await call(tim, path))).waitingOn.me).toBe(false);
    expect((await json(await call(visitor, path))).waitingOn.me).toBe(false);

    // Asked, but no longer allowed to approve a plan: it no longer waits on Gio.
    await pool.query(`update project_roles set role = 'watcher' where member_id = $1`, [
      await idOf('gio@example.com')
    ]);
    expect((await json(await call(gio, path))).waitingOn.me).toBe(false);
  });

  test('asking for changes is offered only to the people the gate names, as the lifecycle allows', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const tim = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'tim@example.com',
        name: 'Tim',
        role: 'contributor',
        domains: []
      })
    );
    await createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const path = `/api/projects/${seeded.projectId}/tasks/1`;
    await call(owner, `${path}/actions`, { type: 'accept' });
    await applyCommand(pool, {
      taskId,
      command: { type: 'post_spec', predictedPaths: ['src/settings.ts'], userVisible: false },
      actor: { kind: 'agent', role: 'spec', version: 1 }
    });
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'plan_approval',
        userVisible: false,
        plan: { depth: 'glance', rationale: 'A label.', extra: [], verifiers: [] }
      },
      actor: { kind: 'agent', role: 'chooser', version: 1 }
    });

    // The plan needs an owner; a contributor may approve plans but is not named, so cannot send it back.
    expect((await json(await call(owner, path))).actions).toEqual(
      expect.arrayContaining(['approve', 'changes'])
    );
    const forTim = await json(await call(tim, path));
    expect(forTim.stage).toBe('spec_review');
    expect(forTim.actions).toContain('approve');
    expect(forTim.actions).not.toContain('changes');
    const refused = await call(tim, `${path}/actions`, { type: 'changes', note: 'Too short.' });
    expect(refused.status).toBe(409);
    expect((await json(await call(tim, path))).stage).toBe('spec_review');
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
      [`${project}/learnings/${learningId}`, { decision: 'reject', rewrittenAt: null }],
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

    // Every route that changes something, read off the app so a new one cannot miss the check;
    // only the ones GitHub, an OAuth client and an MCP client call answer without the header.
    const headerFree = new Set(['/github/webhook', '/oauth/register', '/oauth/token', '/mcp']);
    const params: Record<string, string> = {
      projectId: seeded.projectId,
      number: '1',
      learningId
    };
    const changing = app()
      .routes.filter((route) => route.method !== 'GET' && !headerFree.has(route.path))
      .map((route) => ({
        method: route.method,
        path: route.path.replace(
          /:(\w+)/g,
          (_, name: string) => params[name] ?? crypto.randomUUID()
        )
      }));
    // The routes tried with the header below are among them, so the list is not empty.
    for (const [path] of routes) expect(changing).toContainEqual({ method: 'POST', path });
    for (const { method, path } of changing) {
      const refused = await app().handle(
        new Request(`http://local${path}`, {
          method,
          headers: { cookie, 'content-type': 'application/json' },
          body: '{}'
        })
      );
      expect({ method, path, status: refused.status }).toEqual({ method, path, status: 403 });
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
    ).toEqual({ number: 1, stage: 'request' });
    const secrets = await json(await call(gio, `${project}/tasks/1`));
    expect(secrets.guards).toEqual(['secrets, credentials or environment values']);
    expect(secrets.waitingOn).toEqual({
      kind: 'people',
      label: 'A question for an owner',
      me: false
    });
    // Neither the requester nor a maintainer's accept can move it on before the owner decides,
    // and the board does not offer to send it on as it is.
    expect(secrets.actions).not.toContain('submit');
    expect((await json(await call(owner, `${project}/tasks/1`))).actions).not.toContain('submit');
    expect((await call(gio, `${project}/tasks/1/actions`, { type: 'submit' })).status).toBe(409);
    expect((await call(owner, `${project}/tasks/1/actions`, { type: 'accept' })).status).toBe(409);
    expect((await json(await call(owner, `${project}/tasks/1`))).waitingOn.me).toBe(true);
    expect(await describeTask(pool, { number: 1, asEmail: 'gio@example.com' })).toContain(
      'BLOCKED, question for an owner:'
    );

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

    // Its pull request is the confidential change itself: no link, number or head for Gio.
    await pool.query(`update tasks set github_pr = 12, head_sha = 'abc' where number = 6`);
    const linkless = await json(await call(gio, `${project}/tasks/6`));
    expect([linkless.pullRequest, linkless.pullRequestUrl, linkless.headSha]).toEqual([
      null,
      null,
      null
    ]);
    expect((await json(await call(tim, `${project}/tasks/6`))).pullRequest).toBe(12);
    const cli = await describeTask(pool, { number: 6, asEmail: 'gio@example.com' });
    expect(cli).toContain('Confidential: only members');
    expect(cli).not.toContain('Draft the investor update');
    expect(cli).not.toContain('/pull/12');
  });

  test('who may not read a confidential task reads no reason on it and writes nothing on it', async () => {
    const hiddenText =
      "Confidential: only members who may see the project's confidential content can read this.";
    await pool.query(
      `update projects set config = jsonb_set(config, '{guards}', $1::jsonb) where id = $2`,
      [JSON.stringify({ confidential_terms: ['investor'] }), seeded.projectId]
    );
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const member = (name: string, domains: string[]) =>
      invite(pool, {
        publicUrl: PUBLIC_URL,
        email: `${name}@example.com`,
        name,
        role: 'contributor',
        domains
      }).then(signIn);
    const gio = await member('gio', []);
    const tim = await member('tim', ['confidential']);
    await createRequest(pool, {
      title: 'Investor deck',
      request: 'Draft the investor deck.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const path = `/api/projects/${seeded.projectId}/tasks/1`;
    const engine = { kind: 'engine' } as const;
    await call(owner, `${path}/actions`, { type: 'accept' });
    await applyCommand(pool, {
      taskId,
      command: { type: 'post_spec', predictedPaths: ['src/deck.ts'], userVisible: false },
      actor: { kind: 'agent', role: 'spec', version: 1 }
    });
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'plan_approval',
        userVisible: false,
        plan: {
          depth: 'glance',
          rationale: 'The deck.',
          extra: [],
          verifiers: [],
          build: 'person',
          buildReason: 'The figures of the Series B round are in the room.'
        }
      },
      actor: engine
    });
    await applyCommand(pool, {
      taskId,
      command: { type: 'approve' },
      actor: { kind: 'member', memberId: seeded.ownerId }
    });

    const forGio = await json(await call(gio, path));
    expect(forGio.waitingOn.label).toBe(
      `Needs a developer: a developer claims the build. ${hiddenText}`
    );
    expect(forGio.people.build.reason).toBe(hiddenText);
    expect(JSON.stringify(forGio)).not.toContain('Series B');
    expect(forGio.actions).not.toContain('comment');
    const board = await json(await call(gio, `/api/projects/${seeded.projectId}/board`));
    expect(JSON.stringify(board)).not.toContain('Series B');
    expect((await json(await call(tim, path))).people.build.reason).toContain('Series B');

    expect((await call(gio, `${path}/comments`, { body: 'Who are they?' })).status).toBe(403);
    expect((await call(tim, `${path}/comments`, { body: 'I can help.' })).status).toBe(200);

    await applyCommand(pool, {
      taskId,
      command: {
        type: 'block',
        question: 'Which round?',
        askedOf: { role: 'contributor' },
        options: [{ label: 'Series B at 40 million' }, { label: 'Series A' }]
      },
      actor: engine
    });
    expect((await json(await call(gio, path))).actions).not.toContain('answer');
    const { version } = (await json(await call(tim, path))).blocked;
    const pick = { type: 'answer', text: '', option: 'a', version };
    const answered = await call(gio, `${path}/actions`, pick);
    expect(answered.status).toBe(409);
    const comments = await pool.query<{ body: string }>(
      'select body from comments where task_id = $1 order by created_at',
      [taskId]
    );
    expect(comments.rows.map((row) => row.body)).toEqual([
      'Draft the investor deck.',
      'I can help.'
    ]);
    expect((await call(tim, `${path}/actions`, pick)).status).toBe(200);
  });

  test('what agents cannot do, and what a developer must build, waits on the right person', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const contributor = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'gio@example.com',
        name: 'Gio',
        role: 'contributor',
        domains: []
      })
    );
    await createRequest(pool, {
      title: 'Publish the deck',
      request: 'Put it on deck.example.app.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const engine = { kind: 'engine' } as const;
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'block',
        question: 'There is no such domain.\n\nNeeded:\n- Create deck.example.app',
        askedOf: { role: 'owner' },
        handoff: { needs: ['dns', 'publishing'] }
      },
      actor: engine
    });
    const path = `/api/projects/${seeded.projectId}/tasks/1`;
    const held = await json(await call(contributor, path));
    expect(held.waitingOn).toEqual({
      kind: 'people',
      label:
        'Agents cannot go on: needs an owner for a domain or a DNS change, publishing or exposing content somewhere new',
      me: false
    });
    expect(held.blocked.needs).toEqual([
      'a domain or a DNS change',
      'publishing or exposing content somewhere new'
    ]);
    expect((await json(await call(owner, path))).waitingOn.me).toBe(true);

    // The owner answers; then the plan asks for a developer instead of the build agent.
    await call(owner, `${path}/actions`, { type: 'answer', text: 'Created it.' });
    await call(owner, `${path}/actions`, { type: 'accept' });
    const asOwner = { kind: 'member', memberId: seeded.ownerId } as const;
    await applyCommand(pool, {
      taskId,
      command: { type: 'post_spec', predictedPaths: ['src/deck.ts'], userVisible: true },
      actor: { kind: 'agent', role: 'spec', version: 1 }
    });
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'plan_approval',
        userVisible: true,
        plan: {
          depth: 'test',
          rationale: 'A new public page.',
          extra: [],
          verifiers: [],
          build: 'person',
          buildReason: 'It needs the hosting set up by hand.'
        }
      },
      actor: engine
    });
    await applyCommand(pool, { taskId, command: { type: 'approve' }, actor: asOwner });

    const ready = await json(await call(owner, path));
    expect(ready.waitingOn).toEqual({
      kind: 'people',
      label:
        'Needs a developer: a developer claims the build. It needs the hosting set up by hand.',
      me: true
    });
    expect(ready.actions).toContain('claim');
    expect(ready.people.build).toEqual({
      by: 'person',
      reason: 'It needs the hosting set up by hand.',
      who: ['Antonio']
    });
    expect((await json(await call(contributor, path))).actions).not.toContain('claim');
    expect((await call(contributor, `${path}/actions`, { type: 'claim' })).status).toBe(409);

    // A developer is a contributor with the `developer` domain: they claim it and hand it in.
    const developer = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'dev@example.com',
        name: 'Dev',
        role: 'contributor',
        domains: ['developer']
      })
    );
    expect((await json(await call(developer, path))).people.build.who).toEqual(['Antonio', 'Dev']);
    expect(await json(await call(developer, `${path}/actions`, { type: 'claim' }))).toEqual({
      stage: 'building'
    });
    const building = await json(await call(developer, path));
    expect(building.actions).toContain('hand_in');
    expect(building.branch).toBe(`officina/task-${building.number}`);
    expect(building.waitingOn).toEqual({
      kind: 'people',
      label: 'Dev is building it, then hands it in',
      me: true
    });
    expect((await json(await call(owner, path))).actions).not.toContain('hand_in');

    // While their hand-in runs, every board shows it at work and nothing waits on them.
    await pool.query(
      `update tasks set hand_in_claim = gen_random_uuid(), hand_in_claimed_at = clock_timestamp(),
         hand_in_claimed_by = (select id from members where display_name = 'Dev')
       where id = $1`,
      [taskId]
    );
    const handingIn = await json(await call(developer, path));
    expect(handingIn.handingIn).toMatchObject({ by: 'Dev', you: true });
    expect(handingIn.waitingOn).toEqual({
      kind: 'people',
      label: 'Dev is handing the build in',
      me: false
    });
    expect((await json(await call(owner, path))).handingIn).toMatchObject({
      by: 'Dev',
      you: false
    });
    // Nothing else changes the task meanwhile, from the board, the connector or the CLI.
    expect(handingIn.actions).not.toContain('hand_back');
    expect(handingIn.actions).not.toContain('hand_in');
    const refused = await call(developer, `${path}/actions`, { type: 'release' });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({
      error: 'this build is being handed in; wait for it to finish'
    });
    await pool.query(
      `update tasks set hand_in_claimed_at = clock_timestamp() - $2::interval - interval '1 second'
       where id = $1`,
      [taskId, HAND_IN_LEASE]
    );
    expect((await json(await call(developer, path))).handingIn).toBeNull();

    const handIn = await call(developer, `${path}/hand-in`, { prTitle: 'feat(deck): publish it' });
    expect(handIn.status).toBe(503);
    expect(await json(handIn)).toEqual({ error: 'the GitHub App is not configured' });

    // A person lists as many checks as the builder may, and no more.
    const checks = (count: number) => Array.from({ length: count }, (_, i) => `check ${i}`);
    const handInWith = (count: number) =>
      call(developer, `${path}/hand-in`, {
        prTitle: 'feat(deck): publish it',
        verified: checks(count),
        notVerified: checks(count)
      });
    expect((await handInWith(30)).status).toBe(503);
    expect((await handInWith(31)).status).toBe(400);
  });

  test('a claimed build is handed back from the board by its builder or whoever may steer, by no one else', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const developer = (email: string, name: string) =>
      invite(pool, {
        publicUrl: PUBLIC_URL,
        email,
        name,
        role: 'contributor',
        domains: ['developer']
      }).then(signIn);
    const builder = await developer('dev@example.com', 'Dev');
    const other = await developer('ada@example.com', 'Ada');
    const maintainer = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'mai@example.com',
        name: 'Mai',
        role: 'maintainer',
        domains: []
      })
    );
    await createRequest(pool, {
      title: 'Publish the deck',
      request: 'Put it on deck.example.app.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const path = `/api/projects/${seeded.projectId}/tasks/1`;
    await call(owner, `${path}/actions`, { type: 'accept' });
    await applyCommand(pool, {
      taskId,
      command: { type: 'post_spec', predictedPaths: ['src/deck.ts'], userVisible: true },
      actor: { kind: 'agent', role: 'spec', version: 1 }
    });
    await applyCommand(pool, {
      taskId,
      command: {
        type: 'plan_approval',
        userVisible: true,
        plan: {
          depth: 'test',
          rationale: 'A new public page.',
          extra: [],
          verifiers: [],
          build: 'person',
          buildReason: 'It needs the hosting set up by hand.'
        }
      },
      actor: { kind: 'engine' }
    });
    await call(owner, `${path}/actions`, { type: 'approve' });
    const handBack = (cookie: string) => call(cookie, `${path}/actions`, { type: 'release' });

    // The builder sees it next to handing in; another developer neither sees it nor may do it.
    await call(builder, `${path}/actions`, { type: 'claim' });
    expect((await json(await call(builder, path))).actions).toEqual(
      expect.arrayContaining(['hand_in', 'hand_back'])
    );
    expect((await json(await call(other, path))).actions).not.toContain('hand_back');
    const refused = await handBack(other);
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ error: 'you do not have the role needed for that' });
    expect((await json(await call(owner, path))).stage).toBe('building');

    expect(await json(await handBack(builder))).toEqual({ stage: 'ready' });
    const ready = await json(await call(builder, path));
    expect(ready.actions).toContain('claim');
    expect(ready.actions).not.toContain('hand_back');

    // A maintainer may steer, so they hand back another person's build too.
    await call(builder, `${path}/actions`, { type: 'claim' });
    expect((await json(await call(maintainer, path))).actions).toContain('hand_back');
    expect(await json(await handBack(maintainer))).toEqual({ stage: 'ready' });
    expect((await handBack(maintainer)).status).toBe(409);
  });

  test('only the owner allows a red task more lines, and everyone sees who allowed it and when', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const join = async (email: string, role: 'maintainer' | 'contributor') =>
      signIn(await invite(pool, { publicUrl: PUBLIC_URL, email, name: email, role, domains: [] }));
    const maintainer = await join('marta@example.com', 'maintainer');
    const contributor = await join('gio@example.com', 'contributor');
    await createRequest(pool, {
      title: 'Port the room',
      request: 'Bring the room up to V8.',
      skipInterview: true
    });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const path = `/api/projects/${seeded.projectId}/tasks/1`;
    const room = ['src/satellite/room.ts'];
    const asOwner = { kind: 'member', memberId: seeded.ownerId } as const;
    for (const [command, actor] of [
      [{ type: 'accept' }, asOwner],
      [
        { type: 'post_spec', predictedPaths: room, userVisible: false },
        { kind: 'agent', role: 'spec', version: 1 }
      ],
      [{ type: 'plan_approval', userVisible: false, plan: PLAN }, { kind: 'engine' }],
      [{ type: 'approve' }, asOwner],
      [{ type: 'claim' }, asOwner],
      [
        {
          type: 'push',
          headSha: 'port',
          changedPaths: room,
          addedPaths: [],
          catalogPages: {},
          diffLines: 2449
        },
        asOwner
      ]
    ] as const)
      await applyCommand(pool, { taskId, command, actor });

    const held = await json(await call(maintainer, path));
    expect(held.blocked.options.map((option: { key: string }) => option.key)).toEqual([
      'a',
      'b',
      'c'
    ]);
    expect(held.blocked.options[2].label).toBe('Allow 2449 lines for this task');
    const pick = { type: 'answer', option: 'c', version: held.blocked.version };
    const refused = await call(maintainer, `${path}/actions`, pick);
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ error: 'you do not have the role needed for that' });
    expect((await call(owner, `${path}/actions`, pick)).status).toBe(200);

    const seen = await json(await call(contributor, path));
    expect(seen.allowance).toMatchObject({ lines: 2449, lane: 'red', by: 'Antonio' });
    expect(typeof seen.allowance.at).toBe('string');
    expect(
      seen.events.find((event: { type: string }) => event.type === 'diff_allowed').payload
    ).toEqual({
      lines: 2449,
      lane: 'red',
      memberId: seeded.ownerId
    });
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
    // A secret an agent says on the way is redacted before it is stored, not only when shown.
    await appendRunEvent(pool, run.runId, 'agent.message', {
      content: [{ type: 'text', text: 'Found PASSWORD="hunter2 secret" in config.' }]
    });
    const log = await json(await call(cookie, `/api/runs/${run.runId}/log`));
    expect(log.entries).toEqual([
      expect.objectContaining({ kind: 'message', text: 'Hello' }),
      expect.objectContaining({
        kind: 'message',
        text: 'Found PASSWORD=[redacted: looks like a secret] in config.'
      })
    ]);
    const later = await json(await call(cookie, `/api/runs/${run.runId}/log?after=${log.cursor}`));
    expect(later.entries).toEqual([]);
    expect((await call(null, `/api/runs/${run.runId}/log`)).status).toBe(401);
  });

  test('a run log page of events the log drops still says more are left', async () => {
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
    // A full page of model spans, which the log leaves out, before the message it shows.
    await pool.query(
      `insert into run_events (run_id, type, payload)
       select $1, 'span.model_request_start', '{}'::jsonb from generate_series(1, $2)`,
      [run.runId, RUN_LOG_PAGE]
    );
    await appendRunEvent(pool, run.runId, 'agent.message', {
      content: [{ type: 'text', text: 'Done' }]
    });
    const first = await json(await call(cookie, `/api/runs/${run.runId}/log`));
    expect(first.entries).toEqual([]);
    expect(first.more).toBe(true);
    const next = await json(await call(cookie, `/api/runs/${run.runId}/log?after=${first.cursor}`));
    expect(next.entries).toEqual([expect.objectContaining({ kind: 'message', text: 'Done' })]);
    expect(next.more).toBe(false);
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
    const version = seen.blocked.version;
    expect((await call(owner, actions, { type: 'answer' })).status).toBe(400);
    expect((await call(owner, actions, { type: 'answer', option: 'b' })).status).toBe(400);
    expect((await call(owner, actions, { type: 'answer', option: 'c', version })).status).toBe(409);
    const answered = await call(owner, actions, {
      type: 'answer',
      option: 'b',
      text: 'Short.',
      version
    });
    expect(answered.status).toBe(200);
    const after = await json(await call(owner, `${project}/tasks/1`));
    expect(after.blocked).toBeNull();
    expect(after.comments.at(-1)).toMatchObject({
      author: 'Antonio',
      body: 'Option (b): Lead with evidence\n\nShort.'
    });
  });

  test('an option picked on a screen that shows an older question answers nothing', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createRequest(pool, { title: 'Hypothesis copy', request: 'Say it right.' });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    const ask = (question: string) =>
      applyCommand(pool, {
        taskId,
        actor: { kind: 'agent', role: 'interviewer', version: 1 },
        command: {
          type: 'block',
          question,
          askedOf: { memberId: seeded.ownerId },
          options: [{ label: 'Yes' }, { label: 'No' }]
        }
      });
    const project = `/api/projects/${seeded.projectId}`;
    await ask('Keep the old name?');
    const stale = (await json(await call(owner, `${project}/tasks/1`))).blocked.version;

    // Meanwhile the question is answered elsewhere and a new one with the same letters arrives.
    await applyCommand(pool, {
      taskId,
      actor: seeded.owner,
      command: { type: 'answer', text: 'Keep it.' }
    });
    await ask('Delete the archive?');
    const actions = `${project}/tasks/1/actions`;
    const refused = await call(owner, actions, { type: 'answer', option: 'a', version: stale });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toContain('changed since you read this question');
    const open = await json(await call(owner, `${project}/tasks/1`));
    expect(open.blocked.question).toBe('Delete the archive?');

    const answered = await call(owner, actions, {
      type: 'answer',
      option: 'b',
      version: open.blocked.version
    });
    expect(answered.status).toBe(200);
    expect((await json(await call(owner, `${project}/tasks/1`))).comments.at(-1).body).toBe(
      'Option (b): No'
    );
  });

  test('a paused task with an open question reads Paused and waits only on whoever may steer', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const contributor = await signIn(
      await invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'gio@example.com',
        name: 'Gio',
        role: 'contributor',
        domains: []
      })
    );
    const gioId = (
      await pool.query<{ id: string }>("select id from members where email = 'gio@example.com'")
    ).rows[0]!.id;
    await createRequest(pool, { title: 'Rename the Wager button', request: 'Say Prediction.' });
    const taskId = (await findTaskIdByNumber(pool, seeded.projectId, 1))!;
    await applyCommand(pool, {
      taskId,
      actor: { kind: 'agent', role: 'interviewer', version: 1 },
      command: { type: 'block', question: 'Which name?', askedOf: { memberId: gioId } }
    });
    const project = `/api/projects/${seeded.projectId}`;
    const views = async (cookie: string) => {
      const task = await json(await call(cookie, `${project}/tasks/1`));
      const card = (await json(await call(cookie, `${project}/board`))).tasks.find(
        (item: { number: number }) => item.number === 1
      );
      return [task, card];
    };
    const paused = (me: boolean) => ({ kind: 'people', label: 'Paused', me });

    await applyCommand(pool, { taskId, actor: seeded.owner, command: { type: 'pause' } });
    for (const view of await views(owner)) {
      expect(view.waitingOn).toEqual(paused(true));
      expect(view.paused).toBe(true);
      expect(view.blocked.question).toBe('Which name?');
    }
    for (const view of await views(contributor)) {
      expect(view.waitingOn).toEqual(paused(false));
      expect(view.paused).toBe(true);
      expect(view.blocked.question).toBe('Which name?');
    }

    await applyCommand(pool, { taskId, actor: seeded.owner, command: { type: 'resume' } });
    for (const view of await views(contributor))
      expect(view.waitingOn).toEqual({ kind: 'people', label: 'A question for Gio', me: true });
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
        decision: 'accept',
        rewrittenAt: null
      });

    for (const path of reads) expect((await call(cookie, path)).status).toBe(404);
    expect((await call(cookie, `${theirs}/tasks/1/actions`, { type: 'accept' })).status).toBe(404);
    expect((await call(cookie, `${theirs}/tasks/1/comments`, { body: 'Hi' })).status).toBe(404);
    expect(
      (
        await call(cookie, `${theirs}/learnings/${learningId}`, {
          decision: 'accept',
          rewrittenAt: null
        })
      ).status
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
      (
        await call(cookie, `${theirs}/learnings/${learningId}`, {
          decision: 'accept',
          rewrittenAt: null
        })
      ).status
    ).toBe(200);
  });

  test('a done task shows its open learning pull request and waits on whoever merges, until it closes', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createDoneTaskWithLearningPullRequest(pool, seeded, 1498);
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
    const pr = { number: 1498, url: 'https://github.com/ViciApp/vici-app/pull/1498' };

    const task = await json(await call(owner, `${project}/tasks/1`));
    expect(task.stage).toBe('done');
    expect(task.learningPullRequests).toEqual([{ ...pr, state: 'open' }]);
    expect(task.waitingOn).toEqual({
      kind: 'github',
      label: 'Merge the learning pull request #1498 on GitHub',
      me: true
    });
    const board = await json(await call(owner, `${project}/board`));
    expect(board.tasks[0].waitingOn.me).toBe(true);
    // Contributors see no learnings, so neither the pull request nor a wait on it.
    const seen = await json(await call(contributor, `${project}/tasks/1`));
    expect(seen.learningPullRequests).toEqual([]);
    expect(seen.waitingOn).toEqual({ kind: 'nobody', label: 'done', me: false });

    await handleWebhookAction(pool, {
      kind: 'pull_request_closed',
      repo: 'ViciApp/vici-app',
      prNumber: 1498
    });
    const closed = await json(await call(owner, `${project}/tasks/1`));
    expect(closed.stage).toBe('done');
    expect(closed.learningPullRequests).toEqual([{ ...pr, state: 'closed' }]);
    expect(closed.waitingOn).toEqual({ kind: 'nobody', label: 'done', me: false });
    const [learning] = (await json(await call(owner, `${project}/learnings`))).learnings;
    expect(learning).toMatchObject({ status: 'accepted', prNumber: 1498, prState: 'closed' });
  });

  test('a merged learning pull request leaves its done task waiting on nobody', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await createDoneTaskWithLearningPullRequest(pool, seeded, 1498);
    await handleWebhookAction(pool, {
      kind: 'pull_request_merged',
      repo: 'ViciApp/vici-app',
      prNumber: 1498
    });
    const task = await json(await call(owner, `/api/projects/${seeded.projectId}/tasks/1`));
    expect(task.learningPullRequests).toMatchObject([{ number: 1498, state: 'merged' }]);
    expect(task.waitingOn.kind).toBe('nobody');
  });

  test('a run shows the model its session ran at, the effort and why', async () => {
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
    await recordRunModel(pool, run.runId, {
      model: 'claude-opus-5-5',
      effort: 'high',
      reason: 'red lane'
    });
    const { runs } = await json(await call(owner, `/api/projects/${seeded.projectId}/runs`));
    expect(runs[0]).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      modelReason: 'red lane'
    });
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
    // The Agents page takes each role's name, description and numbers from here, not its own copy.
    const { agents } = await json(runs);
    expect(agents[0]).toMatchObject({ running: true, runs: 1, success: null, costCents: 0 });
    expect(
      agents.map(({ role, label, does }: Record<string, unknown>) => ({ role, label, does }))
    ).toEqual([
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
    await appendTaskEvent(pool, {
      taskId,
      actor: engine,
      type: 'head_carried',
      payload: { headSha: 'carried1', from: 'abc' }
    });
    await appendTaskEvent(pool, {
      taskId,
      actor: seeded.owner,
      type: 'github_copilot_review_requested',
      payload: { pullRequest: 7, login: 'antonio', outcome: 'already_reviewed' }
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
    // The timeline names the carried head for everyone, as it names every push.
    expect(
      trail.events.find((event: { type: string }) => event.type === 'head_carried').payload
    ).toEqual({ headSha: 'carried1' });
    // Everyone reads whether Copilot was asked or had already reviewed, so the timeline can say which.
    expect(
      trail.events.find(
        (event: { type: string }) => event.type === 'github_copilot_review_requested'
      ).payload
    ).toEqual({ pullRequest: 7, login: 'antonio', outcome: 'already_reviewed' });
    const cardBoard = await json(await call(contributor, `${project}/board`));
    expect(JSON.stringify(cardBoard)).not.toContain('SECRET');
    // The CLI reads the question as the board does.
    const cli = await describeTask(pool, { number: 1, asEmail: 'stakeholder@example.com' });
    expect(cli).toContain('BLOCKED, question for a maintainer:');
    expect(cli).toContain('for someone else to answer');
    expect(cli).not.toContain('SECRET');
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

  test("a finished run shows what its session used, and its role's totals add it up", async () => {
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
    const tokens = { input: 164, output: 72_500, cacheRead: 13_700_000, cacheWrite: 269_000 };
    await finishRun(pool, run.runId, {
      status: 'succeeded',
      usage: { costCents: 556, tokens },
      result: {}
    });

    const view = await json(await call(owner, `/api/projects/${seeded.projectId}/runs`));
    expect(view.runs).toMatchObject([{ costCents: 556, tokens }]);
    expect(view.agents[0]).toMatchObject({ role: 'spec', costCents: 556, tokens });
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
    const { url: freshUrl, validDays } = await json(fresh);
    expect(freshUrl).toStartWith(`${PUBLIC_URL}/signin#`);
    expect(validDays).toBe(7);
    await signIn(freshUrl);
    const again = await call(owner, link, {});
    expect(again.status).toBe(409);
    expect((await json(again)).error).toBe('Tim has already signed in');
  });

  test('a fresh link is only for a member whose every project the owner owns', async () => {
    const owner = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    await invite(pool, {
      publicUrl: PUBLIC_URL,
      email: 'tim@example.com',
      name: 'Tim',
      role: 'contributor',
      domains: []
    });
    const tim = (
      await pool.query<{ id: string }>("select id from members where email = 'tim@example.com'")
    ).rows[0]!.id;
    await pool.query(
      `with p as (insert into projects (workspace_id, name, github_repo)
                  select workspace_id, 'tims-app', 'Tim/tims-app' from projects where id = $1
                  returning id)
       insert into project_roles (project_id, member_id, role) select id, $2, 'owner' from p`,
      [seeded.projectId, tim]
    );
    const project = `/api/projects/${seeded.projectId}`;
    const listed = (await json(await call(owner, `${project}/members`))).members;
    expect(listed.find((member: { name: string }) => member.name === 'Tim').invitable).toBe(false);
    const refused = await call(owner, `${project}/members/${tim}/link`, {});
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toContain('also in a project you do not own');
  });

  test('a member renames themselves; an owner renames the members they manage everywhere', async () => {
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
    const project = `/api/projects/${seeded.projectId}`;
    interface Listed {
      name: string;
      renamable: boolean;
    }
    const ids = Object.fromEntries(
      (
        await pool.query<{ id: string; display_name: string }>(
          'select id, display_name from members'
        )
      ).rows.map((row) => [row.display_name, row.id])
    );
    const nameOf = (id: string) => `${project}/members/${id}/name`;

    const listed = async (cookie: string) =>
      ((await json(await call(cookie, `${project}/members`))).members as Listed[]).map((member) => [
        member.name,
        member.renamable
      ]);
    expect(await listed(owner)).toEqual([
      ['Antonio', true],
      ['Mia', true],
      ['Carla', true]
    ]);
    expect(await listed(maintainer)).toEqual([
      ['Antonio', false],
      ['Mia', true],
      ['Carla', false]
    ]);

    // A contributor has no Members page, but their own name is still theirs to change.
    const self = await call(contributor, nameOf(ids.Carla!), { name: ' Carla Bianchi ' });
    expect(self.status).toBe(200);
    expect(await json(self)).toEqual({ name: 'Carla Bianchi' });
    expect((await call(contributor, nameOf(ids.Mia!), { name: 'Mia Verdi' })).status).toBe(403);
    expect((await call(maintainer, nameOf(ids.Carla!), { name: 'Carla Verdi' })).status).toBe(403);
    expect((await call(owner, nameOf(ids.Mia!), { name: 'Mia Verdi' }, false)).status).toBe(403);
    expect((await call(owner, nameOf(ids.Mia!), { name: '  ' })).status).toBe(400);
    expect((await call(owner, nameOf(ids.Mia!), { name: 'M'.repeat(101) })).status).toBe(400);
    expect((await call(owner, nameOf('not-a-uuid'), { name: 'Mia Verdi' })).status).toBe(404);
    // The same rename sent twice records it once.
    expect((await call(owner, nameOf(ids.Mia!), { name: 'Mia Verdi' })).status).toBe(200);
    expect((await call(owner, nameOf(ids.Mia!), { name: 'Mia Verdi' })).status).toBe(200);

    const me = await json(await call(maintainer, '/api/me'));
    expect(me.member.name).toBe('Mia Verdi');
    const log = (await json(await call(owner, `${project}/access-log`))).events.filter(
      (event: { text: string }) => event.text.startsWith('was renamed')
    );
    expect(
      log.map((event: { member: string; text: string }) => [event.member, event.text])
    ).toEqual([
      ['Mia Verdi', 'was renamed from Mia to Mia Verdi by Antonio'],
      ['Carla Bianchi', 'was renamed from Carla to Carla Bianchi']
    ]);
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

  /** Opens the stream on a hub the test fires by hand; `read` reads until `enough` holds or it ends. */
  const openStream = async (cookie: string, heartbeatMs?: number) => {
    const listeners = new Set<(event: BoardEvent) => void>();
    const realtime = {
      subscribe: (listener: (event: BoardEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: async () => {}
    };
    const response = await createApp({
      pool,
      webhookSecret: 'x'.repeat(32),
      board: { publicUrl: PUBLIC_URL, realtime, heartbeatMs }
    }).handle(new Request('http://local/api/stream', { headers: { cookie } }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (enough: (text: string) => boolean) => {
      while (!enough(text)) {
        const chunk = await reader.read();
        if (chunk.done) return { text, ended: true };
        text += decoder.decode(chunk.value);
      }
      return { text, ended: false };
    };
    const fire = (event: BoardEvent) => {
      for (const listener of listeners) listener(event);
    };
    return { read, fire, cancel: () => reader.cancel() };
  };

  test('the stream sends a member only the events of their own projects', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    // A real project in the same workspace where the member has no role, so the filter is what drops it.
    const other = await pool.query<{ id: string }>(
      `insert into projects (workspace_id, name, github_repo, config)
       select workspace_id, 'other-app', 'ViciApp/other-app', config from projects where id = $1
       returning id`,
      [seeded.projectId]
    );
    const stream = await openStream(cookie);
    await stream.read((text) => text.includes(': connected'));
    stream.fire({ kind: 'task', projectId: other.rows[0]!.id, number: 7 });
    stream.fire({ kind: 'task', projectId: seeded.projectId, number: 1 });
    const { text } = await stream.read((text) => text.includes('"number":1'));
    await stream.cancel();

    expect(text).toContain(`"projectId":"${seeded.projectId}"`);
    expect(text).not.toContain('"number":7');
  });

  test('an open stream stops sending a project the member left and ends when they sign out', async () => {
    const cookie = await signIn(await loginLink(pool, { publicUrl: PUBLIC_URL }));
    const stream = await openStream(cookie, 20);
    const pings = (text: string) => text.split(': ping').length - 1;
    const { text: opened } = await stream.read((text) => text.includes(': connected'));
    await pool.query('delete from project_roles where member_id = $1 and project_id = $2', [
      seeded.ownerId,
      seeded.projectId
    ]);
    // A beat that began before the delete may still ping; two more have read the projects after it.
    const seen = pings(opened);
    await stream.read((text) => pings(text) >= seen + 2);
    stream.fire({ kind: 'task', projectId: seeded.projectId, number: 1 });

    await call(cookie, '/auth/sign-out', {});
    const { text, ended } = await stream.read(() => false);
    expect(ended).toBe(true);
    expect(text).not.toContain('"number":1');
  });

  /** Far longer than a notification takes, so only a lost one ever reaches it. */
  const EVENT_DEADLINE_MS = 10_000;

  /**
   * The first event the hub sends, or a failure once the deadline passes. `unsubscribe` also
   * stops the deadline, so a test that fails before awaiting `event` leaves no rejection behind.
   */
  const nextEvent = (hub: { subscribe(listener: (event: BoardEvent) => void): () => void }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopListening = () => {};
    const event = new Promise<BoardEvent>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('no event arrived')), EVENT_DEADLINE_MS);
      stopListening = hub.subscribe((received) => {
        clearTimeout(timer);
        resolve(received);
      });
    });
    const unsubscribe = () => {
      clearTimeout(timer);
      stopListening();
    };
    return { event, unsubscribe };
  };

  /** Polls `read` until it holds, failing once the deadline passes. */
  const until = async (read: () => Promise<boolean>) => {
    const deadline = Date.now() + EVENT_DEADLINE_MS;
    while (!(await read())) {
      if (Date.now() > deadline) throw new Error('never got there');
      await Bun.sleep(20);
    }
  };

  /** The realtime hub's connection as Postgres sees it. */
  const listener = async () =>
    (
      await pool.query<{ pid: number; query: string }>(
        "select pid, query from pg_stat_activity where application_name = 'officina-realtime'"
      )
    ).rows[0];

  const openRequest = () =>
    createRequest(pool, {
      title: 'Rename settings',
      request: 'Call it Preferences.',
      skipInterview: true
    });

  test('database changes reach open boards as events', async () => {
    const hub = await startRealtime({ connectionString: url!, pool, log: () => {} });
    const next = nextEvent(hub);
    try {
      await openRequest();
      expect(await next.event).toEqual({ kind: 'task', projectId: seeded.projectId, number: 1 });
    } finally {
      next.unsubscribe();
      await hub.close();
    }
  });

  test("a member's new name reaches the boards open on their project", async () => {
    const hub = await startRealtime({ connectionString: url!, pool, log: () => {} });
    const next = nextEvent(hub);
    try {
      const rename = {
        projectId: seeded.projectId,
        memberId: seeded.ownerId,
        viewerId: seeded.ownerId,
        name: 'Antonio Ventilii'
      };
      await renameMember(pool, rename);
      expect(await next.event).toEqual({ kind: 'members', projectId: seeded.projectId });
    } finally {
      next.unsubscribe();
      await hub.close();
    }
  });

  test('a listening connection the database ends is opened again, and changes still arrive', async () => {
    const logged: string[] = [];
    const hub = await startRealtime({
      connectionString: url!,
      pool,
      log: (message) => logged.push(message)
    });
    const next = nextEvent(hub);
    try {
      const first = (await listener())!.pid;
      await pool.query('select pg_terminate_backend($1)', [first]);
      // Listening again once a new connection has run its LISTEN.
      await until(async () => {
        const now = await listener();
        return Boolean(now && now.pid !== first && /listen/i.test(now.query));
      });
      await openRequest();
      expect(await next.event).toEqual({ kind: 'task', projectId: seeded.projectId, number: 1 });
      expect(logged).toContain('realtime connection lost');
    } finally {
      next.unsubscribe();
      await hub.close();
    }
  }, 30_000);

  test('the listening connection is pinged so it never looks idle', async () => {
    const hub = await startRealtime({
      connectionString: url!,
      pool,
      log: () => {},
      keepaliveMs: 20
    });
    try {
      await until(async () => (await listener())?.query === 'select 1');
    } finally {
      await hub.close();
    }
  });
});
