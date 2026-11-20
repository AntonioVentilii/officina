import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { branchForLearning, type LearningTarget } from '@officina/core';
import {
  DECISION_LEASE,
  claimLearningDecision,
  failLearningRewrite,
  insertLearnings,
  listLearnings,
  markAcceptAttempt,
  releaseLearningDecision,
  requestLearningRewrite,
  rewriteLearningEdit
} from '@officina/db';
import { Pool } from 'pg';
import { createTaskInMerging, resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import type { GitHubClient } from '@officina/github';
import { catchUpLearningPullRequests, catchUpLeftAccepts } from '../src/catch-up';
import { applyEdit, type LearningGitHub } from '../src/learning-pull-request';
import { learningsView } from '../src/board';
import { decide } from '../src/learnings';
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
   * what the first one left. A failed opening has opened it, as when GitHub's answer is lost. A
   * test settles a branch's pull request as merged or closed unmerged in `settled`.
   */
  const fakeGitHub = (options: { failOpening?: number; base?: string } = {}) => {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const written = new Map<string, string>();
    const open = new Set<string>();
    const settled = new Map<string, 'merged' | 'closed'>();
    let failOpening = options.failOpening ?? 0;
    const note = (method: string, args: object) => calls.push({ method, args: { ...args } });
    const port: LearningGitHub & Pick<GitHubClient, 'pullRequestFrom'> = {
      readFile: async (args) => {
        note('readFile', args);
        const text = written.get(args.branch);
        return text === undefined
          ? { text: options.base ?? '# Agents\n\n## Copy\n', sha: 'blob1' }
          : { text, sha: 'blob2' };
      },
      updateFile: async (args) => {
        note('updateFile', args);
        written.set(args.branch, args.text);
        return { commitSha: 'learn1', parentSha: 'main1' };
      },
      createBranch: async (args) => {
        note('createBranch', args);
      },
      openPullRequest: async (args) => {
        note('openPullRequest', args);
        open.add(args.branch);
        if (failOpening-- > 0) throw new Error('GitHub 502 on /pulls');
        return { number: 77, url: 'https://github.com/x/pull/77' };
      },
      closePullRequestsFrom: async (args) => {
        note('closePullRequestsFrom', args);
        open.delete(args.branch);
      },
      pullRequestFrom: async (args) => {
        note('pullRequestFrom', args);
        const state = open.has(args.branch) ? 'open' : settled.get(args.branch);
        return state ? { number: 77, url: 'https://github.com/x/pull/77', state } : null;
      }
    };
    return { port, calls, open, settled };
  };

  const propose = async (
    target: LearningTarget,
    edit: { find?: string; text: string } = {
      find: '## Copy\n',
      text: '## Copy\n\nUpdate every live locale.\n'
    }
  ) => {
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
              ? { file: target === 'docs' ? 'AGENTS.md' : 'docs/copy.md', ...edit }
              : { file: 'agents/builder.md', text: 'Check every locale.' }
        }
      ]
    });
    return (await listLearnings(pool, seeded.projectId))[0]!;
  };

  /** Hands a learning back to the learner, as an accept that found its edit stale does. */
  const handBack = async (id: string) => {
    const claim = await claimLearningDecision(pool, seeded.projectId, id, {
      memberId: seeded.ownerId,
      decision: 'accept'
    });
    expect(await requestLearningRewrite(pool, id, claim!)).toBe(true);
  };

  const owner = () => ({
    projectId: seeded.projectId,
    memberId: seeded.ownerId,
    role: 'owner' as const,
    publicUrl: 'https://o.example'
  });

  /**
   * A port whose first call of `method` answers only once `release` is called, as when GitHub is
   * slow; `reached` waits until that call has started.
   */
  const slowAt = (github: ReturnType<typeof fakeGitHub>, method: keyof LearningGitHub) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    const real = github.port[method] as (input: unknown) => Promise<unknown>;
    const port: LearningGitHub = Object.assign({}, github.port, {
      [method]: async (input: unknown) => {
        if (!entered) {
          entered = true;
          await gate;
        }
        return real(input);
      }
    });
    const reached = async () => {
      while (!entered) await Bun.sleep(5);
    };
    return { port, release, reached };
  };

  /** Ages a learning's claim past its lease, as if the process holding it had stopped. */
  const expireClaim = (id: string) =>
    pool.query(
      "update learnings set decision_claimed_at = now() - $2::interval - interval '1 minute' where id = $1",
      [id, DECISION_LEASE]
    );

  test('a decision made while an accept is opening its pull request is refused, and the accept lands', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub();
    const slow = slowAt(github, 'openPullRequest');
    const accepting = decide(pool, slow.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    await slow.reached();
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'reject', rewrittenAt: null })
    ).rejects.toThrow('someone is deciding this learning right now');
    slow.release();

    expect(await accepting).toMatchObject({ status: 'accepted', prNumber: 77 });
    expect(github.calls.some((call) => call.method === 'closePullRequestsFrom')).toBe(false);
  });

  test('every board shows who is deciding a learning while the claim is live, and nothing after', async () => {
    const learning = await propose('docs');
    const workspaceId = (
      await pool.query<{ id: string }>('select workspace_id as id from projects where id = $1', [
        seeded.projectId
      ])
    ).rows[0]!.id;
    const viewer = (memberId: string) => ({
      memberId,
      workspaceId,
      projectId: seeded.projectId,
      role: 'owner' as const,
      domains: []
    });
    const decidingOf = async (memberId: string) =>
      (await learningsView(pool, viewer(memberId))).find((item) => item.id === learning.id)!
        .deciding;
    const github = fakeGitHub();
    const slow = slowAt(github, 'openPullRequest');
    const accepting = decide(pool, slow.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    await slow.reached();

    expect(await decidingOf(seeded.ownerId)).toMatchObject({
      decision: 'accept',
      by: 'Antonio',
      you: true
    });
    expect(await decidingOf(crypto.randomUUID())).toMatchObject({ by: 'Antonio', you: false });
    slow.release();
    await accepting;
    expect(await decidingOf(seeded.ownerId)).toBeNull();

    const stale = await propose('docs');
    await claimLearningDecision(pool, seeded.projectId, stale.id, {
      memberId: seeded.ownerId,
      decision: 'reject'
    });
    await expireClaim(stale.id);
    const views = await learningsView(pool, viewer(seeded.ownerId));
    expect(views.find((item) => item.id === stale.id)!.deciding).toBeNull();
  });

  test('an accept holds no database connection while it waits on GitHub', async () => {
    const learning = await propose('docs');
    const single = new Pool({ connectionString: url, max: 1 });
    const slow = slowAt(fakeGitHub(), 'openPullRequest');
    try {
      const accepting = decide(single, slow.port, owner(), {
        id: learning.id,
        decision: 'accept',
        rewrittenAt: null
      });
      await slow.reached();
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
    expect(
      await claimLearningDecision(pool, seeded.projectId, learning.id, {
        memberId: seeded.ownerId,
        decision: 'accept'
      })
    ).toBeString();
    const github = fakeGitHub();
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('someone is deciding this learning right now');
    expect(github.calls).toEqual([]);

    await expireClaim(learning.id);
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

  test('a learning pull request merged while its webhook was missed is applied on the next pass', async () => {
    const learning = await propose('docs');
    await decide(pool, fakeGitHub().port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    let merged = false;
    const reads: number[] = [];
    const github = {
      pullRequest: async ({ pullRequest }: { pullRequest: number }) => {
        reads.push(pullRequest);
        return {
          node_id: 'PR',
          head: { sha: 'learn1' },
          state: merged ? 'closed' : 'open',
          merged
        };
      }
    };

    expect(await catchUpLearningPullRequests(pool, github, seeded.projectId)).toEqual([]);
    expect((await listLearnings(pool, seeded.projectId))[0]!.status).toBe('accepted');
    merged = true;
    expect(await catchUpLearningPullRequests(pool, github, seeded.projectId)).toEqual([]);
    expect((await listLearnings(pool, seeded.projectId))[0]!.status).toBe('applied');
    // Applied, it is not read again.
    await catchUpLearningPullRequests(pool, github, seeded.projectId);
    expect(reads).toEqual([77, 77]);
  });

  test('a learning pull request closed while its webhook was missed is closed on the next pass', async () => {
    const learning = await propose('docs');
    await decide(pool, fakeGitHub().port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    const reads: number[] = [];
    const github = {
      pullRequest: async ({ pullRequest }: { pullRequest: number }) => {
        reads.push(pullRequest);
        return { node_id: 'PR', head: { sha: 'learn1' }, state: 'closed', merged: false };
      }
    };

    expect(await catchUpLearningPullRequests(pool, github, seeded.projectId)).toEqual([]);
    expect((await listLearnings(pool, seeded.projectId))[0]).toMatchObject({
      status: 'accepted',
      prState: 'closed'
    });
    // Closed, it is not read again, and a second close changes nothing.
    await catchUpLearningPullRequests(pool, github, seeded.projectId);
    expect(reads).toEqual([77]);
    const closedAt = await pool.query('select pr_closed_at from learnings');
    await handleWebhookAction(pool, {
      kind: 'pull_request_closed',
      repo: 'ViciApp/vici-app',
      prNumber: 77
    });
    expect((await pool.query('select pr_closed_at from learnings')).rows).toEqual(closedAt.rows);
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

  test('an accept that lost its claim makes no further write, and the one that took over lands', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub();
    const slow = slowAt(github, 'readFile');
    const stale = decide(pool, slow.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    await slow.reached();
    await expireClaim(learning.id);
    expect(
      await decide(pool, github.port, owner(), {
        id: learning.id,
        decision: 'accept',
        rewrittenAt: null
      })
    ).toMatchObject({ status: 'accepted', prNumber: 77 });
    slow.release();

    await expect(stale).rejects.toThrow('someone else decided this learning meanwhile');
    for (const method of ['createBranch', 'updateFile', 'openPullRequest'])
      expect(github.calls.filter((call) => call.method === method)).toHaveLength(1);
  });

  test('an accept that lost its claim to a reject hands nothing back to the learner', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub({ base: '# Agents\n\n## Copy and tone\n' });
    const slow = slowAt(github, 'readFile');
    const stale = decide(pool, slow.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    await slow.reached();
    await expireClaim(learning.id);
    await decide(pool, github.port, owner(), {
      id: learning.id,
      decision: 'reject',
      rewrittenAt: null
    });
    slow.release();

    await expect(stale).rejects.toThrow('someone else decided this learning meanwhile');
    expect((await listLearnings(pool, seeded.projectId))[0]).toMatchObject({
      status: 'rejected',
      rewrite: null
    });
  });

  test('a reject that lost its claim to an accept leaves that accept and its pull request alone', async () => {
    const learning = await propose('docs');
    await handBack(learning.id);
    await rewriteLearningEdit(pool, learning.id, {
      file: 'AGENTS.md',
      find: '## Copy\n',
      text: '## Copy\n\nEvery live locale.\n'
    });
    const [rewritten] = await listLearnings(pool, seeded.projectId);
    const github = fakeGitHub();
    // The reject closes the current branch first, then waits on GitHub closing the first one.
    let closes = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const port: LearningGitHub = {
      ...github.port,
      closePullRequestsFrom: async (input) => {
        if (++closes === 2) await gate;
        return github.port.closePullRequestsFrom(input);
      }
    };
    const stale = decide(pool, port, owner(), {
      id: learning.id,
      decision: 'reject',
      rewrittenAt: null
    });
    while (closes < 2) await Bun.sleep(5);
    await expireClaim(learning.id);
    expect(
      await decide(pool, github.port, owner(), {
        id: learning.id,
        decision: 'accept',
        rewrittenAt: rewritten!.rewrittenAt!.toISOString()
      })
    ).toMatchObject({ status: 'accepted', prNumber: 77 });
    release();

    await expect(stale).rejects.toThrow('someone else decided this learning meanwhile');
    expect((await listLearnings(pool, seeded.projectId))[0]!.status).toBe('accepted');
    expect([...github.open]).toEqual([branchForLearning(rewritten!)]);
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
    await handBack(learning.id);
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
    await handBack(learning.id);
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
    await handBack(learning.id);
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
  /** The project's learnings as an owner sees them on the board. */
  const ownerView = async () => {
    const workspaceId = (
      await pool.query<{ id: string }>('select workspace_id as id from projects where id = $1', [
        seeded.projectId
      ])
    ).rows[0]!.id;
    return learningsView(pool, {
      memberId: seeded.ownerId,
      workspaceId,
      projectId: seeded.projectId,
      role: 'owner',
      domains: []
    });
  };

  const learningOf = async (id: string) =>
    (await listLearnings(pool, seeded.projectId)).find((learning) => learning.id === id)!;

  const callsOf = (github: ReturnType<typeof fakeGitHub>, method: string) =>
    github.calls.filter((call) => call.method === method);

  const acceptAttemptOf = async (id: string) =>
    (
      await pool.query<{ attempt: string | null }>(
        'select accept_attempt as attempt from learnings where id = $1',
        [id]
      )
    ).rows[0]!.attempt;

  /** Claims an accept of a learning as the owner and marks it, as an accept about to open its pull request does. */
  const markedAccept = async (id: string) => {
    const claim = (await claimLearningDecision(pool, seeded.projectId, id, {
      memberId: seeded.ownerId,
      decision: 'accept'
    }))!;
    expect(await markAcceptAttempt(pool, { id, claim, memberId: seeded.ownerId })).toBe(true);
    return claim;
  };

  /** A docs learning whose accept opened its pull request and failed before it recorded. */
  const leftAccept = async (github: ReturnType<typeof fakeGitHub>) => {
    const learning = await propose('docs');
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('GitHub 502');
    return learning;
  };

  test('an accept that opened its pull request but lost its answer is recorded by the catch-up, once', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub({ failOpening: 1 });
    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('GitHub 502');
    expect((await learningOf(learning.id)).status).toBe('proposed');

    expect(await catchUpLeftAccepts(pool, github.port, seeded.projectId)).toEqual([]);
    expect(await learningOf(learning.id)).toMatchObject({
      status: 'accepted',
      prNumber: 77,
      prState: 'open',
      decidedBy: seeded.ownerId
    });
    expect(callsOf(github, 'pullRequestFrom')).toHaveLength(1);
    expect(callsOf(github, 'pullRequestFrom')[0]!.args).toEqual({
      installationId: 99,
      repo: 'ViciApp/vici-app',
      branch: branchForLearning(learning),
      base: 'main'
    });
    const shown = (await ownerView()).find((item) => item.id === learning.id)!;
    expect(shown).toMatchObject({
      status: 'accepted',
      prUrl: 'https://github.com/x/pull/77',
      canDecide: false
    });

    const recorded = await learningOf(learning.id);
    const calls = github.calls.length;
    expect(await catchUpLeftAccepts(pool, github.port, seeded.projectId)).toEqual([]);
    expect(github.calls).toHaveLength(calls);
    expect(await learningOf(learning.id)).toEqual(recorded);

    await expect(
      decide(pool, github.port, owner(), { id: learning.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('already decided');
    expect(callsOf(github, 'openPullRequest')).toHaveLength(1);
  });

  test('an accept whose claim was taken over before it recorded is recorded by the catch-up', async () => {
    const learning = await propose('docs');
    const github = fakeGitHub();
    const slow = slowAt(github, 'openPullRequest');
    const stale = decide(pool, slow.port, owner(), {
      id: learning.id,
      decision: 'accept',
      rewrittenAt: null
    });
    await slow.reached();
    await expireClaim(learning.id);
    const other = await claimLearningDecision(pool, seeded.projectId, learning.id, {
      memberId: seeded.ownerId,
      decision: 'accept'
    });
    await releaseLearningDecision(pool, learning.id, other!);
    slow.release();
    await expect(stale).rejects.toThrow('someone else decided this learning meanwhile');
    expect((await learningOf(learning.id)).status).toBe('proposed');

    expect(await catchUpLeftAccepts(pool, github.port, seeded.projectId)).toEqual([]);
    expect(await learningOf(learning.id)).toMatchObject({
      status: 'accepted',
      prNumber: 77,
      prState: 'open'
    });
  });

  test('an accept that opened nothing is looked at once and leaves the learning to decide', async () => {
    const learning = await propose('docs');
    await releaseLearningDecision(pool, learning.id, await markedAccept(learning.id));
    const github = fakeGitHub();

    expect(await catchUpLeftAccepts(pool, github.port, seeded.projectId)).toEqual([]);
    expect(callsOf(github, 'pullRequestFrom')).toHaveLength(1);
    expect((await ownerView()).find((item) => item.id === learning.id)).toMatchObject({
      status: 'proposed',
      canDecide: true,
      duplicateOf: null
    });
    await catchUpLeftAccepts(pool, github.port, seeded.projectId);
    expect(github.calls).toHaveLength(1);
  });

  test('a pull request a lost accept left that merged since is recorded applied, once', async () => {
    const github = fakeGitHub({ failOpening: 1 });
    const learning = await leftAccept(github);
    github.open.delete(branchForLearning(learning));
    github.settled.set(branchForLearning(learning), 'merged');

    expect(await catchUpLeftAccepts(pool, github.port, seeded.projectId)).toEqual([]);
    expect(await learningOf(learning.id)).toMatchObject({
      status: 'applied',
      prNumber: 77,
      prState: 'merged',
      decidedBy: seeded.ownerId
    });
    const calls = github.calls.length;
    await catchUpLeftAccepts(pool, github.port, seeded.projectId);
    expect(github.calls).toHaveLength(calls);
  });

  test('a pull request a lost accept left that was closed unmerged leaves the learning to decide', async () => {
    const github = fakeGitHub({ failOpening: 1 });
    const learning = await leftAccept(github);
    github.open.delete(branchForLearning(learning));
    github.settled.set(branchForLearning(learning), 'closed');

    expect(await catchUpLeftAccepts(pool, github.port, seeded.projectId)).toEqual([]);
    expect((await ownerView()).find((item) => item.id === learning.id)).toMatchObject({
      status: 'proposed',
      canDecide: true,
      prUrl: null
    });
    expect(await acceptAttemptOf(learning.id)).toBeNull();
    const calls = github.calls.length;
    await catchUpLeftAccepts(pool, github.port, seeded.projectId);
    expect(github.calls).toHaveLength(calls);
  });

  test('the catch-up leaves a learning someone is deciding, and never reads GitHub for an agent one', async () => {
    const learning = await propose('docs');
    await markedAccept(learning.id);
    const agent = await propose('agent');
    await releaseLearningDecision(pool, agent.id, await markedAccept(agent.id));
    const github = fakeGitHub();

    expect(await catchUpLeftAccepts(pool, github.port, seeded.projectId)).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(await acceptAttemptOf(learning.id)).not.toBeNull();
    expect(await acceptAttemptOf(agent.id)).toBeNull();
    expect((await learningOf(agent.id)).status).toBe('proposed');
  });

  /** Two tasks propose the same edit, and the first is accepted with pull request 77. */
  const proposeTwice = async (github: ReturnType<typeof fakeGitHub>) => {
    const first = await propose('docs');
    const second = await propose('docs');
    await decide(pool, github.port, owner(), {
      id: first.id,
      decision: 'accept',
      rewrittenAt: null
    });
    return { first, second };
  };

  test('a learning repeating one accepted with its pull request can be rejected, never accepted', async () => {
    const github = fakeGitHub();
    const { first, second } = await proposeTwice(github);

    expect((await learningOf(second.id)).duplicateOf).toEqual({
      id: first.id,
      title: 'Update every live locale',
      taskNumber: first.taskNumber,
      prNumber: 77,
      prUrl: 'https://github.com/x/pull/77',
      prState: 'open'
    });
    expect((await ownerView()).find((item) => item.id === second.id)).toMatchObject({
      status: 'proposed',
      canDecide: true,
      duplicateOf: { id: first.id, prNumber: 77 }
    });
    const calls = github.calls.length;
    await expect(
      decide(pool, github.port, owner(), { id: second.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow(
      'this learning repeats "Update every live locale", already accepted with pull request #77; reject it instead'
    );
    expect(github.calls).toHaveLength(calls);
    expect(await acceptAttemptOf(second.id)).toBeNull();
    await catchUpLeftAccepts(pool, github.port, seeded.projectId);
    expect((await learningOf(second.id)).status).toBe('proposed');

    expect(
      await decide(pool, github.port, owner(), {
        id: second.id,
        decision: 'reject',
        rewrittenAt: null
      })
    ).toMatchObject({ status: 'rejected', duplicateOf: null });
  });

  test('a pull request a lost accept left is not recorded once another copy of its edit was accepted', async () => {
    const github = fakeGitHub({ failOpening: 1 });
    const second = await leftAccept(github);
    const first = await propose('docs');
    await decide(pool, github.port, owner(), {
      id: first.id,
      decision: 'accept',
      rewrittenAt: null
    });

    expect(await catchUpLeftAccepts(pool, github.port, seeded.projectId)).toEqual([]);
    expect(await learningOf(second.id)).toMatchObject({
      status: 'proposed',
      prNumber: null,
      duplicateOf: { id: first.id, prNumber: 77 }
    });
    expect(await acceptAttemptOf(second.id)).toBeNull();

    await decide(pool, github.port, owner(), {
      id: second.id,
      decision: 'reject',
      rewrittenAt: null
    });
    expect(github.open.has(branchForLearning(second))).toBe(false);
    expect(github.open.has(branchForLearning(first))).toBe(true);
  });

  test('a repeat of a merged learning stays a duplicate', async () => {
    const github = fakeGitHub();
    const { first, second } = await proposeTwice(github);
    await handleWebhookAction(pool, {
      kind: 'pull_request_merged',
      repo: 'ViciApp/vici-app',
      prNumber: 77
    });
    expect((await learningOf(second.id)).duplicateOf).toMatchObject({
      id: first.id,
      prState: 'merged'
    });
    await expect(
      decide(pool, github.port, owner(), { id: second.id, decision: 'accept', rewrittenAt: null })
    ).rejects.toThrow('this learning repeats');
  });

  test('a repeat of a learning whose pull request was closed unmerged can be accepted again', async () => {
    const github = fakeGitHub();
    const { second } = await proposeTwice(github);
    await handleWebhookAction(pool, {
      kind: 'pull_request_closed',
      repo: 'ViciApp/vici-app',
      prNumber: 77
    });
    expect((await learningOf(second.id)).duplicateOf).toBeNull();
    expect(
      await decide(pool, github.port, owner(), {
        id: second.id,
        decision: 'accept',
        rewrittenAt: null
      })
    ).toMatchObject({ status: 'accepted', prNumber: 77 });
    expect(callsOf(github, 'openPullRequest').at(-1)!.args).toMatchObject({
      branch: branchForLearning(second)
    });
  });

  test('a learning with another edit than an accepted one is no duplicate', async () => {
    const github = fakeGitHub();
    const accepted = await propose('docs');
    await decide(pool, github.port, owner(), {
      id: accepted.id,
      decision: 'accept',
      rewrittenAt: null
    });
    const otherFind = await propose('docs', {
      find: '# Agents\n',
      text: '## Copy\n\nUpdate every live locale.\n'
    });
    const otherText = await propose('docs', { find: '## Copy\n', text: '## Copy\n\nOther.\n' });
    const appended = await propose('docs', { text: '## Copy\n\nUpdate every live locale.\n' });
    for (const learning of [otherFind, otherText, appended])
      expect((await learningOf(learning.id)).duplicateOf).toBeNull();
  });
});
