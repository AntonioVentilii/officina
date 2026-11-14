import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createTask,
  finishRun,
  loadTask,
  setProjectRole,
  startRun,
  upsertMember
} from '@officina/db';
import { GitHubError } from '@officina/github';
import { Pool } from 'pg';
import { PLAN, applyOrThrow, resetAndSeed, type Seeded } from '../../db/test/seed';
import { handInBuild, openMissingPullRequests, type HandInPort } from '../src';

const url = process.env.TEST_DATABASE_URL;
const PUBLIC_URL = 'https://officina.example';
const SPEC = 'docs/specs/room.md';

/**
 * GitHub as a developer's push left it: one changed file on the task branch. `openFails` is how
 * many times opening the pull request fails before it works.
 */
const fakeGitHub = (openFails = 0) => {
  const calls: string[] = [];
  let failures = openFails;
  const port = {
    pushFacts: async () => {
      calls.push('pushFacts');
      return { headSha: 'dev1', changedPaths: ['src/app.ts'], addedPaths: [], diffLines: 12 };
    },
    readFile: async () => null,
    openPullRequest: async (input: { title: string }) => {
      calls.push(`openPullRequest ${input.title}`);
      if (failures-- > 0) throw new Error('GitHub 502 on /pulls');
      return { number: 7, url: 'https://github.com/ViciApp/vici-app/pull/7' };
    },
    updateFile: async () => undefined,
    commentOnIssue: async () => undefined
  } as unknown as HandInPort;
  return { port, calls };
};

