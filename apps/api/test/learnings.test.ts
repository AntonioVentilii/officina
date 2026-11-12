import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { LearningTarget } from '@officina/core';
import { insertLearnings, listLearnings } from '@officina/db';
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
  const fakeGitHub = (options: { failOpening?: number } = {}) => {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const written = new Map<string, string>();
    let failOpening = options.failOpening ?? 0;
    const record = (method: string) => async (args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === 'readFile') {
        const text = written.get(String(args.branch));
        return text === undefined
          ? { text: '# Agents\n\n## Copy\n', sha: 'blob1' }
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
