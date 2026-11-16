import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendTaskEvent } from '@officina/db';
import { Pool } from 'pg';
import { createTaskInMerging, resetAndSeed, type Seeded } from '../../db/test/seed';
import { GitHubError } from '@officina/github';
import { approveOnGitHub, askCopilotToReview, type OnBehalf } from '../src';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('approving on GitHub for the verifier', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const fake = (
    options: {
      linked?: boolean;
      fail?: boolean;
      head?: string;
      noSeat?: boolean;
      reviews?: { userId: number; login: string; state: string; commitId: string | null }[];
    } = {}
  ) => {
    const calls: { method: string; args: unknown[] }[] = [];
    // The reviews on GitHub: an approval the fake accepted is there on the next read.
    const reviews: { userId: number; login: string; state: string; commitId: string | null }[] = [
      ...(options.reviews ?? [])
    ];
    const onBehalf: OnBehalf = {
      publicUrl: 'https://o.example',
      tokenFor: async (memberId) =>
        options.linked === false
          ? null
          : { token: `token-${memberId}`, login: 'antonio', userId: 7 },
      asUser: {
        pullRequest: async (...args) => {
          calls.push({ method: 'pullRequest', args });
          return {
            node_id: 'PR_1',
            state: 'open',
            merged: false,
            head: { sha: options.head ?? 'abc' }
          };
        },
        reviews: async (...args) => {
          calls.push({ method: 'reviews', args });
          return reviews;
        },
        approve: async (...args) => {
          calls.push({ method: 'approve', args });
          if (options.fail) throw new Error('Review cannot be requested from the author');
          reviews.push({ userId: 7, login: 'Antonio', state: 'APPROVED', commitId: args[3] });
          return {};
        },
        mergeWhenReady: async (...args) => {
          calls.push({ method: 'mergeWhenReady', args });
          return 'auto_merge' as const;
        },
        requestCopilotReview: async (...args) => {
          calls.push({ method: 'requestCopilotReview', args });
          if (options.noSeat) {
            throw new GitHubError(
              422,
              '/repos/ViciApp/vici-app/pulls/42/copilot-code-review',
              '{"failure_reason":"ACTOR_NOT_ELIGIBLE"}'
            );
          }
          return 'requested' as const;
        }
      }
    };
    return { onBehalf, calls };
  };

  const events = async (taskId: string) =>
    (
      await pool.query<{ type: string; payload: Record<string, unknown>; member: string | null }>(
        `select type, payload, actor->>'memberId' as member from task_events
         where task_id = $1 and type like 'github_%'`,
        [taskId]
      )
    ).rows;

  const input = (taskId: string) => ({
    taskId,
    projectId: seeded.projectId,
    taskNumber: 1,
    repo: 'ViciApp/vici-app',
    pullRequest: 42
  });

  test('approves the verified head as the verifier, once, and never merges', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const { onBehalf, calls } = fake();
    await approveOnGitHub(pool, onBehalf, input(taskId));
    await approveOnGitHub(pool, onBehalf, input(taskId));

    expect(calls.map((call) => call.method)).toEqual(['pullRequest', 'reviews', 'approve']);
    expect(calls[2]!.args).toEqual([
      `token-${seeded.ownerId}`,
      'ViciApp/vici-app',
      42,
      'abc',
      `Verified in [Officina task 1](https://o.example/tasks/1?project=${seeded.projectId}).`
    ]);
    expect(await events(taskId)).toEqual([
      {
        type: 'github_approved',
        payload: { login: 'antonio', headSha: 'abc' },
        member: seeded.ownerId
      }
    ]);
  });

  test("Officina's own spec status commit on top of the verified head is approved", async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await appendTaskEvent(pool, {
      taskId,
      actor: { kind: 'engine' },
      type: 'spec_status_set',
      payload: { status: 'Implemented (#42)', path: 'docs/specs/x.md', commitSha: 'status1' }
    });
    const { onBehalf, calls } = fake({ head: 'status1' });
    await approveOnGitHub(pool, onBehalf, input(taskId));
    expect(calls.map((call) => call.method)).toEqual(['pullRequest', 'reviews', 'approve']);
    expect(calls[2]!.args[3]).toBe('status1');
  });

  test('an approval whose record was lost is recorded on the next pass, never sent twice', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    // The record fails right after GitHub took the approval, as when the database drops.
    await pool.query(`
      create function refuse_approved() returns trigger language plpgsql as $$
        begin raise exception 'connection lost'; end $$;
      create trigger refuse_approved before insert on task_events
        for each row when (new.type = 'github_approved') execute function refuse_approved();
    `);
    const { onBehalf, calls } = fake();
    await expect(approveOnGitHub(pool, onBehalf, input(taskId))).rejects.toThrow('connection lost');
    expect(await events(taskId)).toEqual([]);

    await pool.query('drop trigger refuse_approved on task_events');
    await approveOnGitHub(pool, onBehalf, input(taskId));
    await approveOnGitHub(pool, onBehalf, input(taskId));
    expect(calls.map((call) => call.method)).toEqual([
      'pullRequest',
      'reviews',
      'approve',
      'pullRequest',
      'reviews'
    ]);
    expect(await events(taskId)).toEqual([
      {
        type: 'github_approved',
        payload: { login: 'antonio', headSha: 'abc' },
        member: seeded.ownerId
      }
    ]);
  });

  test('an approval under a login renamed since is recognised by the GitHub user id', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const { onBehalf, calls } = fake({
      reviews: [{ userId: 7, login: 'antonio-old', state: 'APPROVED', commitId: 'abc' }]
    });
    await approveOnGitHub(pool, onBehalf, input(taskId));
    expect(calls.map((call) => call.method)).toEqual(['pullRequest', 'reviews']);
    expect((await events(taskId)).map((event) => event.type)).toEqual(['github_approved']);
  });

  test('an approval the member later replaced with a request for changes is approved again', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const { onBehalf, calls } = fake({
      reviews: [
        { userId: 7, login: 'antonio', state: 'APPROVED', commitId: 'abc' },
        { userId: 7, login: 'antonio', state: 'CHANGES_REQUESTED', commitId: 'abc' },
        { userId: 7, login: 'antonio', state: 'COMMENTED', commitId: 'abc' },
        { userId: 8, login: 'someone', state: 'APPROVED', commitId: 'abc' }
      ]
    });
    await approveOnGitHub(pool, onBehalf, input(taskId));
    expect(calls.map((call) => call.method)).toEqual(['pullRequest', 'reviews', 'approve']);
  });

  test('a head pushed after the verification is recorded and never approved', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const { onBehalf, calls } = fake({ head: 'later' });
    await approveOnGitHub(pool, onBehalf, input(taskId));
    await approveOnGitHub(pool, onBehalf, input(taskId));

    expect(calls.map((call) => call.method)).toEqual(['pullRequest']);
    expect(await events(taskId)).toEqual([
      expect.objectContaining({
        type: 'github_approval_failed',
        payload: expect.objectContaining({ expectedHead: 'abc', actualHead: 'later' })
      })
    ]);
  });

  test('does nothing for a verifier without a linked account, and records a failure once', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const unlinked = fake({ linked: false });
    await approveOnGitHub(pool, unlinked.onBehalf, input(taskId));
    expect(unlinked.calls).toEqual([]);
    expect(await events(taskId)).toEqual([]);

    const failing = fake({ fail: true });
    await approveOnGitHub(pool, failing.onBehalf, input(taskId));
    await approveOnGitHub(pool, failing.onBehalf, input(taskId));
    expect(failing.calls.filter((call) => call.method === 'approve')).toHaveLength(1);
    expect(await events(taskId)).toEqual([
      expect.objectContaining({
        type: 'github_approval_failed',
        payload: { login: 'antonio', error: 'Review cannot be requested from the author' }
      })
    ]);
  });

  describe('asking Copilot to review as the requester', () => {
    const ask = (taskId: string) => ({
      taskId,
      requesterId: seeded.ownerId,
      repo: 'ViciApp/vici-app',
      pullRequest: 42
    });

    test('asks once per pull request with the requester own token', async () => {
      const taskId = await createTaskInMerging(pool, seeded);
      const { onBehalf, calls } = fake();
      await askCopilotToReview(pool, onBehalf, ask(taskId));
      await askCopilotToReview(pool, onBehalf, ask(taskId));

      expect(calls).toEqual([
        { method: 'reviews', args: [`token-${seeded.ownerId}`, 'ViciApp/vici-app', 42] },
        {
          method: 'requestCopilotReview',
          args: [`token-${seeded.ownerId}`, 'ViciApp/vici-app', 42]
        }
      ]);
      expect(await events(taskId)).toEqual([
        {
          type: 'github_copilot_review_requested',
          payload: { pullRequest: 42, login: 'antonio', outcome: 'requested' },
          member: seeded.ownerId
        }
      ]);
    });

    test('a review Copilot already left, from an attempt whose record was lost, is recorded instead of asked again', async () => {
      const taskId = await createTaskInMerging(pool, seeded);
      const { onBehalf, calls } = fake({
        reviews: [
          {
            userId: 9,
            login: 'copilot-pull-request-reviewer[bot]',
            state: 'COMMENTED',
            commitId: 'abc'
          }
        ]
      });
      await askCopilotToReview(pool, onBehalf, ask(taskId));
      await askCopilotToReview(pool, onBehalf, ask(taskId));

      expect(calls.map((call) => call.method)).toEqual(['reviews']);
      expect(await events(taskId)).toEqual([
        {
          type: 'github_copilot_review_requested',
          payload: { pullRequest: 42, login: 'antonio', outcome: 'already_reviewed' },
          member: seeded.ownerId
        }
      ]);
    });

    test('a refusal from GitHub is recorded once and never thrown', async () => {
      const taskId = await createTaskInMerging(pool, seeded);
      const { onBehalf, calls } = fake({ noSeat: true });
      await askCopilotToReview(pool, onBehalf, ask(taskId));
      await askCopilotToReview(pool, onBehalf, ask(taskId));

      expect(calls.filter((call) => call.method === 'requestCopilotReview')).toHaveLength(1);
      expect(await events(taskId)).toEqual([
        {
          type: 'github_copilot_review_failed',
          payload: {
            pullRequest: 42,
            login: 'antonio',
            error: expect.stringContaining('ACTOR_NOT_ELIGIBLE')
          },
          member: seeded.ownerId
        }
      ]);
    });

    test('a requester without a usable GitHub account is recorded, and nothing is sent', async () => {
      const unlinkedTask = await createTaskInMerging(pool, seeded);
      const unlinked = fake({ linked: false });
      await askCopilotToReview(pool, unlinked.onBehalf, ask(unlinkedTask));
      expect(unlinked.calls).toEqual([]);
      expect(await events(unlinkedTask)).toEqual([
        {
          type: 'github_copilot_review_failed',
          payload: {
            pullRequest: 42,
            login: null,
            error: 'the requester has not connected GitHub, or their GitHub authorization expired'
          },
          member: null
        }
      ]);

      const unconfiguredTask = await createTaskInMerging(pool, seeded);
      await askCopilotToReview(pool, undefined, ask(unconfiguredTask));
      expect(await events(unconfiguredTask)).toEqual([
        expect.objectContaining({
          type: 'github_copilot_review_failed',
          payload: expect.objectContaining({
            error: 'connecting GitHub accounts is not set up on this server'
          })
        })
      ]);
    });
  });
});
