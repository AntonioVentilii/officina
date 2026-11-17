import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { CHECK_EVIDENCE_MAX, CHECKLIST_LIMITS, type Actor } from '@officina/core';
import { linkPullRequest, listChecks, recordCheck, type RecordedCheck } from '@officina/db';
import { Pool } from 'pg';
import {
  PLAN,
  applyOrThrow,
  createTaskInVerifying,
  recordChooserChecklist,
  resetAndSeed,
  type Seeded
} from '../../db/test/seed';
import {
  checklistComment,
  checklistRound,
  foldedEarlier,
  syncChecklistComment,
  verdictOf
} from '../src/checklist';
import { gitHubWith } from './fake-github';

const url = process.env.TEST_DATABASE_URL;
const PUBLIC_URL = 'https://officina.example';
/** GitHub refuses a comment longer than this. */
const GITHUB_COMMENT_LIMIT = 65_536;
const AT = new Date('2026-11-16T10:00:00Z');

const check = (item: number, outcome: RecordedCheck['outcome'], evidence = ''): RecordedCheck => ({
  item,
  outcome,
  evidence,
  memberId: 'm1',
  name: 'Antonio',
  channel: 'claude',
  at: AT
});

describe('checklist comment text', () => {
  test('a box is ticked only when its latest check is ok, and each item says who checked it, how and when', () => {
    const round = checklistRound({
      items: ['Only two files changed', 'The PR body follows the template', 'fly certs show'],
      checks: [
        check(0, 'ok', '`git diff --stat` lists two files'),
        check(1, 'problem', 'the body is the hand-in list'),
        check(1, 'ok', 'rewritten with gh pr edit')
      ],
      headSha: 'abcdef1234',
      verdict: { kind: 'waiting', approvedBy: [] }
    });
    expect(round).toContain('Commit `abcdef1`: 2 ok, 1 not checked.');
    expect(round).toContain(
      '- [x] **1.** Only two files changed\n  - ok: Antonio via Claude, 2026-11-16. `git diff --stat` lists two files'
    );
    expect(round).toContain(
      '- [x] **2.** The PR body follows the template\n  - ok: Antonio via Claude, 2026-11-16. rewritten with gh pr edit'
    );
    expect(round).toContain('- [ ] **3.** fly certs show\n  - not checked');
    expect(round).toContain('Waiting for verification.');
  });

  test('a partly checked item stays unticked and says what is open', () => {
    const round = checklistRound({
      items: ['Live check'],
      checks: [check(0, 'partial', 'curl answers 200; the gate page not looked at')],
      headSha: 'abc',
      verdict: { kind: 'auto' }
    });
    expect(round).toContain('- [ ] **1.** Live check\n  - partly checked: Antonio via Claude');
    expect(round).toContain('**Auto-verified**');
  });

  test('the verdict follows people at the verification of the head', () => {
    const decision = (
      decision: 'approve' | 'changes',
      name: string,
      note: string | null = null
    ) => ({
      memberId: name,
      name,
      decision,
      note,
      at: AT
    });
    expect(
      verdictOf({
        stage: 'building',
        decisions: [decision('changes', 'Gio', 'The Italian copy is missing')],
        autoVerified: false
      })
    ).toEqual({ kind: 'sent_back', by: 'Gio', at: AT, note: 'The Italian copy is missing' });
    expect(
      verdictOf({
        stage: 'verifying',
        decisions: [decision('approve', 'Gio')],
        autoVerified: false
      })
    ).toEqual({ kind: 'waiting', approvedBy: ['Gio'] });
    expect(
      verdictOf({
        stage: 'merging',
        decisions: [decision('approve', 'Gio'), decision('approve', 'Antonio')],
        autoVerified: false
      })
    ).toEqual({ kind: 'verified', by: ['Gio', 'Antonio'], at: AT });
    expect(verdictOf({ stage: 'building', decisions: [], autoVerified: false })).toEqual({
      kind: 'reopened'
    });
  });

  test('a new head folds the round written last into the earlier rounds', () => {
    const stored = { commentId: 1, headSha: 'abc', round: 'round abc', earlier: '', body: '' };
    expect(foldedEarlier(stored, 'abc')).toBe('');
    expect(foldedEarlier(stored, 'def')).toBe('round abc');
    expect(foldedEarlier({ ...stored, earlier: 'round 000' }, 'def')).toBe(
      'round abc\n\n---\n\nround 000'
    );
  });

  test('the largest checklist, every item checked at length, still fits in one comment with its earlier rounds', () => {
    const items = Array.from({ length: CHECKLIST_LIMITS.items }, () =>
      'x'.repeat(CHECKLIST_LIMITS.item)
    );
    const round = checklistRound({
      items,
      checks: items.map((_, index) => ({
        ...check(index, 'ok', 'e'.repeat(CHECK_EVIDENCE_MAX)),
        name: 'n'.repeat(100)
      })),
      headSha: 'abc',
      verdict: { kind: 'verified', by: ['n'.repeat(100)], at: AT }
    });
    const pipes = '|'.repeat(350);
    const body = checklistComment({
      link: `[Officina task 1](${PUBLIC_URL}/tasks/1)`,
      round,
      beforeAfter: Array.from({ length: CHECKLIST_LIMITS.rows }, () => ({
        key: pipes.slice(0, CHECKLIST_LIMITS.row.key),
        locale: pipes.slice(0, CHECKLIST_LIMITS.row.locale),
        before: pipes,
        after: pipes
      })),
      earlier: [round, round, round].join('\n\n---\n\n')
    });
    expect(body.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
    expect(body).toContain('The before and after table is on [Officina task 1]');
    expect(body).toContain('<summary>Earlier rounds</summary>');
  });
});

describe.skipIf(!url)('checklist comment on the pull request', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
    await pool.query('update projects set github_installation_id = 99 where id = $1', [
      seeded.projectId
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  const fakeGitHub = () => {
    const posted: string[] = [];
    const edited: { commentId: number; body: string }[] = [];
    const port = gitHubWith({
      commentOnIssue: async (ref) => {
        posted.push(ref.body);
        return { id: 555 };
      },
      editComment: async (ref) => {
        edited.push({ commentId: ref.commentId, body: ref.body });
      }
    });
    return { port, posted, edited };
  };

  const taskAtVerification = async () => {
    const taskId = await createTaskInVerifying(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    await recordChooserChecklist(pool, taskId, ['Read the title', 'Open the page']);
    return taskId;
  };

  const sync = (github: ReturnType<typeof fakeGitHub>, taskId: string) =>
    syncChecklistComment(pool, github.port, { taskId, publicUrl: PUBLIC_URL });

  const tick = (taskId: string, item: number, outcome: 'ok' | 'problem', headSha = 'abc') =>
    recordCheck(pool, {
      taskId,
      headSha,
      item,
      outcome,
      evidence: 'read in the diff',
      memberId: seeded.ownerId,
      channel: 'board'
    });

  test('the comment is posted once and edited only when a check or a decision changes its text', async () => {
    const github = fakeGitHub();
    const taskId = await taskAtVerification();

    expect(await sync(github, taskId)).toBe('posted');
    expect(await sync(github, taskId)).toBe('unchanged');
    expect(github.posted).toHaveLength(1);
    expect(github.posted[0]).toContain('- [ ] **1.** Read the title\n  - not checked');

    await tick(taskId, 0, 'ok');
    expect(await sync(github, taskId)).toBe('edited');
    expect(await sync(github, taskId)).toBe('unchanged');
    expect(github.edited).toHaveLength(1);
    expect(github.edited[0]!.commentId).toBe(555);
    expect(github.edited[0]!.body).toContain(
      '- [x] **1.** Read the title\n  - ok: Antonio on the board, '
    );

    await applyOrThrow(pool, taskId, { type: 'approve' }, seeded.owner);
    expect(await sync(github, taskId)).toBe('edited');
    expect(github.edited.at(-1)!.body).toContain('**Verified** by Antonio on ');
    expect(github.edited.at(-1)!.body).toContain('- [ ] **2.** Open the page\n  - not checked');
    expect(github.posted).toHaveLength(1);
  });

  test('sent back, the round says by whom; the next head gets a round of its own above the earlier one', async () => {
    const github = fakeGitHub();
    const taskId = await taskAtVerification();
    await tick(taskId, 0, 'problem');
    await sync(github, taskId);
    await applyOrThrow(
      pool,
      taskId,
      { type: 'request_changes', note: 'The title is wrong' },
      seeded.owner
    );
    await sync(github, taskId);
    expect(github.edited.at(-1)!.body).toContain('**Sent back** by Antonio on ');
    expect(github.edited.at(-1)!.body).toContain('The title is wrong');

    const agent = (role: 'builder' | 'reviewer_spec' | 'reviewer_correctness' | 'chooser') =>
      ({ kind: 'agent', role, version: 1 }) satisfies Actor;
    await applyOrThrow(
      pool,
      taskId,
      {
        type: 'push',
        headSha: 'def',
        changedPaths: ['src/lib/constants/messages/en.ts'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 4
      },
      agent('builder')
    );
    for (const reviewer of ['reviewer_spec', 'reviewer_correctness'] as const)
      await applyOrThrow(
        pool,
        taskId,
        { type: 'review', verdict: 'approve', notes: 'ok' },
        agent(reviewer)
      );
    await applyOrThrow(
      pool,
      taskId,
      { type: 'choose', userVisible: true, plan: PLAN },
      agent('chooser')
    );
    await recordChooserChecklist(pool, taskId, ['Read the new title']);

    expect(await sync(github, taskId)).toBe('edited');
    const body = github.edited.at(-1)!.body;
    expect(body.indexOf('Commit `def`')).toBeLessThan(body.indexOf('Earlier rounds'));
    expect(body).toContain('- [ ] **1.** Read the new title\n  - not checked');
    expect(body.slice(body.indexOf('Earlier rounds'))).toContain('Commit `abc`');
    expect(body.slice(body.indexOf('Earlier rounds'))).toContain('**Sent back** by Antonio');
    expect(github.posted).toHaveLength(1);
  });

  test('the same check sent twice is recorded once; a new finding on the item is added', async () => {
    const taskId = await taskAtVerification();
    expect(await tick(taskId, 1, 'problem')).toEqual({ recorded: true });
    expect(await tick(taskId, 1, 'problem')).toEqual({ recorded: false });
    expect(await tick(taskId, 1, 'ok')).toEqual({ recorded: true });
    expect((await listChecks(pool, taskId, 'abc')).map((entry) => entry.outcome)).toEqual([
      'problem',
      'ok'
    ]);
    const events = await pool.query(
      `select payload from task_events where task_id = $1 and type = 'checklist_checked' order by id`,
      [taskId]
    );
    expect(events.rows.map((row) => row.payload)).toEqual([
      { item: 1, outcome: 'problem', channel: 'board', headSha: 'abc' },
      { item: 1, outcome: 'ok', channel: 'board', headSha: 'abc' }
    ]);
  });
});
