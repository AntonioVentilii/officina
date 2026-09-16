import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { linkPullRequest, loadTask } from '@officina/db';
import { Pool } from 'pg';
import { createTaskInMerging, resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { createApp } from '../src';

const url = process.env.TEST_DATABASE_URL;
const SECRET = 'test-webhook-secret-with-enough-length';

const deliver = (
  app: ReturnType<typeof createApp>,
  options: { event: string; payload: unknown; delivery: string; secret?: string }
) => {
  const body = JSON.stringify(options.payload);
  const signature = `sha256=${createHmac('sha256', options.secret ?? SECRET)
    .update(body)
    .digest('hex')}`;
  return app.handle(
    new Request('http://officina.test/github/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': options.event,
        'x-github-delivery': options.delivery,
        'x-hub-signature-256': signature
      },
      body
    })
  );
};

const repository = { full_name: 'ViciApp/vici-app' };
const mergedPayload = { action: 'closed', pull_request: { merged: true, number: 42 }, repository };

describe.skipIf(!url)('api', () => {
  const pool = new Pool({ connectionString: url });
  const app = createApp({ pool, webhookSecret: SECRET });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const eventCount = async (taskId: string) =>
    (await pool.query('select 1 from task_events where task_id = $1', [taskId])).rowCount;

  test('health', async () => {
    const response = await app.handle(new Request('http://officina.test/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('a delivery with a bad signature is rejected and changes nothing', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const response = await deliver(app, {
      event: 'pull_request',
      payload: mergedPayload,
      delivery: 'd-forged',
      secret: 'attacker-secret'
    });
    expect(response.status).toBe(401);
    expect((await loadTask(pool, taskId))?.task.stage).toBe('merging');
  });

  test('a merged pull request completes its task, and a redelivery is ignored', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);

    const first = await deliver(app, {
      event: 'pull_request',
      payload: mergedPayload,
      delivery: 'd-1'
    });
    expect(await first.json()).toEqual({ status: 'applied', outcomes: [{ taskId, ok: true }] });
    expect((await loadTask(pool, taskId))?.task.stage).toBe('done');

    const events = await eventCount(taskId);
    const again = await deliver(app, {
      event: 'pull_request',
      payload: mergedPayload,
      delivery: 'd-1'
    });
    expect(await again.json()).toEqual({ status: 'duplicate' });
    expect(await eventCount(taskId)).toBe(events);
  });

  test('failed checks send a merging task back to building', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const response = await deliver(app, {
      event: 'check_suite',
      delivery: 'd-2',
      payload: {
        action: 'completed',
        check_suite: {
          conclusion: 'failure',
          app: { name: 'GitHub Actions' },
          pull_requests: [{ number: 42 }]
        },
        repository
      }
    });
    expect(await response.json()).toEqual({ status: 'applied', outcomes: [{ taskId, ok: true }] });
    const stored = await loadTask(pool, taskId);
    expect(stored?.task).toMatchObject({ stage: 'building', fixRounds: 1 });
  });

  test('unrelated events and unlinked pull requests are acknowledged without effect', async () => {
    const ignored = await deliver(app, { event: 'push', payload: { repository }, delivery: 'd-3' });
    expect(await ignored.json()).toEqual({ status: 'ignored', outcomes: [] });
    const unlinked = await deliver(app, {
      event: 'pull_request',
      payload: mergedPayload,
      delivery: 'd-4'
    });
    expect(await unlinked.json()).toEqual({ status: 'applied', outcomes: [] });
  });

  test('malformed requests are rejected', async () => {
    const missingDelivery = await app.handle(
      new Request('http://officina.test/github/webhook', {
        method: 'POST',
        headers: {
          'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update('{}').digest('hex')}`
        },
        body: '{}'
      })
    );
    expect(missingDelivery.status).toBe(400);
  });
});
