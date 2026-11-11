import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendTaskEvent } from '@officina/db';
import { Pool } from 'pg';
import { createTaskInMerging, resetAndSeed, type Seeded } from '../../db/test/seed';
import { approveOnGitHub, type OnBehalf } from '../src';

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

  const fake = (options: { linked?: boolean; fail?: boolean; head?: string } = {}) => {
    const calls: { method: string; args: unknown[] }[] = [];
    const onBehalf: OnBehalf = {
      publicUrl: 'https://o.example',
      tokenFor: async (memberId) =>
        options.linked === false ? null : { token: `token-${memberId}`, login: 'antonio' },
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
        approve: async (...args) => {
          calls.push({ method: 'approve', args });
          if (options.fail) throw new Error('Review cannot be requested from the author');
          return {};
        },
        mergeWhenReady: async (...args) => {
          calls.push({ method: 'mergeWhenReady', args });
          return 'auto_merge' as const;
        }
      }
    };
    return { onBehalf, calls };
  };

  const events = async (taskId: string) =>
    (
      await pool.query<{ type: string; payload: Record<string, unknown>; member: string }>(
        `select type, payload, actor->>'memberId' as member from task_events
         where task_id = $1 and type like 'github_%'`,
        [taskId]
      )
    ).rows;

  const input = (taskId: string) => ({
    taskId,
    taskNumber: 1,
    repo: 'ViciApp/vici-app',
    pullRequest: 42
  });

  test('approves the verified head as the verifier, once, and never merges', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const { onBehalf, calls } = fake();
    await approveOnGitHub(pool, onBehalf, input(taskId));
    await approveOnGitHub(pool, onBehalf, input(taskId));

    expect(calls.map((call) => call.method)).toEqual(['pullRequest', 'approve']);
    expect(calls[1]!.args).toEqual([
      `token-${seeded.ownerId}`,
      'ViciApp/vici-app',
      42,
      'abc',
      'Verified in [Officina task 1](https://o.example/tasks/1).'
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
    expect(calls.map((call) => call.method)).toEqual(['pullRequest', 'approve']);
    expect(calls[1]!.args[3]).toBe('status1');
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
});
