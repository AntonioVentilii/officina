import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  applyCommand,
  claimDelivery,
  linkPullRequest,
  loadTask,
  markDeliveryHandled,
  purgeOldDeliveries,
  releaseDelivery
} from '@officina/db';
import { Pool } from 'pg';
import { createTaskInMerging, resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { catchUpPullRequests, createApp, type PullRequestReader } from '../src';

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

  test('a pull request closed without a merge sends its task back, held for a maintainer', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const response = await deliver(app, {
      event: 'pull_request',
      payload: { action: 'closed', pull_request: { merged: false, number: 42 }, repository },
      delivery: 'd-closed'
    });
    expect(await response.json()).toEqual({ status: 'applied', outcomes: [{ taskId, ok: true }] });
    const task = (await loadTask(pool, taskId))?.task;
    expect(task).toMatchObject({ stage: 'ready', assignee: null, headSha: null });
    expect(task?.blocked?.question).toContain('#42');
    // The next push opens a new pull request; the old number is kept only in the timeline.
    const { rows } = await pool.query<{ github_pr: number | null }>(
      'select github_pr from tasks where id = $1',
      [taskId]
    );
    expect(rows[0]?.github_pr).toBeNull();
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

    // Handled stays handled, however late the redelivery comes.
    await pool.query("update webhook_deliveries set received_at = now() - interval '1 day'");
    const late = await deliver(app, {
      event: 'pull_request',
      payload: mergedPayload,
      delivery: 'd-1'
    });
    expect(await late.json()).toEqual({ status: 'duplicate' });
  });

  test('a delivery whose handler died is processed when it comes again, once the claim is stale', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    await pool.query(
      "insert into webhook_deliveries (id, event) values ('d-lost', 'pull_request')"
    );

    const fresh = await deliver(app, {
      event: 'pull_request',
      payload: mergedPayload,
      delivery: 'd-lost'
    });
    expect(await fresh.json()).toEqual({ status: 'duplicate' });
    expect((await loadTask(pool, taskId))?.task.stage).toBe('merging');

    await pool.query(
      "update webhook_deliveries set received_at = now() - interval '11 minutes' where id = 'd-lost'"
    );
    const redelivered = await deliver(app, {
      event: 'pull_request',
      payload: mergedPayload,
      delivery: 'd-lost'
    });
    expect(await redelivered.json()).toEqual({
      status: 'applied',
      outcomes: [{ taskId, ok: true }]
    });
    expect((await loadTask(pool, taskId))?.task.stage).toBe('done');
  });

  test('deliveries too old to be redelivered are purged, the recent ones kept', async () => {
    await pool.query(
      `insert into webhook_deliveries (id, event, received_at, handled_at) values
         ('d-old', 'push', now() - interval '8 days', now() - interval '8 days'),
         ('d-new', 'push', now() - interval '2 days', now() - interval '2 days')`
    );
    expect(await purgeOldDeliveries(pool)).toBe(1);
    expect(await purgeOldDeliveries(pool)).toBe(0);
    const left = await pool.query<{ id: string }>('select id from webhook_deliveries');
    expect(left.rows.map((row) => row.id)).toEqual(['d-new']);
  });

  test('a handler that outlived its claim can neither mark nor give back the claim that replaced it', async () => {
    const stale = await claimDelivery(pool, 'd-slow', 'pull_request');
    await pool.query(
      "update webhook_deliveries set received_at = now() - interval '11 minutes' where id = 'd-slow'"
    );
    const replacing = await claimDelivery(pool, 'd-slow', 'pull_request');
    expect(stale).not.toBeNull();
    expect(replacing).not.toBeNull();
    expect(replacing).not.toBe(stale);

    await markDeliveryHandled(pool, 'd-slow', stale!);
    await releaseDelivery(pool, 'd-slow', stale!);
    const row = await pool.query<{ handled: boolean }>(
      "select handled_at is not null as handled from webhook_deliveries where id = 'd-slow'"
    );
    expect(row.rows).toEqual([{ handled: false }]);

    await markDeliveryHandled(pool, 'd-slow', replacing!);
    expect(await claimDelivery(pool, 'd-slow', 'pull_request')).toBeNull();
  });

  test('failed checks send a merging task back to building and stop auto-merge', async () => {
    const calls: string[] = [];
    const checking = createApp({
      pool,
      webhookSecret: SECRET,
      github: {
        fileContent: async () => null,
        cancelAutoMerge: async () => {
          calls.push('cancelAutoMerge');
        }
      }
    });
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const suite = (delivery: string, headSha: string) =>
      deliver(checking, {
        event: 'check_suite',
        delivery,
        payload: {
          action: 'completed',
          check_suite: {
            conclusion: 'failure',
            head_sha: headSha,
            app: { name: 'GitHub Actions' },
            pull_requests: []
          },
          repository
        }
      });
    // A suite on a commit no task holds is about something else.
    expect(await (await suite('d-1', 'unrelated')).json()).toEqual({
      status: 'applied',
      outcomes: []
    });
    const response = await suite('d-2', 'abc');
    expect(await response.json()).toEqual({ status: 'applied', outcomes: [{ taskId, ok: true }] });
    const stored = await loadTask(pool, taskId);
    expect(stored?.task).toMatchObject({ stage: 'building', fixRounds: 1 });
    expect(calls).toEqual(['cancelAutoMerge']);
  });

  test("a failed commit status on Officina's own status commit counts for the task's head", async () => {
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    await pool.query(
      `insert into task_events (task_id, actor, type, payload)
       values ($1, '{"kind":"engine"}', 'spec_status_set', '{"status":"Implemented","commitSha":"status1"}')`,
      [taskId]
    );
    const response = await deliver(app, {
      event: 'status',
      delivery: 's-1',
      payload: {
        sha: 'status1',
        state: 'failure',
        context: 'vercel',
        description: 'Build failed',
        repository
      }
    });
    expect(await response.json()).toEqual({ status: 'applied', outcomes: [{ taskId, ok: true }] });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({ stage: 'building' });
    const details = await pool.query<{ details: string }>(
      `select payload->>'details' as details from task_events where task_id = $1 and type = 'ci_failed'`,
      [taskId]
    );
    expect(details.rows[0]?.details).toBe('vercel: failure (Build failed)');
  });

  test('a comment or an overview from a review bot the project lists reaches the builder, once per answer', async () => {
    const commenting = createApp({
      pool,
      webhookSecret: SECRET,
      github: { fileContent: async () => null, reviewComments: async () => [] }
    });
    await pool.query(
      `update projects set github_installation_id = 99,
         config = jsonb_set(config, '{pull_request}', '{"review_bots": ["coderabbitai[bot]"]}')
       where id = $1`,
      [seeded.projectId]
    );
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const comment = async (
      delivery: string,
      login: string,
      body = 'The cache key is never cleared.'
    ) =>
      (
        await deliver(commenting, {
          event: 'issue_comment',
          delivery,
          payload: {
            action: 'created',
            issue: { number: 42, pull_request: {} },
            comment: { id: 31, body, user: { login, type: 'Bot' } },
            repository
          }
        })
      ).json();

    // A bot the project does not list, such as a deploy preview, asks for nothing.
    expect(await comment('c-1', 'vercel[bot]')).toEqual({ status: 'applied', outcomes: [] });
    expect(await comment('c-2', 'coderabbitai[bot]')).toEqual({
      status: 'applied',
      outcomes: [{ taskId, ok: true }]
    });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({ stage: 'building', fixRounds: 1 });
    const recorded = await pool.query<{ notes: string; comment: string }>(
      `select payload->>'notes' as notes, payload->>'githubCommentId' as comment from task_events
       where task_id = $1 and type = 'review_recorded' and payload->>'reviewer' = 'github'`,
      [taskId]
    );
    expect(recorded.rows[0]?.comment).toBe('31');
    expect(recorded.rows[0]?.notes).toContain('The cache key is never cleared.');

    // Its next word on the builder's answer is not sent back again.
    await applyCommand(pool, {
      taskId,
      command: { type: 'unchanged', note: 'The key is cleared on logout.' },
      actor: { kind: 'agent', role: 'builder', version: 1 }
    });
    expect(await comment('c-3', 'coderabbitai[bot]', 'Still looks off.')).toEqual({
      status: 'applied',
      outcomes: [{ taskId, ok: false, error: 'overview_already_answered' }]
    });

    // A review by the same bot with nothing on the code counts too, as an overview.
    const reviewed = await deliver(commenting, {
      event: 'pull_request_review',
      delivery: 'c-4',
      payload: {
        action: 'submitted',
        review: {
          id: 12,
          state: 'commented',
          body: 'Summary: one risk in the cache.',
          commit_id: 'abc',
          author_association: 'NONE',
          user: { login: 'coderabbitai[bot]', type: 'Bot' }
        },
        pull_request: { number: 42 },
        repository
      }
    });
    expect(await reviewed.json()).toEqual({
      status: 'applied',
      outcomes: [{ taskId, ok: false, error: 'overview_already_answered' }]
    });
  });

  test('a Copilot review with comments sends the work back to the builder and stops auto-merge', async () => {
    const calls: string[] = [];
    const reviewing = createApp({
      pool,
      webhookSecret: SECRET,
      github: {
        fileContent: async () => null,
        reviewComments: async () => [{ path: 'src/a.ts', line: 3, body: 'Typo in the key.' }],
        cancelAutoMerge: async () => {
          calls.push('cancelAutoMerge');
        }
      }
    });
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const review = (
      delivery: string,
      commitId: string,
      type = 'Bot',
      state = 'commented',
      association = 'NONE'
    ) =>
      deliver(reviewing, {
        event: 'pull_request_review',
        delivery,
        payload: {
          action: 'submitted',
          review: {
            id: 5,
            state,
            body: '',
            commit_id: commitId,
            author_association: association,
            user: { login: 'copilot-pull-request-reviewer[bot]', type }
          },
          pull_request: { number: 42 },
          repository
        }
      });

    // A collaborator's plain comment asks for nothing.
    expect(await (await review('r-1', 'abc', 'User', 'commented', 'COLLABORATOR')).json()).toEqual({
      status: 'applied',
      outcomes: []
    });
    // A stranger asking for changes on a public repository steers nothing.
    expect(await (await review('r-0', 'abc', 'User', 'changes_requested', 'NONE')).json()).toEqual({
      status: 'ignored',
      outcomes: []
    });
    expect(await (await review('r-2', 'old')).json()).toEqual({
      status: 'applied',
      outcomes: [{ taskId, ok: false, error: 'stale_head' }]
    });
    // Officina's own status commit sits on top of the reviewed head, so a review of it counts.
    await pool.query(
      `insert into task_events (task_id, actor, type, payload)
       values ($1, '{"kind":"engine"}', 'spec_status_set', '{"status":"In progress","commitSha":"status1"}')`,
      [taskId]
    );
    expect(await (await review('r-3', 'status1')).json()).toEqual({
      status: 'applied',
      outcomes: [{ taskId, ok: true }]
    });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({ stage: 'building', fixRounds: 1 });
    expect(calls).toEqual(['cancelAutoMerge']);
    const cancelled = await pool.query(
      `select 1 from task_events where task_id = $1 and type = 'github_auto_merge_cancelled'`,
      [taskId]
    );
    expect(cancelled.rowCount).toBe(1);
    const notes = await pool.query<{ notes: string }>(
      `select payload->>'notes' as notes from task_events
       where task_id = $1 and type = 'review_recorded' and payload->>'reviewer' = 'github'`,
      [taskId]
    );
    expect(notes.rows[0]?.notes).toContain('`src/a.ts:3`: Typo in the key.');
  });

  test('a Copilot review with no comment on the code is read once per answer', async () => {
    const reviewing = createApp({
      pool,
      webhookSecret: SECRET,
      github: { fileContent: async () => null, reviewComments: async () => [] }
    });
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const review = async (
      delivery: string,
      id: number,
      body: string,
      login = 'copilot-pull-request-reviewer[bot]'
    ) =>
      (
        await deliver(reviewing, {
          event: 'pull_request_review',
          delivery,
          payload: {
            action: 'submitted',
            review: {
              id,
              state: 'commented',
              body,
              commit_id: 'abc',
              author_association: 'NONE',
              user: { login, type: 'Bot' }
            },
            pull_request: { number: 42 },
            repository
          }
        })
      ).json();
    const closerLook =
      '### 🔵 Needs a closer look\n\nThe functions build was unavailable, so bundling is unverified.';

    // A review that reviewed nothing has no verdict and asks for nothing.
    expect(await review('o-1', 7, "Copilot wasn't able to review any files.")).toEqual({
      status: 'applied',
      outcomes: []
    });
    // Another bot's verdict-shaped text with nothing inline is not Copilot's verdict.
    expect(await review('o-4', 10, closerLook, 'other-reviewer[bot]')).toEqual({
      status: 'applied',
      outcomes: []
    });
    expect(await review('o-2', 8, closerLook)).toEqual({
      status: 'applied',
      outcomes: [{ taskId, ok: true }]
    });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({ stage: 'building', fixRounds: 1 });
    const recorded = await pool.query<{ notes: string; overview: boolean }>(
      `select payload->>'notes' as notes, (payload->>'overviewOnly')::boolean as overview
       from task_events
       where task_id = $1 and type = 'review_recorded' and payload->>'reviewer' = 'github'`,
      [taskId]
    );
    expect(recorded.rows[0]?.overview).toBe(true);
    expect(recorded.rows[0]?.notes).toContain('bundling is unverified');

    // The builder found nothing to change; Copilot's overview of the same work is not sent back.
    const unchanged = await applyCommand(pool, {
      taskId,
      command: { type: 'unchanged', note: 'The build passes locally.' },
      actor: { kind: 'agent', role: 'builder', version: 1 }
    });
    expect(unchanged.ok).toBe(true);
    expect(await review('o-3', 9, closerLook)).toEqual({
      status: 'applied',
      outcomes: [{ taskId, ok: false, error: 'overview_already_answered' }]
    });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({ stage: 'reviewing' });
  });

  test('concurrent deliveries of one id are applied once', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        deliver(app, { event: 'pull_request', payload: mergedPayload, delivery: 'd-race' })
      )
    );
    const statuses = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { status: string }).status)
    );
    expect(statuses.sort()).toEqual([
      'applied',
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate'
    ]);
    expect(
      (
        await pool.query(
          "select 1 from task_events where task_id = $1 and type = 'stage_changed' and payload->>'to' = 'done'",
          [taskId]
        )
      ).rowCount
    ).toBe(1);
  });

  test('a delivery that fails mid-way is given back for its redelivery, and its error stays on the server', async () => {
    let fail = true;
    const flaky = createApp({
      pool,
      webhookSecret: SECRET,
      github: {
        fileContent: async () => {
          if (fail) throw new Error('GitHub 502 on /repos/x/contents: <html>secret body</html>');
          return 'version: 1\ndocs: { entry: CONTRIBUTING.md }\n';
        }
      }
    });
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const push = () =>
      deliver(flaky, {
        event: 'push',
        delivery: 'd-flaky',
        payload: {
          ref: 'refs/heads/main',
          commits: [{ modified: ['.github/officina.yml'] }],
          repository
        }
      });
    const logged = console.error;
    console.error = () => {};
    try {
      const failed = await push();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: 'internal' });
    } finally {
      console.error = logged;
    }
    fail = false;
    expect(((await (await push()).json()) as { status: string }).status).toBe('applied');
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

  test('a config push to the default branch refreshes a valid config and keeps the last one otherwise', async () => {
    let served = 'version: 1\ndocs: { entry: CONTRIBUTING.md }\n';
    const withGitHub = createApp({
      pool,
      webhookSecret: SECRET,
      github: { fileContent: async () => served }
    });
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const push = (delivery: string, branch = 'main') =>
      deliver(withGitHub, {
        event: 'push',
        delivery,
        payload: {
          ref: `refs/heads/${branch}`,
          commits: [{ modified: ['.github/officina.yml'] }],
          repository
        }
      });
    const entry = async () =>
      (await pool.query(`select config->'docs'->>'entry' as entry from projects`)).rows[0].entry;

    expect(await (await push('d-5')).json()).toEqual({
      status: 'applied',
      outcomes: [{ projectId: seeded.projectId, config: 'updated' }]
    });
    expect(await entry()).toBe('CONTRIBUTING.md');

    served = 'version: 7';
    const invalid = (await (await push('d-6')).json()) as { outcomes: { config: string }[] };
    expect(invalid.outcomes[0]!.config).toBe('invalid');
    expect(await entry()).toBe('CONTRIBUTING.md');

    expect(await (await push('d-7', 'feature')).json()).toEqual({
      status: 'applied',
      outcomes: []
    });
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

  test('a pull request merged or closed while its webhook was missed is caught up on the next pass', async () => {
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
    const states: Record<number, { state: string; merged: boolean } | Error> = {
      41: new Error('GitHub 502 on /pulls/41'),
      42: { state: 'closed', merged: true },
      43: { state: 'closed', merged: false },
      44: { state: 'open', merged: false }
    };
    const reads: number[] = [];
    const github: PullRequestReader = {
      fileContent: async () => null,
      cancelAutoMerge: async () => {},
      pullRequest: async ({ pullRequest }) => {
        reads.push(pullRequest);
        const pr = states[pullRequest]!;
        if (pr instanceof Error) throw pr;
        return { node_id: 'PR', head: { sha: 'abc' }, ...pr };
      }
    };
    const tasks: Record<number, string> = {};
    for (const number of [41, 42, 43, 44]) {
      tasks[number] = await createTaskInMerging(pool, seeded);
      await linkPullRequest(pool, tasks[number], number);
    }
    const ids = Object.values(tasks);

    expect(await catchUpPullRequests(pool, github, ids)).toEqual([
      { taskId: tasks[41]!, error: 'GitHub 502 on /pulls/41' }
    ]);
    const stages = async () =>
      Promise.all(ids.map(async (id) => (await loadTask(pool, id))?.task.stage));
    expect(await stages()).toEqual(['merging', 'done', 'ready', 'merging']);
    // The same handling as the webhook's: the closed one is held for a maintainer and unlinked.
    const closed = (await loadTask(pool, tasks[43]!))?.task;
    expect(closed?.blocked?.question).toContain('#43');

    // A task that left merging is not read again, and a second pass changes nothing.
    const events = await Promise.all(ids.map(eventCount));
    reads.length = 0;
    await catchUpPullRequests(pool, github, ids);
    expect(reads).toEqual([41, 44]);
    expect(await Promise.all(ids.map(eventCount))).toEqual(events);
  });
});
