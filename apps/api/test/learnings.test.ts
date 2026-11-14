import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { LearningTarget } from '@officina/core';
import {
  claimLearningDecision,
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

  test('a replaced line keeps its line break when the stored text was trimmed', () => {
    expect(applyEdit('a\n## Copy\nb\n', { find: '## Copy\n', text: '## Copy\n\nrule' })).toEqual({
      ok: true,
      text: 'a\n## Copy\n\nrule\nb\n'
    });
    expect(applyEdit('a X b\n', { find: 'X', text: 'Y' })).toEqual({ ok: true, text: 'a Y b\n' });
    expect(
      applyEdit('a\r\n## Copy\r\nb\r\n', { find: '## Copy\r\n', text: '## Copy\r\n\r\nrule' })
    ).toEqual({ ok: true, text: 'a\r\n## Copy\r\n\r\nrule\r\nb\r\n' });
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

  /**
   * Remembers what each branch holds and which pull requests are open, so a second decision sees
   * what the first one left. A failed opening has opened it, as when GitHub's answer is lost.
   */
  const fakeGitHub = (options: { failOpening?: number; base?: string } = {}) => {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const written = new Map<string, string>();
    const open = new Set<string>();
    let failOpening = options.failOpening ?? 0;
    const record = (method: string) => async (args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === 'readFile') {
        const text = written.get(String(args.branch));
        return text === undefined
          ? { text: options.base ?? '# Agents\n\n## Copy\n', sha: 'blob1' }
          : { text, sha: 'blob2' };
      }
      if (method === 'updateFile') {
        written.set(String(args.branch), String(args.text));
        return { commitSha: 'learn1', parentSha: 'main1' };
      }
      if (method === 'closePullRequestsFrom') open.delete(String(args.branch));
      if (method === 'openPullRequest') {
        open.add(String(args.branch));
        if (failOpening-- > 0) throw new Error('GitHub 502 on /pulls');
        return { number: 77, url: 'https://github.com/x/pull/77' };
      }
      return undefined;
    };
    const port = {
      readFile: record('readFile'),
      updateFile: record('updateFile'),
      createBranch: record('createBranch'),
      openPullRequest: record('openPullRequest'),
      closePullRequestsFrom: record('closePullRequestsFrom')
    } as unknown as LearningGitHub;
    return { port, calls, open };
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

  /** A port whose pull request opens only once `release` is called, as when GitHub is slow. */
  const slowOpening = (github: ReturnType<typeof fakeGitHub>) => {
    let release = () => {};
    const opening = new Promise<void>((resolve) => (release = resolve));
    const port: LearningGitHub = {
      ...github.port,
      openPullRequest: async (input) => {
        await opening;
        return github.port.openPullRequest(input);
      }
    };
    const updated = async () => {
      while (!github.calls.some((call) => call.method === 'updateFile')) await Bun.sleep(5);
    };
    return { port, release, updated };
  };

  test('a decision made while an accept is opening its pull request is refused, and the accept lands', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub();
    const slow = slowOpening(github);
    const accepting = decide(pool, slow.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    await slow.updated();
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'reject', rewrittenAt: null })
    ).rejects.toThrow('someone is deciding this learning right now');
    slow.release();

    expect(await accepting).toMatchObject({ status: 'accepted', prNumber: 77 });
    expect(github.calls.some((call) => call.method === 'closePullRequestsFrom')).toBe(false);
  });

  test('an accept holds no database connection while it waits on GitHub', async () => {
    const learning = await propose('docs');
    const single = new Pool({ connectionString: url, max: 1 });
    const slow = slowOpening(fakeGitHub());
    try {
      const accepting = decide(single, slow.port, owner(), {
        id: learning.id,
        decision: 'accept',
        rewrittenAt: null
      });
      await slow.updated();
      const free = await Promise.race([
        single.query('select 1').then(() => true),
        Bun.sleep(1000).then(() => false)
      ]);
      slow.release();
      await accepting;
      expect(free).toBe(true);
    } finally {
      slow.release();
      await single.end();
    }
  });

  test('an accept is recorded at the time it is written, after its GitHub calls', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub();
    let opened: Date | undefined;
    const port: LearningGitHub = {
      ...github.port,
      openPullRequest: async (input) => {
        await Bun.sleep(20);
        opened = (await pool.query<{ at: Date }>('select clock_timestamp() as at')).rows[0]!.at;
        return github.port.openPullRequest(input);
      }
    };
    const decided = await decide(pool, port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    expect(decided.decidedAt!.getTime()).toBeGreaterThanOrEqual(opened!.getTime());
  });

  test('a claim a stopped process left is taken over once its lease ran out, writing the edit once', async () => {
    const learning = await propose('docs');
    expect(await claimLearningDecision(pool, seeded.projectId, learning.id)).toBeString();
    const github = fakeGitHub();
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('someone is deciding this learning right now');
    expect(github.calls).toEqual([]);

    await pool.query(
      "update learnings set decision_claimed_at = now() - interval '11 minutes' where id = $1",
      [learning.id]
    );
    expect(
      await decide(pool, github.port, owner(), {
        id: learning.id,
        decision: 'accept',
        rewrittenAt: null
      })
    ).toMatchObject({ status: 'accepted', prNumber: 77 });
    expect(github.calls.filter((call) => call.method === 'updateFile')).toHaveLength(1);
  });

  test('accepting a learning records the commit Officina wrote on its branch, and only that', async () => {
    const written = await propose('docs');
    await decide(pool, fakeGitHub().port, owner(), {
      id: written.id,
      decision: 'accept',
      rewrittenAt: null
    });
    const held = await propose('project');
    const github = fakeGitHub();
    // The branch already holds the edit, so nothing is written and nothing is recorded.
    await github.port.updateFile({
      installationId: 1,
      repo: 'x/y',
      path: 'docs/copy.md',
      branch: `officina/learning-${held.id.slice(0, 8)}`,
      text: '# Agents\n\n## Copy\n\nUpdate every live locale.\n',
      message: 'x'
    });
    await decide(pool, github.port, owner(), {
      id: held.id,
      decision: 'accept',
      rewrittenAt: null
    });

    const commits = await pool.query<{ id: string; branch_sha: string; branch_parent_sha: string }>(
      'select id, branch_sha, branch_parent_sha from learnings where id = any($1::uuid[])',
      [[written.id, held.id]]
    );
    expect(commits.rows.find((row) => row.id === written.id)).toMatchObject({
      branch_sha: 'learn1',
      branch_parent_sha: 'main1'
    });
    expect(commits.rows.find((row) => row.id === held.id)).toMatchObject({
      branch_sha: null,
      branch_parent_sha: null
    });
  });

  test('accepting an agent docs learning opens a pull request with exactly the proposed edit', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub();
    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
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
      decide(pool, github.port, owner(), { id: learning.id, decision: 'reject', rewrittenAt: null })
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
    await decide(pool, fakeGitHub().port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
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
    await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    expect(github.calls[3]!.args).toMatchObject({
      path: 'docs/copy.md',
      message: 'docs(learning): update every live locale'
    });
  });

  test('an accept that failed halfway can be accepted again, writing the edit once', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub({ failOpening: 1 });
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('GitHub 502');
    expect((await listLearnings(pool, seeded.projectId))[0]!.status).toBe('proposed');

    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    expect(decided).toMatchObject({ status: 'accepted', prNumber: 77 });
    expect(github.calls.filter((call) => call.method === 'updateFile')).toHaveLength(1);
  });

  test('rejecting a learning closes the pull request an accept that failed halfway left open', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub({ failOpening: 1 });
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('GitHub 502');
    const branch = `officina/learning-${learning.id.slice(0, 8)}`;
    expect([...github.open]).toEqual([branch]);

    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'reject',
      rewrittenAt: null
    });
    expect(decided).toMatchObject({ status: 'rejected', prNumber: null });
    expect(github.open.size).toBe(0);
    expect(github.calls.at(-1)).toEqual({
      method: 'closePullRequestsFrom',
      args: { installationId: 99, repo: 'ViciApp/vici-app', branch }
    });
  });

  test('an edit the default branch moved past goes back to the learner instead of failing', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub({ base: '# Agents\n\n## Copy and tone\n' });
    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    expect(decided).toMatchObject({ status: 'proposed', rewrite: 'requested', prNumber: null });
    expect(github.calls.map((call) => call.method)).toEqual(['readFile']);

    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('the learner is rewriting this edit');

    await failLearningRewrite(pool, learning.id);
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('could not rewrite it; reject it instead');
    expect(
      await decide(pool, github.port, owner(), {
        id: learning.id,
        decision: 'reject',
        rewrittenAt: null
      })
    ).toMatchObject({ status: 'rejected' });
  });

  test('an edit is accepted only as the person read it, never once it was rewritten since', async () => {
    const learning = await propose('docs');
    await requestLearningRewrite(pool, learning.id);
    await rewriteLearningEdit(pool, learning.id, {
      file: 'AGENTS.md',
      find: '## Copy\n',
      text: '## Copy\n\nEvery live locale.\n'
    });
    const github = fakeGitHub();
    // A tab opened before the rewrite still shows the first edit.
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('the edit was rewritten since you read it');
    expect(github.calls).toEqual([]);
    expect((await listLearnings(pool, seeded.projectId))[0]!.status).toBe('proposed');

    const rewritten = (await listLearnings(pool, seeded.projectId))[0]!;
    const seen = rewritten.rewrittenAt!.toISOString();
    await expect(
      decide(pool, github.port, owner(), {
        id: learning.id,
        decision: 'accept',
        rewrittenAt: new Date(Date.parse(seen) - 1).toISOString()
      })
    ).rejects.toThrow('the edit was rewritten since you read it');
    expect(
      await decide(pool, github.port, owner(), {
        id: learning.id,
        decision: 'accept',
        rewrittenAt: seen
      })
    ).toMatchObject({ status: 'accepted' });
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
    const [rewritten] = await listLearnings(pool, seeded.projectId);
    await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: rewritten!.rewrittenAt!.toISOString()
    });
    const created = github.calls.find((call) => call.method === 'createBranch')!;
    expect(String(created.args.branch)).toMatch(
      new RegExp(`^officina/learning-${learning.id.slice(0, 8)}-[0-9a-z]+$`)
    );
  });

  test('rejecting a rewritten learning closes what an accept left on its first branch too', async () => {
    const learning = await propose('docs');
    await requestLearningRewrite(pool, learning.id);
    await rewriteLearningEdit(pool, learning.id, {
      file: 'AGENTS.md',
      find: '## Copy\n',
      text: '## Copy\n\nEvery live locale.\n'
    });
    const github = fakeGitHub();
    await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'reject',
      rewrittenAt: null
    });
    const closed = github.calls
      .filter((call) => call.method === 'closePullRequestsFrom')
      .map((call) => String(call.args.branch));
    const first = `officina/learning-${learning.id.slice(0, 8)}`;
    expect(closed).toHaveLength(2);
    expect(closed).toContain(first);
    expect(closed.find((branch) => branch !== first)).toMatch(new RegExp(`^${first}-[0-9a-z]+$`));
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
        { id: learning.id, decision: 'accept', rewrittenAt: null }
      )
    ).rejects.toBeInstanceOf(TaskCommandError);

    const decided = await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null,
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
