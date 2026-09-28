import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendRunEvent, findTaskIdByNumber, startRun } from '@officina/db';
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
        waitingOn: { kind: 'people', label: 'Triage by a maintainer', me: true }
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
});
