import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createTask,
  finishRun,
  HAND_IN_LEASE,
  loadBoardTask,
  loadTask,
  setProjectRole,
  startRun,
  upsertMember
} from '@officina/db';
import { GitHubError } from '@officina/github';
import { Pool } from 'pg';
import { PLAN, applyOrThrow, resetAndSeed, type Seeded } from '../../db/test/seed';
import { handInBuild, openMissingPullRequests, type HandInPort } from '../src';
import { gitHubWith } from './fake-github';

const url = process.env.TEST_DATABASE_URL;
const PUBLIC_URL = 'https://officina.example';
const SPEC = 'docs/specs/room.md';
const TEMPLATE_PATH = '.github/pull_request_template.md';
const TEMPLATE = [
  '<!-- Keep the headings below. # Not a heading -->',
  '# Motivation',
  '<!-- Why this change exists. -->',
  '# Changes',
  '```md',
  '# Not a heading either',
  '```',
  '# Tests'
].join('\n\n');

/**
 * GitHub as a developer's push left it: one changed file on the task branch. `openFails` is how
 * many times opening the pull request fails before it works; `failed`, the checks already red on
 * the pushed head; `files`, what the default branch holds. `bodies` are the pull request bodies sent.
 */
const fakeGitHub = (openFails = 0, failed: string[] = [], files: Record<string, string> = {}) => {
  const calls: string[] = [];
  const bodies: string[] = [];
  let failures = openFails;
  const port = gitHubWith({
    pushFacts: async () => {
      calls.push('pushFacts');
      return { headSha: 'dev1', changedPaths: ['src/app.ts'], addedPaths: [], diffLines: 12 };
    },
    readFile: async ({ path }) => (path in files ? { text: files[path]!, sha: 'blob1' } : null),
    openPullRequest: async (input) => {
      calls.push(`openPullRequest ${input.title}`);
      bodies.push(input.body);
      if (failures-- > 0) throw new Error('GitHub 502 on /pulls');
      return { number: 7, url: 'https://github.com/ViciApp/vici-app/pull/7' };
    },
    updateFile: async () => ({ commitSha: null, parentSha: null }),
    commentOnIssue: async () => ({ id: 1 }),
    failedChecks: async () => failed
  });
  return { port, calls, bodies };
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
    expect(result).toMatchObject({ ok: false, error: 'bad_pull_request' });
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
    // A project that names no pull request template keeps Officina's own body.
    expect(github.bodies[0]).toContain(
      'Verified:\n- bun test\n\nNot verified:\n- nothing reported'
    );
  });

  test('one hand-in runs at a time, and every board shows it while it does', async () => {
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    const github = fakeGitHub();
    // GitHub holds the first hand-in's read of the push until the test lets it go.
    let letGo = () => {};
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const reading = Promise.withResolvers<void>();
    const pushFacts = github.port.pushFacts;
    github.port.pushFacts = async (...args) => {
      reading.resolve();
      await held;
      return pushFacts(...args);
    };
    const deps = { pool, github: github.port, publicUrl: PUBLIC_URL };
    const input = {
      taskId,
      memberId: dev.memberId,
      prTitle: 'feat(room): port the design',
      verified: [],
      notVerified: []
    };
    const { rows } = await pool.query<{ number: number }>(
      'select number from tasks where id = $1',
      [taskId]
    );
    const shown = () => loadBoardTask(pool, seeded.projectId, rows[0]!.number);

    const first = handInBuild(deps, input);
    await reading.promise;
    expect(await shown()).toMatchObject({ handingInBy: dev.memberId });
    expect((await shown())?.handingInSince).toBeInstanceOf(Date);
    expect(await handInBuild(deps, input)).toEqual({ ok: false, error: 'handing_in' });

    letGo();
    expect(await first).toMatchObject({ ok: true, stage: 'reviewing' });
    expect(await shown()).toMatchObject({ handingInBy: null, handingInSince: null });
  });

  test('a hand-in whose lease ran out mid-way stops once another took it over', async () => {
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    const github = fakeGitHub();
    // The first hand-in's read of the push hangs past its lease; the second's goes through.
    let letGo = () => {};
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const reading = Promise.withResolvers<void>();
    const pushFacts = github.port.pushFacts;
    let reads = 0;
    github.port.pushFacts = async (...args) => {
      if (reads++ === 0) {
        reading.resolve();
        await held;
      }
      return pushFacts(...args);
    };
    const deps = { pool, github: github.port, publicUrl: PUBLIC_URL };
    const input = {
      taskId,
      memberId: dev.memberId,
      prTitle: 'feat(room): port the design',
      verified: [],
      notVerified: []
    };

    const first = handInBuild(deps, input);
    await reading.promise;
    await pool.query(
      `update tasks set hand_in_claimed_at = clock_timestamp() - $2::interval - interval '1 second'
       where id = $1`,
      [taskId, HAND_IN_LEASE]
    );
    expect(await handInBuild(deps, input)).toMatchObject({ ok: true, stage: 'reviewing' });

    letGo();
    expect(await first).toEqual({ ok: false, error: 'handing_in' });
    expect(github.calls.filter((call) => call.startsWith('openPullRequest'))).toHaveLength(1);
  });

  test('a hand-in left behind by a stopped process is taken over once its lease ran out', async () => {
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    await pool.query(
      `update tasks set hand_in_claim = gen_random_uuid(),
         hand_in_claimed_at = clock_timestamp() - $3::interval - interval '1 second',
         hand_in_claimed_by = $2
       where id = $1`,
      [taskId, dev.memberId, HAND_IN_LEASE]
    );
    const github = fakeGitHub();
    expect(
      await handInBuild(
        { pool, github: github.port, publicUrl: PUBLIC_URL },
        {
          taskId,
          memberId: dev.memberId,
          prTitle: 'feat(room): port the design',
          verified: [],
          notVerified: []
        }
      )
    ).toMatchObject({ ok: true, stage: 'reviewing' });
  });

  test("a project's pull request template shapes the hand-in's body, and a body that leaves it out is refused", async () => {
    await pool.query(
      `update projects set config = jsonb_set(config, '{docs,pr_template}', $1::jsonb) where id = $2`,
      [JSON.stringify(TEMPLATE_PATH), seeded.projectId]
    );
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    const github = fakeGitHub(0, [], { [TEMPLATE_PATH]: TEMPLATE });
    const deps = { pool, github: github.port, publicUrl: PUBLIC_URL };
    const input = {
      taskId,
      memberId: dev.memberId,
      prTitle: 'feat(room): port the design',
      verified: ['bun test'],
      notVerified: []
    };

    expect(await handInBuild(deps, input)).toEqual({
      ok: false,
      error: 'bad_pull_request',
      problems: [`prBody is required: write it in the pull request template at ${TEMPLATE_PATH}`]
    });
    expect(
      await handInBuild(deps, { ...input, prBody: '# Motivation\n\nThe new design.' })
    ).toEqual({
      ok: false,
      error: 'bad_pull_request',
      problems: [
        `prBody misses the heading "Changes" of ${TEMPLATE_PATH}`,
        `prBody misses the heading "Tests" of ${TEMPLATE_PATH}`
      ]
    });
    expect(github.calls).toEqual([]);
    expect((await loadTask(pool, taskId))?.task.stage).toBe('building');

    const prBody =
      '# Motivation\n\nThe new design.\n\n## changes\n\n- Ported it.\n\n# Tests\n\n- bun test';
    expect(await handInBuild(deps, { ...input, prBody })).toMatchObject({
      ok: true,
      pullRequest: 7
    });
    expect(github.bodies).toHaveLength(1);
    expect(github.bodies[0]).toStartWith(
      `${prBody}\n\n---\n\nImplements the approved spec of [Officina task`
    );
    expect(github.bodies[0]).not.toContain('Verified:');
  });

  test('a hand-in whose checks were already red goes back to the build with what failed, its pull request open', async () => {
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    const github = fakeGitHub(0, ['CI: failure']);

    expect(
      await handInBuild(
        { pool, github: github.port, publicUrl: PUBLIC_URL },
        {
          taskId,
          memberId: dev.memberId,
          prTitle: 'feat(room): port the design',
          verified: [],
          notVerified: []
        }
      )
    ).toEqual({ ok: true, stage: 'building', pullRequest: 7 });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'building',
      headSha: 'dev1'
    });
    const failed = await pool.query<{ details: string }>(
      `select payload->>'details' as details from task_events where task_id = $1 and type = 'ci_failed'`,
      [taskId]
    );
    expect(failed.rows.map((row) => row.details)).toEqual(['CI: failure']);
  });

  /** A developer's claimed build, and how they hand it in through a given GitHub. */
  const claimedBuild = async () => {
    const taskId = await waitingForDeveloper();
    const dev = await developer('dev@example.com', 'Dev');
    await applyOrThrow(pool, taskId, { type: 'claim' }, dev);
    const handIn = (port: HandInPort) =>
      handInBuild(
        { pool, github: port, publicUrl: PUBLIC_URL },
        {
          taskId,
          memberId: dev.memberId,
          prTitle: 'feat(room): port the design',
          verified: [],
          notVerified: []
        }
      );
    const events = async (type: string) =>
      Number(
        (
          await pool.query<{ count: string }>(
            'select count(*) from task_events where task_id = $1 and type = $2',
            [taskId, type]
          )
        ).rows[0]!.count
      );
    return { taskId, handIn, events };
  };

  test('a developer who may no longer build the task they claimed cannot hand it in', async () => {
    const build = await claimedBuild();
    const dev = await developer('dev@example.com', 'Dev');
    await setProjectRole(pool, {
      projectId: seeded.projectId,
      memberId: dev.memberId,
      role: 'watcher',
      domains: []
    });
    const github = fakeGitHub();
    expect(await build.handIn(github.port)).toEqual({ ok: false, error: 'not_allowed' });
    expect((await loadTask(pool, build.taskId))?.task.stage).toBe('building');
    expect(github.calls.filter((call) => call.startsWith('openPullRequest'))).toEqual([]);
  });

  test('a developer who may no longer read the task they claimed cannot hand it in', async () => {
    await pool.query(
      `update projects set config = jsonb_set(config, '{guards}', $1::jsonb) where id = $2`,
      [JSON.stringify({ confidential_terms: ['investor'] }), seeded.projectId]
    );
    const build = await claimedBuild();
    await applyOrThrow(
      pool,
      build.taskId,
      { type: 'guard_words', text: 'Show it to the investor first.' },
      seeded.owner
    );
    const github = fakeGitHub();
    expect(await build.handIn(github.port)).toEqual({ ok: false, error: 'not_allowed' });
    expect((await loadTask(pool, build.taskId))?.task.stage).toBe('building');
  });

  test('a hand-in taken in before the developer was demoted opens no pull request after', async () => {
    const build = await claimedBuild();
    const github = fakeGitHub(1);
    await expect(build.handIn(github.port)).rejects.toThrow('GitHub 502');
    expect((await loadTask(pool, build.taskId))?.task.stage).toBe('reviewing');
    const dev = await developer('dev@example.com', 'Dev');
    await setProjectRole(pool, {
      projectId: seeded.projectId,
      memberId: dev.memberId,
      role: 'contributor',
      domains: []
    });

    expect(await build.handIn(github.port)).toEqual({ ok: false, error: 'not_allowed' });
    expect(github.calls.filter((call) => call.startsWith('openPullRequest'))).toHaveLength(1);
  });

  test('a hand-in whose task moves while its checks are read says where the task is now', async () => {
    const build = await claimedBuild();
    // The webhook for the red check lands while the hand-in reads it, and sends the task back first.
    const port = gitHubWith({
      ...fakeGitHub().port,
      failedChecks: async () => {
        await applyOrThrow(
          pool,
          build.taskId,
          { type: 'ci_failed', headSha: 'dev1', details: 'CI: failure' },
          { kind: 'engine' }
        );
        return ['CI: failure'];
      }
    });

    expect(await build.handIn(port)).toEqual({ ok: true, stage: 'building', pullRequest: 7 });
    expect(await build.events('ci_failed')).toBe(1);
  });

  test('a hand-in sent back for red checks and handed in again unchanged is not taken in twice', async () => {
    const build = await claimedBuild();
    const github = fakeGitHub(0, ['CI: failure']);
    expect(await build.handIn(github.port)).toEqual({
      ok: true,
      stage: 'building',
      pullRequest: 7
    });
    const fixRounds = (await loadTask(pool, build.taskId))?.task.fixRounds;

    expect(await build.handIn(github.port)).toEqual({
      ok: true,
      stage: 'building',
      pullRequest: 7
    });
    expect(await build.events('pushed')).toBe(1);
    expect(await build.events('ci_failed')).toBe(1);
    expect((await loadTask(pool, build.taskId))?.task.fixRounds).toBe(fixRounds);
  });

  test('a hand-in retried after its pull request failed to open still goes back for red checks', async () => {
    const build = await claimedBuild();
    const github = fakeGitHub(1, ['CI: failure']);
    await expect(build.handIn(github.port)).rejects.toThrow('GitHub 502');
    expect((await loadTask(pool, build.taskId))?.task.stage).toBe('reviewing');

    expect(await build.handIn(github.port)).toEqual({
      ok: true,
      stage: 'building',
      pullRequest: 7
    });
    expect(await build.events('pushed')).toBe(1);
    expect(await build.events('ci_failed')).toBe(1);
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
    write: (
      land: () => void,
      catchUp: () => Promise<unknown>
    ) => ReturnType<HandInPort['updateFile']>
  ) => {
    await pool.query(
      `update projects set config = jsonb_set(config, '{docs,spec_dir}', '"docs/specs"')
       where id = $1`,
      [seeded.projectId]
    );
    const files = new Map([['dev1', '# Room\n\nStatus: Approved\n']]);
    let head = 'dev1';
    const port = gitHubWith({
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
      commentOnIssue: async () => ({ id: 1 }),
      failedChecks: async () => []
    });
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
