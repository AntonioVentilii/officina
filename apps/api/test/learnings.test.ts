import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { LearningTarget } from '@officina/core';
import {
  failLearningRewrite,
  insertLearnings,
  listLearnings,
  requestLearningRewrite,
  rewriteLearningEdit
} from '@officina/db';
import { Pool } from 'pg';
import { createTaskInMerging, resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { applyEdit, decide, type LearningGitHub } from '../src/learnings';
import { invite } from '../src/people';
import { TaskCommandError } from '../src/tasks';
import { handleWebhookAction } from '../src/webhooks';

const url = process.env.TEST_DATABASE_URL;

describe('learning edits', () => {
  test('append keeps one blank line before the addition', () => {
    expect(applyEdit('# Docs\n', { find: null, text: 'New rule.' })).toEqual({
      ok: true,
      text: '# Docs\n\nNew rule.\n'
    });
    expect(applyEdit(null, { find: null, text: 'First line.' })).toEqual({
      ok: true,
      text: 'First line.\n'
    });
  });

  test('replace applies only when the text is still found exactly once', () => {
    expect(applyEdit('a\n## Copy\nb\n', { find: '## Copy\n', text: '## Copy\nrule\n' })).toEqual({
      ok: true,
      text: 'a\n## Copy\nrule\nb\n'
    });
    expect(applyEdit('x x', { find: 'x', text: 'y' })).toEqual({
      ok: false,
      why: 'the text to replace now appears 2 times'
    });
    expect(applyEdit(null, { find: 'x', text: 'y' })).toEqual({
      ok: false,
      why: 'the file no longer exists'
    });
  });

  test('replacement text with dollar signs lands exactly as written', () => {
    expect(applyEdit('cost: X\n', { find: 'X', text: "$$5, $& and $' stay" })).toEqual({
      ok: true,
      text: "cost: $$5, $& and $' stay\n"
    });
  });
});

describe.skipIf(!url)('learning decisions', () => {
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

  /** Remembers what each branch holds, so a second accept sees what the first one wrote. */
  const fakeGitHub = (options: { failOpening?: number; base?: string } = {}) => {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const written = new Map<string, string>();
    let failOpening = options.failOpening ?? 0;
    const record = (method: string) => async (args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === 'readFile') {
        const text = written.get(String(args.branch));
        return text === undefined
          ? { text: options.base ?? '# Agents\n\n## Copy\n', sha: 'blob1' }
          : { text, sha: 'blob2' };
      }
      if (method === 'updateFile') written.set(String(args.branch), String(args.text));
      if (method === 'openPullRequest') {
        if (failOpening-- > 0) throw new Error('GitHub 502 on /pulls');
        return { number: 77, url: 'https://github.com/x/pull/77' };
      }
      return undefined;
    };
    const port = {
      readFile: record('readFile'),
      updateFile: record('updateFile'),
      createBranch: record('createBranch'),
      openPullRequest: record('openPullRequest')
    } as unknown as LearningGitHub;
    return { port, calls };
  };

  const propose = async (target: LearningTarget) => {
    const taskId = await createTaskInMerging(pool, seeded);
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
          title: 'Update every live locale',
          lesson: 'Copy changes cover every live locale.',
          evidence: 'Italian was missing in round one.',
          target,
          edit:
            target !== 'agent'
              ? {
                  file: target === 'docs' ? 'AGENTS.md' : 'docs/copy.md',
                  find: '## Copy\n',
                  text: '## Copy\n\nUpdate every live locale.\n'
                }
              : { file: 'agents/builder.md', text: 'Check every locale.' }
        }
      ]
    });
    return (await listLearnings(pool, seeded.projectId))[0]!;
  };

  const owner = () => ({
    projectId: seeded.projectId,
    memberId: seeded.ownerId,
    role: 'owner' as const,
    publicUrl: 'https://o.example'
  });

  test('a reject made while an accept is opening its pull request waits and finds it decided', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub();
    let release = () => {};
    const opening = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      ...github.port,
      openPullRequest: async (input: Parameters<LearningGitHub['openPullRequest']>[0]) => {
        await opening;
        return github.port.openPullRequest(input);
      }
    };
    const accepting = decide(pool, slow, owner(), { id: learning.id, decision: 'accept' });
    while (!github.calls.some((call) => call.method === 'updateFile')) await Bun.sleep(5);
    const rejecting = decide(pool, github.port, owner(), { id: learning.id, decision: 'reject' });
    await Bun.sleep(50);
    release();

    expect(await accepting).toMatchObject({ status: 'accepted', prNumber: 77 });
    await expect(rejecting).rejects.toThrow('already decided');
  });

  test('accepting an agent docs learning opens a pull request with exactly the proposed edit', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub();
    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept'
    });

    expect(decided).toMatchObject({ status: 'accepted', prNumber: 77 });
    const branch = `officina/learning-${learning.id.slice(0, 8)}`;
    expect(github.calls.map((call) => call.method)).toEqual([
      'readFile',
      'createBranch',
      'readFile',
      'updateFile',
      'openPullRequest'
    ]);
    expect(github.calls[2]!.args).toMatchObject({ path: 'AGENTS.md', branch });
    expect(github.calls[3]!.args).toMatchObject({
      path: 'AGENTS.md',
      branch,
      sha: 'blob1',
      text: '# Agents\n\n## Copy\n\nUpdate every live locale.\n',
      message: 'docs(ai): update every live locale'
    });
    const body = String(github.calls[4]!.args.body);
    expect(body).toContain(
      `[Officina task 1](https://o.example/tasks/1?project=${seeded.projectId})`
    );
    expect(body).not.toMatch(/(^|\s)#1\b/);

    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'reject' })
    ).rejects.toThrow('already decided');

    await handleWebhookAction(pool, {
      kind: 'pull_request_merged',
      repo: 'ViciApp/vici-app',
      prNumber: 77
    });
    expect((await listLearnings(pool, seeded.projectId))[0]!.status).toBe('applied');
  });

  test('a merged learning pull request is applied whatever the case of the repository name', async () => {
    const learning = await propose('docs');
    await decide(pool, fakeGitHub().port, owner(), { id: learning.id, decision: 'accept' });
    await handleWebhookAction(pool, {
      kind: 'pull_request_merged',
      repo: 'viciapp/VICI-APP',
      prNumber: 77
    });
    expect((await listLearnings(pool, seeded.projectId))[0]!.status).toBe('applied');
  });

  test('a learning for another project doc lands as a learning pull request', async () => {
    const learning = await propose('project');
    const github = fakeGitHub();
    await decide(pool, github.port, owner(), { id: learning.id, decision: 'accept' });
    expect(github.calls[3]!.args).toMatchObject({
      path: 'docs/copy.md',
      message: 'docs(learning): update every live locale'
    });
  });

  test('an accept that failed halfway can be accepted again, writing the edit once', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub({ failOpening: 1 });
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept' })
    ).rejects.toThrow('GitHub 502');
    expect((await listLearnings(pool, seeded.projectId))[0]!.status).toBe('proposed');

    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept'
    });
    expect(decided).toMatchObject({ status: 'accepted', prNumber: 77 });
    expect(github.calls.filter((call) => call.method === 'updateFile')).toHaveLength(1);
  });

  test('an edit the default branch moved past goes back to the learner instead of failing', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub({ base: '# Agents\n\n## Copy and tone\n' });
    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept'
    });
    expect(decided).toMatchObject({ status: 'proposed', rewrite: 'requested', prNumber: null });
    expect(github.calls.map((call) => call.method)).toEqual(['readFile']);

    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept' })
    ).rejects.toThrow('the learner is rewriting this edit');

    await failLearningRewrite(pool, learning.id);
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept' })
    ).rejects.toThrow('could not rewrite it; reject it instead');
    expect(
      await decide(pool, github.port, owner(), { id: learning.id, decision: 'reject' })
    ).toMatchObject({ status: 'rejected' });
  });

  test('a rewritten edit opens its pull request from a branch of its own', async () => {
    const learning = await propose('docs');
    await requestLearningRewrite(pool, learning.id);
    await rewriteLearningEdit(pool, learning.id, {
      file: 'AGENTS.md',
      find: '## Copy\n',
      text: '## Copy\n\nEvery live locale.\n'
    });
    const github = fakeGitHub();
    await decide(pool, github.port, owner(), { id: learning.id, decision: 'accept' });
    const created = github.calls.find((call) => call.method === 'createBranch')!;
    expect(String(created.args.branch)).toMatch(
      new RegExp(`^officina/learning-${learning.id.slice(0, 8)}-[0-9a-z]+$`)
    );
  });

  test('agent learnings are recorded without touching the repository; contributors cannot decide', async () => {
    const learning = await propose('agent');
    const github = fakeGitHub();
    const contributor = await invite(pool, {
      publicUrl: 'x',
      email: 'gio@example.com',
      name: 'Gio',
      role: 'contributor',
      domains: []
    });
    expect(contributor).toContain('/signin#');
    const gio = (
      await pool.query<{ id: string }>("select id from members where email = 'gio@example.com'")
    ).rows[0]!.id;
    await expect(
      decide(
        pool,
        github.port,
        { ...owner(), memberId: gio, role: 'contributor' },
        { id: learning.id, decision: 'accept' }
      )
    ).rejects.toBeInstanceOf(TaskCommandError);

    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept',
      note: 'Good catch'
    });
    expect(decided).toMatchObject({
      status: 'accepted',
      prNumber: null,
      decisionNote: 'Good catch'
    });
    expect(github.calls).toEqual([]);
  });
});
