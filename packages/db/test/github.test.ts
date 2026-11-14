import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  appendTaskEvent,
  handedToGitHub,
  linkPullRequest,
  loadBoardTask,
  recordBotComment,
  unhandledBotComments
} from '../src';
import { createTaskInMerging, resetAndSeed, type Seeded } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('auto-merge trail', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const trail = async (types: readonly string[]) => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    for (const type of types)
      await appendTaskEvent(pool, { taskId, actor: { kind: 'engine' }, type, payload: {} });
    const { rows } = await pool.query<{ number: number }>(
      'select number from tasks where id = $1',
      [taskId]
    );
    const board = await loadBoardTask(pool, seeded.projectId, rows[0]!.number);
    return { engine: await handedToGitHub(pool, taskId), board: board?.autoMergeOn };
  };

  test('the board and the engine agree on whether GitHub may merge on its own', async () => {
    const cases: [readonly string[], boolean][] = [
      [[], false],
      [['github_auto_merge'], true],
      [['github_auto_merge_failed'], true],
      [['github_auto_merge_failed', 'github_auto_merge_cancelled'], false],
      [['github_auto_merge', 'merge_held', 'github_auto_merge_cancelled'], false]
    ];
    for (const [types, expected] of cases)
      expect({ types, ...(await trail(types)) }).toEqual({
        types,
        engine: expected,
        board: expected
      });
  });
});

describe.skipIf(!url)('bot comments', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  test('an edit delivered after a newer one never replaces the text GitHub has now', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const edit = (body: string, updatedAt: string) =>
      recordBotComment(pool, taskId, { commentId: 31, by: 'claude[bot]', body, updatedAt });
    await edit('Final: one finding.', '2026-11-14T10:05:00Z');
    await edit('Claude is working...', '2026-11-14T10:00:00Z');

    expect(await unhandledBotComments(pool, taskId, 0)).toEqual([
      { commentId: 31, by: 'claude[bot]', body: 'Final: one finding.' }
    ]);
  });
});