describe.skipIf(!url)('a developer hands in a build', () => {
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

  const developer = async (email: string, name: string) => {
    const { rows } = await pool.query<{ workspace_id: string }>(
      'select workspace_id from projects where id = $1',
      [seeded.projectId]
    );
    const memberId = await upsertMember(pool, {
      workspaceId: rows[0]!.workspace_id,
      email,
      displayName: name
    });
    await setProjectRole(pool, {
      projectId: seeded.projectId,
      memberId,
      role: 'contributor',
      domains: ['developer']
    });
    return { kind: 'member', memberId } as const;
  };

  /** A task whose plan asked for a developer, approved and waiting for one to claim it. */
  const waitingForDeveloper = async () => {
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Port the room design',
      requesterId: seeded.ownerId
    });
    await applyOrThrow(pool, task.id, { type: 'submit_request' }, seeded.owner);
    await applyOrThrow(pool, task.id, { type: 'accept' }, seeded.owner);
    await applyOrThrow(
      pool,
      task.id,
      { type: 'post_spec', predictedPaths: ['src/app.ts'], userVisible: true },
      { kind: 'agent', role: 'spec', version: 1 }
    );
    await applyOrThrow(
      pool,
      task.id,
      {
        type: 'plan_approval',
        userVisible: true,
        plan: { ...PLAN, build: 'person', buildReason: 'A large port of a static design.' }
      },
      { kind: 'engine' }
    );
    await applyOrThrow(pool, task.id, { type: 'approve' }, seeded.owner);
    return task.id;
  };

  test("a title that breaks the project's pattern is refused before anything is applied", async () => {
    await pool.query(
      `update projects set config = jsonb_set(config, '{pull_request}', $1::jsonb) where id = $2`,
      [JSON.stringify({ title_pattern: '^(feat|fix)\\([a-z-]+\\): .+$' }), seeded.projectId]
    );
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    const github = fakeGitHub();
    const result = await handInBuild(
      { pool, github: github.port, publicUrl: PUBLIC_URL },
      { taskId, memberId: dev.memberId, prTitle: 'Port the design', verified: [], notVerified: [] }
    );
    expect(result).toMatchObject({ ok: false, error: 'bad_title' });
    expect(github.calls).toEqual([]);
    expect((await loadTask(pool, taskId))?.task.stage).toBe('building');
  });

  test('their push goes to review as theirs and the pull request opens, once', async () => {
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    const other = await developer('other@example.com', 'Other');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    const github = fakeGitHub();
    const deps = { pool, github: github.port, publicUrl: PUBLIC_URL };
    const input = {
      taskId,
      prTitle: 'feat(room): port the design',
      verified: ['bun test'],
      notVerified: []
    };

    // Someone else's claim is not theirs to hand in.
    expect(await handInBuild(deps, { ...input, memberId: other.memberId })).toEqual({
      ok: false,
      error: 'not_allowed'
    });

    expect(await handInBuild(deps, { ...input, memberId: dev.memberId })).toEqual({
      ok: true,
      stage: 'reviewing',
      pullRequest: 7
    });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'reviewing',
      headSha: 'dev1',
      assignee: dev
    });
    // Handing in again opens nothing new and reads no new push.
    const before = github.calls.length;
    expect(await handInBuild(deps, { ...input, memberId: dev.memberId })).toEqual({
      ok: true,
      stage: 'reviewing',
      pullRequest: 7
    });
    expect(github.calls.slice(before)).toEqual([]);
    expect(github.calls.filter((call) => call.startsWith('openPullRequest'))).toEqual([
      'openPullRequest feat(room): port the design'
    ]);
  });

  test('a pull request that fails to open is opened later from the hand-in, not an earlier agent round', async () => {
    const taskId = await waitingForDeveloper();
    // An agent built an earlier round of this task and recorded its own title.
    const run = await startRun(pool, {
      taskId,
      stage: 'building',
      role: 'builder',
      agentVersion: 1,
      runner: 'managed-agents'
    });
    if (!run.ok) throw new Error(run.error);
    await finishRun(pool, run.runId, {
      status: 'succeeded',
      costCents: 1,
      result: {
        outcome: 'pushed',
        branch: 'officina/task-1',
        prTitle: 'feat(room): the agent title',
        verified: [],
        notVerified: []
      }
    });
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    const github = fakeGitHub(1);
    const deps = { pool, github: github.port, publicUrl: PUBLIC_URL };
    const handIn = {
      taskId,
      memberId: dev.memberId,
      prTitle: 'feat(room): port the design',
      verified: ['bun test'],
      notVerified: []
    };

    await expect(handInBuild(deps, handIn)).rejects.toThrow('GitHub 502');
    expect((await loadTask(pool, taskId))?.task.stage).toBe('reviewing');

    expect(await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL)).toEqual([]);
    expect(await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL)).toEqual([]);
    expect(github.calls.filter((call) => call.startsWith('openPullRequest'))).toEqual([
      'openPullRequest feat(room): port the design',
      'openPullRequest feat(room): port the design'
    ]);
    const { rows } = await pool.query<{ github_pr: number | null }>(
      'select github_pr from tasks where id = $1',
      [taskId]
    );
    expect(rows[0]?.github_pr).toBe(7);
  });

  /**
   * A task branch whose spec says Approved. `write` stands for GitHub answering the hand-in's
   * status write: `land` puts that status commit on the branch, and `catchUp` runs the scheduler's
   * catch-up opening the same pull request meanwhile.
   */
  const specRace = async (
    write: (land: () => void, catchUp: () => Promise<unknown>) => Promise<unknown>
  ) => {
    await pool.query(
      `update projects set config = jsonb_set(config, '{docs,spec_dir}', '"docs/specs"')
       where id = $1`,
      [seeded.projectId]
    );
    const files = new Map([['dev1', '# Room\n\nStatus: Approved\n']]);
    let head = 'dev1';
    const port = {
      pushFacts: async () => ({
        headSha: head,
        changedPaths: ['src/app.ts', SPEC],
        addedPaths: [],
        diffLines: 12
      }),
      readFile: async (input: { branch: string }) => {
        const text = files.get(input.branch === 'officina/task-1' ? head : input.branch);
        return text === undefined ? null : { text, sha: `blob-${input.branch}` };
      },
      openPullRequest: async () => ({ number: 7, url: 'https://github.com/x/pull/7' }),
      updateFile: (input: { text: string }) =>
        write(
          () => {
            files.set('status1', input.text);
            head = 'status1';
          },
          () => openMissingPullRequests(pool, port, [taskId], PUBLIC_URL)
        ),
      commitChanges: async () => ({ parents: ['dev1'], paths: [SPEC] }),
      commentOnIssue: async () => undefined
    } as unknown as HandInPort;
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    return {
      taskId,
      handIn: () =>
        handInBuild(
          { pool, github: port, publicUrl: PUBLIC_URL },
          {
            taskId,
            memberId: dev.memberId,
            prTitle: 'feat(room): port the design',
            verified: [],
            notVerified: []
          }
        ),
      statuses: async () =>
        (
          await pool.query<{ payload: unknown }>(
            "select payload from task_events where task_id = $1 and type = 'spec_status_set'",
            [taskId]
          )
        ).rows.map((row) => row.payload)
    };
  };

  test('a hand-in whose spec status write lost the race to the catch-up still completes', async () => {
    const race = await specRace(async (land) => {
      // The catch-up opening the same pull request wrote the same status first.
      land();
      throw new GitHubError(409, `/contents/${SPEC}`, 'is at status1');
    });

    expect(await race.handIn()).toEqual({ ok: true, stage: 'reviewing', pullRequest: 7 });
    expect(await race.statuses()).toEqual([
      { status: 'In progress (#7)', path: SPEC, commitSha: 'status1' }
    ]);
  });

  test('the status the winning opening wrote is recorded once though the losing one recorded it first', async () => {
    const race = await specRace(async (land, catchUp) => {
      land();
      // Before the write's answer arrives, the catch-up finds the status commit and records it.
      expect(await catchUp()).toEqual([]);
      return { commitSha: 'status1', parentSha: 'dev1' };
    });

    expect(await race.handIn()).toEqual({ ok: true, stage: 'reviewing', pullRequest: 7 });
    expect(await race.statuses()).toEqual([
      { status: 'In progress (#7)', path: SPEC, commitSha: 'status1' }
    ]);
  });
});
