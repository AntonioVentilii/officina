import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendRunEvent,
  appendTaskEvent,
  applyCommand,
  createOnboardingTask,
  findTaskIdByNumber,
  startRun
} from '@officina/db';
import { parseProjectConfig } from '@officina/core';
import { Pool } from 'pg';
import { resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { createApp } from '../src/app';
import { logEntries } from '../src/board';
import { invite, loginLink } from '../src/people';
import { startRealtime, type BoardEvent } from '../src/realtime';
import { createRequest } from '../src/tasks';

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
