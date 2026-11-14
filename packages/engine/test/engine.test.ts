import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { branchForTask, type AgentRole } from '@officina/core';
import {
  appendTaskEvent,
  applyCommand,
  createTask,
  expectedHead,
  failOrphanedRuns,
  feedbackSinceLastPush,
  linkPullRequest,
  loadTask,
  saveAgentVersion,
  startRun
} from '@officina/db';
import type { RefSnapshot } from '@officina/github';
import { RUNNER_ROLES, type SessionRequest } from '@officina/runner';
import { Pool } from 'pg';
import { CONFIG_YAML } from '../../core/test/fixtures';
import {
  PLAN,
  applyOrThrow,
  createTaskInMerging,
  resetAndSeed,
  type Seeded
} from '../../db/test/seed';
import { createFakePort, idle, toolUse, type ScriptItem } from '../../runner/test/fake-port';
import {
  adoptOutsidePushes,
  cancelStaleAutoMerges,
  finishVerifiedSpecs,
  openMissingPullRequests,
  requestCopilotReviews,
  runAgentStep,
  type OnBehalf,
  syncSpecStatus,
  tick,
  type AdoptPort,
  type GitHubPort
} from '../src';

const url = process.env.TEST_DATABASE_URL;
const COPY = 'src/lib/constants/messages/en.ts';
const SPEC = 'docs/specs/2026-09-27-impr-settings-title.md';
const PUBLIC_URL = 'https://officina.example';

const RESULTS: Record<string, unknown> = {
  spec: {
    outcome: 'specced',
    spec: '# Spec\nChange the settings title.',
    predictedPaths: [COPY],
    userVisible: true
  },
  builder: {
    outcome: 'pushed',
    branch: 'officina/task-1',
    prTitle: 'fix(settings): rename the settings title',
    verified: ['npm run check'],
    notVerified: []
  },
  reviewer_spec: { outcome: 'approve', summary: 'Matches the spec.' },
  reviewer_correctness: { outcome: 'approve', summary: 'No issues.' },
  chooser: {
    userVisible: true,
    approval: { depth: 'test', rationale: 'Copy people read on the settings page.' },
    checklist: ['Open settings and read the title.'],
    beforeAfter: [{ key: 'settings.title', locale: 'en', before: 'Settings', after: 'Preferences' }]
  }
};

const succeed = (request: SessionRequest): ScriptItem[] => [
  toolUse(RESULTS[request.metadata.role!]),
  idle('requires_action'),
  idle('end_turn')
];

const REFS: RefSnapshot = { defaultHead: 'main1', tags: { 'v1.0.0': 'tag1' } };

/** `refs` are the snapshots returned in turn, the last one repeating; `merges` are the shas of merged pull requests. */
const fakeGitHub = (
  options: {
    refs?: RefSnapshot[];
    merges?: string[];
    branchHead?: string;
    addedPaths?: string[];
    written?: { commitSha: string; parentSha: string };
    /** The pull request's head; by default the branch head after any status commit written. */
    prHead?: string;
    mergeFails?: boolean;
    /** What `failedChecks` reports as already failed on a commit. */
    failed?: string[];
    /** How many times opening the pull request fails before it works. */
    openFails?: number;
    /** How many times writing a file (the spec status) fails before it works. */
    updateFails?: number;
  } = {}
) => {
  const calls: { method: string; args: unknown[] }[] = [];
  let openFails = options.openFails ?? 0;
  let updateFails = options.updateFails ?? 0;
  let branch = options.branchHead ?? 'sha1';
  const refs = [...(options.refs ?? [REFS])];
  const port = {
    refSnapshot: async (...args: unknown[]) => {
      calls.push({ method: 'refSnapshot', args });
      return refs.length > 1 ? refs.shift()! : refs[0]!;
    },
    isPullRequestMerge: async (...args: unknown[]) => {
      calls.push({ method: 'isPullRequestMerge', args });
      return (options.merges ?? []).includes((args[0] as { sha: string }).sha);
    },
    installationToken: async (...args: unknown[]) => {
      calls.push({ method: 'installationToken', args });
      return `token-${(args[1] as { contents: string }).contents}`;
    },
    pushFacts: async (...args: unknown[]) => {
      calls.push({ method: 'pushFacts', args });
      return {
        headSha: options.branchHead ?? 'sha1',
        changedPaths: [COPY, SPEC],
        addedPaths: options.addedPaths ?? [],
        diffLines: 3
      };
    },
    readFile: async (...args: unknown[]) => {
      calls.push({ method: 'readFile', args });
      return { text: '# Settings title\n\nStatus: Draft\n', sha: 'blob1' };
    },
    updateFile: async (...args: unknown[]) => {
      calls.push({ method: 'updateFile', args });
      if (updateFails-- > 0) throw new Error('GitHub 502 on /contents');
      if (options.written) branch = options.written.commitSha;
      return options.written;
    },
    commentOnIssue: async (...args: unknown[]) => {
      calls.push({ method: 'commentOnIssue', args });
    },
    openPullRequest: async (...args: unknown[]) => {
      calls.push({ method: 'openPullRequest', args });
      if (openFails-- > 0) throw new Error('GitHub 502 on /pulls');
      return { number: 42, url: 'https://github.com/ViciApp/vici-app/pull/42' };
    },
    resolveReviewThreads: async (...args: unknown[]) => {
      calls.push({ method: 'resolveReviewThreads', args });
      return 1;
    },
    mergeWhenReady: async (...args: unknown[]) => {
      calls.push({ method: 'mergeWhenReady', args });
      if (options.mergeFails) throw new Error('timeout');
      return 'auto_merge';
    },
    pullRequestHead: async (...args: unknown[]) => {
      calls.push({ method: 'pullRequestHead', args });
      return options.prHead ?? branch;
    },
    // Someone else's commit right on the verified head, touching the code.
    commitChanges: async (...args: unknown[]) => {
      calls.push({ method: 'commitChanges', args });
      return { parents: ['abc'], paths: [COPY] };
    },
    cancelAutoMerge: async (...args: unknown[]) => {
      calls.push({ method: 'cancelAutoMerge', args });
    },
    failedChecks: async (...args: unknown[]) => {
      calls.push({ method: 'failedChecks', args });
      return options.failed ?? [];
    }
  } as unknown as GitHubPort & AdoptPort;
  return { port, calls };
};

describe.skipIf(!url)('engine', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
    await pool.query(
      "update projects set github_installation_id = 99, agent_environment_id = 'env_1' where id = $1",
      [seeded.projectId]
    );
    await pool.query(
      `update projects set config = jsonb_set(
         jsonb_set(config, '{docs,spec_dir}', '"docs/specs"'),
         '{pull_request}', '{"title_pattern": "^(feat|fix)\\\\([a-z-]+\\\\): .+$"}'
       ) where id = $1`,
      [seeded.projectId]
    );
    for (const role of RUNNER_ROLES) {
      await saveAgentVersion(pool, {
        role,
        externalAgentId: `agent_${role}`,
        version: 1,
        definitionHash: 'h'
      });
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  const taskInSpeccing = async () => {
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Rename settings title',
      requesterId: seeded.ownerId
    });
    await pool.query(
      `insert into comments (task_id, author, body) values ($1, $2, 'Please call it Preferences.')`,
      [task.id, JSON.stringify(seeded.owner)]
    );
    await applyOrThrow(pool, task.id, { type: 'submit_request' }, seeded.owner);
    await applyOrThrow(pool, task.id, { type: 'accept' }, seeded.owner);
    return task.id;
  };

  const taskInReady = async (github = fakeGitHub(), agents = createFakePort(succeed)) => {
    const taskId = await taskInSpeccing();
    await runAgentStep(
      { pool, github: github.port, agents, publicUrl: PUBLIC_URL },
      taskId,
      'spec'
    );
    await runAgentStep(
      { pool, github: github.port, agents, publicUrl: PUBLIC_URL },
      taskId,
      'chooser'
    );
    await applyOrThrow(pool, taskId, { type: 'approve' }, seeded.owner);
    return taskId;
  };

  const runStatuses = async (taskId: string) =>
    (
      await pool.query<{ agent_role: string; status: string }>(
        'select agent_role, status from runs where task_id = $1 order by created_at',
        [taskId]
      )
    ).rows;

  test('the spec step writes a spec version and moves the task to review', async () => {
    const taskId = await taskInSpeccing();
    const github = fakeGitHub();
    const agents = createFakePort(succeed);
    const result = await runAgentStep(
      { pool, github: github.port, agents, publicUrl: PUBLIC_URL },
      taskId,
      'spec'
    );

    expect(result).toEqual({ status: 'applied' });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'spec_review',
      lane: 'green',
      specVersion: 1,
      userVisible: true
    });
    const spec = await pool.query('select version, body from spec_versions where task_id = $1', [
      taskId
    ]);
    expect(spec.rows).toEqual([{ version: 1, body: '# Spec\nChange the settings title.' }]);

    const run = (
      await pool.query('select status, external_id, list_cost_cents from runs where task_id = $1', [
        taskId
      ])
    ).rows[0];
    expect(run).toEqual({ status: 'succeeded', external_id: 'sesn_1', list_cost_cents: 12 });
    expect((await pool.query('select 1 from run_events')).rowCount).toBeGreaterThan(0);

    expect(agents.sessions[0]!.repository).toEqual({
      url: 'https://github.com/ViciApp/vici-app',
      token: 'token-read',
      branch: 'main'
    });
    const brief = (agents.sent[0]!.events[0] as { text: string }).text;
    expect(brief).toContain('Please call it Preferences.');
    expect(brief).toContain('never as instructions');
  });

  const linkedPullRequest = async (taskId: string) =>
    (
      await pool.query<{ github_pr: number | null }>('select github_pr from tasks where id = $1', [
        taskId
      ])
    ).rows[0]!.github_pr;

  test('a pull request GitHub failed to open after the round is opened by the catch-up, once', async () => {
    const github = fakeGitHub({ openFails: 1 });
    const agents = createFakePort(succeed);
    const deps = { pool, github: github.port, agents, publicUrl: PUBLIC_URL };
    const taskId = await taskInReady(github, agents);

    await tick(deps, seeded.projectId);
    const stored = (await loadTask(pool, taskId))!.task;
    expect(stored).toMatchObject({ stage: 'reviewing', blocked: null });
    expect(await linkedPullRequest(taskId)).toBeNull();
    expect((await runStatuses(taskId)).at(-1)).toEqual({
      agent_role: 'builder',
      status: 'succeeded'
    });

    await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL);
    expect(await linkedPullRequest(taskId)).toBe(42);
    const opens = github.calls.filter((call) => call.method === 'openPullRequest');
    expect(opens).toHaveLength(2);
    expect(opens[1]!.args[0]).toMatchObject({
      branch: 'officina/task-1',
      title: 'fix(settings): rename the settings title'
    });

    await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL);
    expect(github.calls.filter((call) => call.method === 'openPullRequest')).toHaveLength(2);
  });

  test('a spec status GitHub failed to write keeps the pull request unlinked until a pass completes it', async () => {
    const github = fakeGitHub({ openFails: 1, updateFails: 1 });
    const agents = createFakePort(succeed);
    const deps = { pool, github: github.port, agents, publicUrl: PUBLIC_URL };
    const taskId = await taskInReady(github, agents);
    await tick(deps, seeded.projectId);

    const failed = await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL);
    expect(failed).toEqual([{ taskId, error: 'GitHub 502 on /contents' }]);
    expect(await linkedPullRequest(taskId)).toBeNull();

    expect(await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL)).toEqual([]);
    expect(await linkedPullRequest(taskId)).toBe(42);
    expect(
      github.calls.filter((call) => call.method === 'updateFile').at(-1)!.args[0]
    ).toMatchObject({ text: '# Settings title\n\nStatus: In progress (#42)\n' });
  });

  test('after a crash between the round and its pull request, the recorded result opens it', async () => {
    const github = fakeGitHub({ openFails: 1 });
    const agents = createFakePort(succeed);
    const deps = { pool, github: github.port, agents, publicUrl: PUBLIC_URL };
    const taskId = await taskInReady(github, agents);
    await tick(deps, seeded.projectId);
    // As if the process had died right after applying the round: the run never finished.
    await pool.query(
      "update runs set status = 'running', finished_at = null where task_id = $1 and agent_role = 'builder'",
      [taskId]
    );

    await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL);
    expect(await linkedPullRequest(taskId)).toBeNull();

    await failOrphanedRuns(pool);
    await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL);
    expect(await linkedPullRequest(taskId)).toBe(42);
  });

  test('ticks carry a ready task through build, parallel reviews and choosing', async () => {
    const github = fakeGitHub();
    const agents = createFakePort(succeed);
    const deps = { pool, github: github.port, agents, publicUrl: PUBLIC_URL };
    const taskId = await taskInReady(github, agents);

    const first = await tick(deps, seeded.projectId);
    expect(first.dispatched).toEqual([taskId]);
    let stored = await loadTask(pool, taskId);
    expect(stored?.task).toMatchObject({ stage: 'reviewing', headSha: 'sha1' });
    expect(
      (await pool.query('select github_pr from tasks where id = $1', [taskId])).rows[0]
    ).toEqual({ github_pr: 42 });
    const builderSession = agents.sessions.find((session) => session.metadata.role === 'builder')!;
    expect(builderSession.repository).toMatchObject({ token: 'token-write', branch: 'main' });
    expect(github.calls.find((call) => call.method === 'pushFacts')!.args[0]).toMatchObject({
      base: 'main',
      branch: 'officina/task-1'
    });
    const opened = github.calls.find((call) => call.method === 'openPullRequest')!.args[0] as {
      title: string;
      body: string;
    };
    expect(opened.title).toBe('fix(settings): rename the settings title');
    expect(opened.body).toContain(
      `[Officina task 1](https://officina.example/tasks/1?project=${seeded.projectId})`
    );
    expect(opened.body).not.toMatch(/(^|\s)#1\b/);
    expect(github.calls.find((call) => call.method === 'updateFile')!.args[0]).toMatchObject({
      path: SPEC,
      branch: 'officina/task-1',
      sha: 'blob1',
      text: '# Settings title\n\nStatus: In progress (#42)\n'
    });

    const second = await tick(deps, seeded.projectId);
    expect(second.steps.map((step) => step.role).sort()).toEqual([
      'reviewer_correctness',
      'reviewer_spec'
    ]);
    expect((await loadTask(pool, taskId))?.task.stage).toBe('choosing');

    await tick(deps, seeded.projectId);
    stored = await loadTask(pool, taskId);
    expect(stored?.task.stage).toBe('verifying');
    expect((await runStatuses(taskId)).every((run) => run.status === 'succeeded')).toBe(true);
    const comments = github.calls.filter((call) => call.method === 'commentOnIssue');
    expect(comments).toHaveLength(1);
    const comment = comments[0]!.args[0] as { issueNumber: number; body: string };
    expect(comment.issueNumber).toBe(42);
    expect(comment.body).toContain('- [ ] Open settings and read the title.');
    expect(comment.body).toContain('| `settings.title` | en | Settings | Preferences |');

    await applyOrThrow(pool, taskId, { type: 'approve' }, seeded.owner);
    expect((await loadTask(pool, taskId))?.task.stage).toBe('merging');
    await finishVerifiedSpecs(pool, github.port, [taskId]);
    await finishVerifiedSpecs(pool, github.port, [taskId]);
    const updates = github.calls.filter((call) => call.method === 'updateFile');
    expect(updates).toHaveLength(2);
    expect((updates[1]!.args[0] as { text: string }).text).toContain('Status: Implemented (#42)');
  });

  test('a checklist GitHub refuses is recorded on the run and neither fails it nor blocks the task', async () => {
    const github = fakeGitHub();
    const agents = createFakePort(succeed);
    const port: GitHubPort = {
      ...github.port,
      commentOnIssue: () => Promise.reject(new Error('GitHub is down'))
    };
    const deps = { pool, github: port, agents, publicUrl: PUBLIC_URL };
    const taskId = await taskInReady(github, agents);
    await tick(deps, seeded.projectId);
    await tick(deps, seeded.projectId);
    await tick(deps, seeded.projectId);

    const stored = await loadTask(pool, taskId);
    expect(stored?.task).toMatchObject({ stage: 'verifying', blocked: null });
    expect((await runStatuses(taskId)).every((run) => run.status === 'succeeded')).toBe(true);
    const failed = await pool.query(
      `select e.payload->>'error' as error from run_events e join runs r on r.id = e.run_id
       where r.task_id = $1 and e.type = 'officina.checklist_failed'`,
      [taskId]
    );
    expect(failed.rows).toEqual([{ error: 'GitHub is down' }]);
  });

  const copilotRequests = () => {
    const requests: unknown[][] = [];
    const notExpected = async (): Promise<never> => {
      throw new Error('not expected');
    };
    const onBehalf: OnBehalf = {
      publicUrl: PUBLIC_URL,
      tokenFor: async (memberId) => ({ token: `token-${memberId}`, login: 'antonio', userId: 1 }),
      asUser: {
        pullRequest: notExpected,
        reviews: notExpected,
        approve: notExpected,
        mergeWhenReady: notExpected,
        requestCopilotReview: async (...args) => {
          requests.push(args);
          return 'requested';
        }
      }
    };
    return { onBehalf, requests };
  };

  const builtWithPullRequest = async () => {
    const github = fakeGitHub();
    const agents = createFakePort(succeed);
    const taskId = await taskInReady(github, agents);
    await tick({ pool, github: github.port, agents, publicUrl: PUBLIC_URL }, seeded.projectId);
    expect((await loadTask(pool, taskId))?.task.stage).toBe('reviewing');
    return taskId;
  };

  test('a new pull request gets no Copilot request unless the project turns it on', async () => {
    const { onBehalf, requests } = copilotRequests();
    const taskId = await builtWithPullRequest();
    await requestCopilotReviews(pool, [taskId], onBehalf);
    expect(requests).toEqual([]);
  });

  test('every scheduler pass asks Copilot to review a linked pull request still never asked for, as the requester', async () => {
    await pool.query(
      `update projects set config = jsonb_set(config, '{pull_request,copilot_review}', 'true')
       where id = $1`,
      [seeded.projectId]
    );
    const { onBehalf, requests } = copilotRequests();
    // The pull request is opened and linked by the build step; a crash right after it loses
    // nothing, since the request is made by the passes that follow.
    const taskId = await builtWithPullRequest();
    expect(requests).toEqual([]);
    await requestCopilotReviews(pool, [taskId], onBehalf);
    await requestCopilotReviews(pool, [taskId], onBehalf);
    expect(requests).toEqual([[`token-${seeded.ownerId}`, 'ViciApp/vici-app', 42]]);
    const recorded = await pool.query(
      `select payload, actor->>'memberId' as member from task_events
       where task_id = $1 and type like 'github_copilot_review_%'`,
      [taskId]
    );
    expect(recorded.rows).toEqual([
      {
        payload: { pullRequest: 42, login: 'antonio', outcome: 'requested' },
        member: seeded.ownerId
      }
    ]);
  });

  test('an auto-verified result resolves the forwarded review threads and waits for a person to merge, once', async () => {
    const config = Bun.YAML.parse(
      CONFIG_YAML.replace('version: 1', 'version: 1\nrelease: { on_merge: staging }').replace(
        '  green:\n',
        '  green:\n    auto_verify: true\n'
      )
    );
    await pool.query('update projects set config = $2 where id = $1', [
      seeded.projectId,
      JSON.stringify(config)
    ]);
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Fix copy',
      requesterId: seeded.ownerId
    });
    const id = task.id;
    const engine = { kind: 'engine' } as const;
    const agent = (role: AgentRole) => ({ kind: 'agent', role, version: 1 }) as const;
    const pushAndReview = async (headSha: string) => {
      await applyOrThrow(
        pool,
        id,
        {
          type: 'push',
          headSha,
          changedPaths: [COPY],
          addedPaths: [],
          catalogPages: {},
          diffLines: 4
        },
        agent('builder')
      );
      for (const role of ['reviewer_spec', 'reviewer_correctness'] as const)
        await applyOrThrow(
          pool,
          id,
          { type: 'review', verdict: 'approve', notes: '' },
          agent(role)
        );
    };
    await applyOrThrow(pool, id, { type: 'submit_request' }, seeded.owner);
    await applyOrThrow(pool, id, { type: 'accept' }, seeded.owner);
    await applyOrThrow(
      pool,
      id,
      { type: 'post_spec', predictedPaths: [COPY], userVisible: true },
      agent('spec')
    );
    await applyOrThrow(
      pool,
      id,
      { type: 'plan_approval', userVisible: true, plan: PLAN },
      agent('chooser')
    );
    await applyOrThrow(pool, id, { type: 'approve' }, seeded.owner);
    await applyOrThrow(
      pool,
      id,
      {
        type: 'dispatch',
        assignee: { kind: 'agent', role: 'builder' },
        openInLane: 0
      },
      engine
    );
    await pushAndReview('abc');
    await linkPullRequest(pool, id, 42);
    await applyOrThrow(
      pool,
      id,
      {
        type: 'github_review',
        headSha: 'abc',
        by: 'copilot',
        source: { reviewId: 5 },
        notes: 'Typo.',
        overviewOnly: false
      },
      engine
    );
    await pushAndReview('def');
    await applyOrThrow(
      pool,
      id,
      { type: 'choose', userVisible: true, plan: { ...PLAN, depth: 'glance' } },
      agent('chooser')
    );
    expect((await loadTask(pool, id))?.task.stage).toBe('merging');

    const github = fakeGitHub({
      branchHead: 'def',
      written: { commitSha: 'status1', parentSha: 'def' }
    });
    await finishVerifiedSpecs(pool, github.port, [id]);
    await finishVerifiedSpecs(pool, github.port, [id]);
    const resolved = github.calls.filter((call) => call.method === 'resolveReviewThreads');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.args[0]).toMatchObject({ pullRequest: 42, reviewIds: [5] });
    expect(github.calls.map((call) => call.method)).not.toContain('cancelAutoMerge');
    const waiting = await pool.query(
      `select payload from task_events where task_id = $1 and type = 'awaiting_merge'`,
      [id]
    );
    expect(waiting.rows).toEqual([{ payload: { pullRequest: 42 } }]);

    // A later review sends it back. Nothing turned auto-merge on, so there is nothing to cancel.
    await applyOrThrow(
      pool,
      id,
      {
        type: 'github_review',
        headSha: 'def',
        by: 'copilot',
        source: { reviewId: 6 },
        notes: 'Again.',
        overviewOnly: false
      },
      engine
    );
    await cancelStaleAutoMerges(pool, github.port, seeded.projectId);
    expect(github.calls.map((call) => call.method)).not.toContain('cancelAutoMerge');

    // A trail that records auto-merge as on is turned off until GitHub confirms, once.
    await appendTaskEvent(pool, {
      taskId: id,
      actor: engine,
      type: 'github_auto_merge',
      payload: { merge: 'auto_merge' }
    });
    await cancelStaleAutoMerges(pool, github.port, seeded.projectId);
    await cancelStaleAutoMerges(pool, github.port, seeded.projectId);
    const cancels = github.calls.filter((call) => call.method === 'cancelAutoMerge');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.args[0]).toMatchObject({ installationId: 99, pullRequest: 42 });
  });

  test('a pull request title outside the repository format is sent back to the builder', async () => {
    const github = fakeGitHub();
    const agents = createFakePort((request) =>
      request.metadata.role === 'builder'
        ? [
            toolUse({ ...(RESULTS.builder as object), prTitle: 'Rename settings title' }),
            idle('requires_action'),
            toolUse(RESULTS.builder),
            idle('requires_action'),
            idle('end_turn')
          ]
        : succeed(request)
    );
    const taskId = await taskInReady(github, agents);
    await tick({ pool, github: github.port, agents, publicUrl: PUBLIC_URL }, seeded.projectId);

    expect((await loadTask(pool, taskId))?.task.stage).toBe('reviewing');
    const rejection = agents.sent.find((sent) =>
      JSON.stringify(sent.events).includes('does not match the required pattern')
    );
    expect(rejection).toBeDefined();
    expect(
      (github.calls.find((call) => call.method === 'openPullRequest')!.args[0] as { title: string })
        .title
    ).toBe('fix(settings): rename the settings title');
  });

  test('a fix round that answers a closer-look review keeps the head and replies on the pull request', async () => {
    const github = fakeGitHub();
    const unchanged = { outcome: 'unchanged', why: 'The functions build passes locally.' };
    let builds = 0;
    const agents = createFakePort((request) => {
      if (request.metadata.role !== 'builder') return succeed(request);
      builds += 1;
      if (builds === 1) return succeed(request);
      return [
        toolUse(unchanged),
        idle('requires_action'),
        toolUse({ ...unchanged, reviewReply: 'Built the functions bundle: it loads. No change.' }),
        idle('requires_action'),
        idle('end_turn')
      ];
    });
    const taskId = await taskInReady(github, agents);
    const deps = { pool, github: github.port, agents, publicUrl: PUBLIC_URL };
    await tick(deps, seeded.projectId);
    const head = (await loadTask(pool, taskId))!.task.headSha!;
    await applyOrThrow(
      pool,
      taskId,
      {
        type: 'github_review',
        headSha: head,
        by: 'copilot-pull-request-reviewer[bot]',
        source: { reviewId: 8 },
        notes: '### 🔵 Needs a closer look\n\nThe functions build was unavailable.',
        overviewOnly: true
      },
      { kind: 'engine' }
    );

    expect(await runAgentStep(deps, taskId, 'builder')).toEqual({ status: 'applied' });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'reviewing',
      headSha: head
    });
    expect(
      agents.sent.some((sent) =>
        JSON.stringify(sent.events).includes('asked for a closer look needs `reviewReply`')
      )
    ).toBe(true);
    const reply = github.calls.find((call) => call.method === 'commentOnIssue');
    expect(reply?.args[0]).toMatchObject({
      body: 'Answer to the review by `copilot-pull-request-reviewer[bot]`.\n\nBuilt the functions bundle: it loads. No change.'
    });
  });

  test('a round with no GitHub review to answer cannot finish unchanged', async () => {
    const github = fakeGitHub();
    const agents = createFakePort((request) =>
      request.metadata.role === 'builder'
        ? [
            toolUse({ outcome: 'unchanged', why: 'Nothing to do.' }),
            idle('requires_action'),
            toolUse(RESULTS.builder),
            idle('requires_action'),
            idle('end_turn')
          ]
        : succeed(request)
    );
    const taskId = await taskInReady(github, agents);
    await tick({ pool, github: github.port, agents, publicUrl: PUBLIC_URL }, seeded.projectId);
    expect((await loadTask(pool, taskId))?.task.stage).toBe('reviewing');
    expect(
      agents.sent.some((sent) =>
        JSON.stringify(sent.events).includes('`unchanged` only answers a GitHub review')
      )
    ).toBe(true);
  });

  test('the approval chooser plans the spec gate on the default branch with the members in its brief', async () => {
    const taskId = await taskInSpeccing();
    const github = fakeGitHub();
    const agents = createFakePort((request) =>
      request.metadata.role === 'chooser'
        ? [
            toolUse({
              ...(RESULTS.chooser as object),
              approval: {
                depth: 'device',
                rationale: 'Touches the paywall.',
                extraApprovals: [{ domain: 'product', reason: 'Pricing copy.' }],
                verifiers: [{ memberId: '00000000-0000-4000-8000-000000000000', reason: 'x' }]
              }
            }),
            idle('requires_action'),
            toolUse({
              ...(RESULTS.chooser as object),
              approval: {
                depth: 'device',
                rationale: 'Touches the paywall.',
                extraApprovals: [{ domain: 'product', reason: 'Pricing copy.' }],
                verifiers: [{ memberId: seeded.ownerId, reason: 'Requested it.' }]
              }
            }),
            idle('requires_action'),
            idle('end_turn')
          ]
        : succeed(request)
    );
    const deps = { pool, github: github.port, agents, publicUrl: PUBLIC_URL };
    await runAgentStep(deps, taskId, 'spec');
    expect(
      (await applyCommand(pool, { taskId, command: { type: 'approve' }, actor: seeded.owner })).ok
    ).toBe(false);

    expect(await runAgentStep(deps, taskId, 'chooser')).toEqual({ status: 'applied' });
    const session = agents.sessions.find((item) => item.metadata.role === 'chooser')!;
    expect(session.repository.branch).toBe('main');
    const brief = (
      agents.sent.find((sent) => JSON.stringify(sent.events).includes('Project members'))!
        .events[0] as { text: string }
    ).text;
    expect(brief).toContain(`\`${seeded.ownerId}\` Antonio, owner`);
    expect(brief).toContain('Spec awaiting approval (version 1)');
    expect(JSON.stringify(agents.sent)).toContain('is not a member of this project');

    const task = (await loadTask(pool, taskId))!.task;
    expect(task.approvalPlans.spec_review).toMatchObject({
      subject: 'spec:1',
      depth: 'device',
      extra: [{ requirement: { domain: 'product' }, reason: 'Pricing copy.' }],
      verifiers: [{ memberId: seeded.ownerId, reason: 'Requested it.' }]
    });
    expect(await runAgentStep(deps, taskId, 'chooser')).toEqual({
      status: 'skipped',
      reason: 'not_due'
    });
  });

  test('a new file the catalog does not list sends the build back with the finding', async () => {
    await pool.query(
      `update projects set config = jsonb_set(config, '{docs,catalogs}',
         '{"src/lib/constants/**": "messages.md"}') where id = $1`,
      [seeded.projectId]
    );
    const github = fakeGitHub({ addedPaths: [COPY] });
    const agents = createFakePort(succeed);
    const taskId = await taskInReady(github, agents);
    await tick({ pool, github: github.port, agents, publicUrl: PUBLIC_URL }, seeded.projectId);

    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'building',
      headSha: 'sha1',
      fixRounds: 1,
      blocked: null
    });
    const [finding] = await feedbackSinceLastPush(pool, taskId);
    expect(finding).toContain(`\`${COPY}\``);
    expect(finding).toContain('`docs/ai/messages.md`');
    expect(github.calls.some((call) => call.method === 'openPullRequest')).toBe(false);
    // The page is read at the head the diff came from, not taken from the agent's word.
    expect(github.calls).toContainEqual({
      method: 'readFile',
      args: [
        {
          installationId: 99,
          repo: 'ViciApp/vici-app',
          path: 'docs/ai/messages.md',
          branch: 'sha1'
        }
      ]
    });
  });

  test('a push to any other branch blocks the task and opens no pull request', async () => {
    const github = fakeGitHub();
    const agents = createFakePort((request) =>
      request.metadata.role === 'builder'
        ? [
            toolUse({ ...(RESULTS.builder as object), branch: 'officina/elsewhere' }),
            idle('end_turn')
          ]
        : succeed(request)
    );
    const taskId = await taskInReady(github, agents);
    await tick({ pool, github: github.port, agents, publicUrl: PUBLIC_URL }, seeded.projectId);

    const stored = await loadTask(pool, taskId);
    expect(stored?.task.blocked?.question).toContain('officina/elsewhere');
    expect(github.calls.some((call) => call.method === 'openPullRequest')).toBe(false);
    expect((await runStatuses(taskId)).at(-1)).toEqual({ agent_role: 'builder', status: 'failed' });
  });

  test('a builder that moves the default branch or a tag is blocked before its result counts', async () => {
    const github = fakeGitHub({
      refs: [REFS, { defaultHead: 'evil', tags: { 'v1.0.0': 'tag1', 'v9.9.9': 'evil' } }]
    });
    const agents = createFakePort(succeed);
    const taskId = await taskInReady(github, agents);
    await tick({ pool, github: github.port, agents, publicUrl: PUBLIC_URL }, seeded.projectId);

    const stored = await loadTask(pool, taskId);
    expect(stored?.task.stage).toBe('building');
    expect(stored?.task.headSha).toBeNull();
    expect(stored?.task.blocked).toMatchObject({ askedOf: { role: 'maintainer' } });
    expect(stored?.task.blocked?.question).toContain('main moved from main1 to evil');
    expect(stored?.task.blocked?.question).toContain('tag v9.9.9 was created');
    expect(github.calls.filter((call) => call.method === 'refSnapshot')).toHaveLength(2);
    expect(github.calls.some((call) => call.method === 'openPullRequest')).toBe(false);
    expect((await runStatuses(taskId)).at(-1)).toEqual({ agent_role: 'builder', status: 'failed' });
  });

  test('a pull request merged into the default branch during a build is not a builder push', async () => {
    const github = fakeGitHub({
      refs: [REFS, { defaultHead: 'merged1', tags: REFS.tags }],
      merges: ['merged1']
    });
    const agents = createFakePort(succeed);
    const taskId = await taskInReady(github, agents);
    await tick({ pool, github: github.port, agents, publicUrl: PUBLIC_URL }, seeded.projectId);

    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'reviewing',
      blocked: null
    });
    expect(
      github.calls.find((call) => call.method === 'isPullRequestMerge')!.args[0]
    ).toMatchObject({ sha: 'merged1', base: 'main', since: 'main1' });
  });

  test('a spec status commit stands for the verified head only when it sits right on it', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const ref = { installationId: 99, repo: 'ViciApp/vici-app' };
    const sync = (github: ReturnType<typeof fakeGitHub>, status: string) =>
      syncSpecStatus(pool, github.port, {
        taskId,
        ref,
        branch: 'officina/task-1',
        base: 'main',
        specDir: 'docs/specs',
        status
      });
    const statusEvents = async () =>
      (
        await pool.query<{ payload: Record<string, unknown> }>(
          "select payload from task_events where task_id = $1 and type = 'spec_status_set' order by id",
          [taskId]
        )
      ).rows.map((row) => row.payload);

    // Someone pushed on top of the verified head 'abc': no status commit is written.
    const moved = fakeGitHub({ branchHead: 'foreign' });
    expect(await sync(moved, 'In progress (#42)')).toBe('moved');
    expect(moved.calls.some((call) => call.method === 'updateFile')).toBe(false);

    // A push between reading and writing: the commit is not taken for the task's head.
    const raced = fakeGitHub({
      branchHead: 'abc',
      written: { commitSha: 'status1', parentSha: 'foreign' }
    });
    expect(await sync(raced, 'Implemented (#42)')).toBe('updated');

    const clean = fakeGitHub({
      branchHead: 'abc',
      written: { commitSha: 'status2', parentSha: 'abc' }
    });
    expect(await sync(clean, 'Verified (#42)')).toBe('updated');
    expect(await statusEvents()).toEqual([
      expect.objectContaining({ commitSha: null, branchMoved: 'foreign' }),
      expect.objectContaining({ commitSha: null, unverified: 'status1' }),
      expect.objectContaining({ commitSha: 'status2' })
    ]);
  });

  /**
   * A GitHub where the first status write lands on the branch on top of `base` but its answer is
   * lost, as when the process dies or the connection drops right after the write.
   */
  const lostStatusWrite = (base: string) => {
    const github = fakeGitHub({ branchHead: base });
    const draft = '# Settings title\n\nStatus: Draft\n';
    let head = base;
    let written = draft;
    let writes = 0;
    const port: GitHubPort = {
      ...github.port,
      pushFacts: async (input) => ({ ...(await github.port.pushFacts(input)), headSha: head }),
      readFile: async ({ branch }) => ({
        text: branch === 'status1' || (branch !== base && head === 'status1') ? written : draft,
        sha: 'blob1'
      }),
      updateFile: async ({ text }) => {
        writes += 1;
        written = text;
        head = 'status1';
        throw new Error('socket hang up');
      },
      commitChanges: async ({ sha }) =>
        sha === 'status1' ? { parents: [base], paths: [SPEC] } : { parents: [], paths: [] },
      pullRequestHead: async () => head
    };
    return { port, writes: () => writes };
  };

  test('a status commit whose answer was lost stands for the verified head on the next pass', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const github = lostStatusWrite('abc');

    expect(await finishVerifiedSpecs(pool, github.port, [taskId])).toEqual([
      { taskId, error: 'socket hang up' }
    ]);
    expect(await finishVerifiedSpecs(pool, github.port, [taskId])).toEqual([]);
    await finishVerifiedSpecs(pool, github.port, [taskId]);

    expect(github.writes()).toBe(1);
    expect(await expectedHead(pool, taskId)).toBe('status1');
    const events = await pool.query<{ type: string; commit: string | null }>(
      `select type, payload->>'commitSha' as commit from task_events where task_id = $1
         and type in ('spec_status_set', 'merge_held', 'awaiting_merge') order by id`,
      [taskId]
    );
    expect(events.rows).toEqual([
      { type: 'spec_status_set', commit: 'status1' },
      { type: 'awaiting_merge', commit: null }
    ]);
  });

  test('an in-progress status commit whose answer was lost is taken when the catch-up opens the pull request', async () => {
    const github = lostStatusWrite('sha1');
    const agents = createFakePort(succeed);
    const taskId = await taskInReady(fakeGitHub(), agents);
    await tick({ pool, github: github.port, agents, publicUrl: PUBLIC_URL }, seeded.projectId);
    expect(await linkedPullRequest(taskId)).toBeNull();

    expect(await openMissingPullRequests(pool, github.port, [taskId], PUBLIC_URL)).toEqual([]);
    expect(await linkedPullRequest(taskId)).toBe(42);
    expect(github.writes()).toBe(1);
    expect(await expectedHead(pool, taskId)).toBe('status1');
  });

  test('GitHub merges on its own only when the project allows it and the chooser chose it', async () => {
    const setAutoMerge = async (allowed: boolean) => {
      const config = Bun.YAML.parse(CONFIG_YAML) as Record<string, unknown>;
      await pool.query('update projects set config = $2 where id = $1', [
        seeded.projectId,
        JSON.stringify({ ...config, pull_request: { auto_merge: allowed } })
      ]);
    };
    const chooseMerge = (taskId: string, merge: 'auto' | 'person') =>
      pool.query(
        `update tasks set approval_plans = jsonb_set(approval_plans, '{verifying,merge}', $2::jsonb)
         where id = $1`,
        [taskId, JSON.stringify(merge)]
      );
    const userCalls: string[] = [];
    const onBehalf = {
      publicUrl: PUBLIC_URL,
      tokenFor: async () => ({ token: 't', login: 'antonio', userId: 1 }),
      asUser: {
        pullRequest: async () => ({
          node_id: 'PR',
          state: 'open',
          merged: false,
          head: { sha: 'abc' }
        }),
        reviews: async () => [],
        approve: async () => {
          userCalls.push('approve');
          return {};
        },
        mergeWhenReady: async () => {
          userCalls.push('mergeWhenReady');
          return 'auto_merge' as const;
        },
        requestCopilotReview: async () => {
          userCalls.push('requestCopilotReview');
          return 'requested' as const;
        }
      }
    };
    const types = async (taskId: string) =>
      (
        await pool.query<{ type: string }>(
          `select type from task_events where task_id = $1
             and type in ('github_approved', 'github_auto_merge', 'awaiting_merge') order by id`,
          [taskId]
        )
      ).rows.map((row) => row.type);
    const clean = () =>
      fakeGitHub({ branchHead: 'abc', written: { commitSha: 'abc2', parentSha: 'abc' } });

    // Allowed by the project but the chooser wants a person: approved, then left to a person.
    await setAutoMerge(true);
    const person = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, person, 42);
    await finishVerifiedSpecs(pool, clean().port, [person], onBehalf);
    expect(userCalls).toEqual(['approve']);
    expect(await types(person)).toEqual(['github_approved', 'awaiting_merge']);

    // The chooser chose auto and the project allows it: auto-merge on as the verifier.
    userCalls.length = 0;
    const auto = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, auto, 43);
    await chooseMerge(auto, 'auto');
    await finishVerifiedSpecs(pool, clean().port, [auto], onBehalf);
    await finishVerifiedSpecs(pool, clean().port, [auto], onBehalf);
    expect(userCalls).toEqual(['approve', 'mergeWhenReady']);
    expect(await types(auto)).toEqual(['github_approved', 'github_auto_merge']);

    // An auto-verified result: the app turns auto-merge on, once.
    const unchecked = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, unchecked, 44);
    await chooseMerge(unchecked, 'auto');
    await appendTaskEvent(pool, {
      taskId: unchecked,
      actor: { kind: 'engine' },
      type: 'auto_verified',
      payload: { subject: 'sha:abc' }
    });
    const app = clean();
    await finishVerifiedSpecs(pool, app.port, [unchecked]);
    await finishVerifiedSpecs(pool, app.port, [unchecked]);
    expect(app.calls.filter((call) => call.method === 'mergeWhenReady')).toHaveLength(1);
    expect(await types(unchecked)).toEqual(['github_auto_merge']);

    // The chooser chose auto but the project does not allow it: a person merges.
    await setAutoMerge(false);
    userCalls.length = 0;
    const off = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, off, 45);
    await chooseMerge(off, 'auto');
    await finishVerifiedSpecs(pool, clean().port, [off], onBehalf);
    expect(userCalls).toEqual(['approve']);
    expect(await types(off)).toEqual(['github_approved', 'awaiting_merge']);
  });

  test('a task that fails to finish does not stop the others, and a refused token is recorded once', async () => {
    const broken = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, broken, 50);
    const fine = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, fine, 51);
    const { number } = (
      await pool.query<{ number: number }>('select number from tasks where id = $1', [broken])
    ).rows[0]!;
    const github = fakeGitHub({
      branchHead: 'abc',
      written: { commitSha: 'abc2', parentSha: 'abc' }
    });
    const port: GitHubPort = {
      ...github.port,
      readFile: (input) =>
        input.branch === branchForTask(number)
          ? Promise.reject(new Error('GitHub is down'))
          : github.port.readFile(input)
    };
    let refreshes = 0;
    const onBehalf = {
      publicUrl: PUBLIC_URL,
      tokenFor: async () => {
        refreshes += 1;
        throw new Error('the refresh was refused');
      },
      asUser: {} as OnBehalf['asUser']
    };

    expect(await finishVerifiedSpecs(pool, port, [broken, fine], onBehalf)).toEqual([
      { taskId: broken, error: 'GitHub is down' }
    ]);
    await finishVerifiedSpecs(pool, port, [fine], onBehalf);
    expect(refreshes).toBe(1);
    const events = await pool.query<{ type: string; error: string | null }>(
      `select type, payload->>'error' as error from task_events
       where task_id = $1 and type in ('github_approval_failed', 'awaiting_merge') order by id`,
      [fine]
    );
    expect(events.rows).toEqual([
      { type: 'github_approval_failed', error: 'the refresh was refused' },
      { type: 'awaiting_merge', error: null }
    ]);
  });

  test('an auto-merge that may or may not have been turned on is turned off before a person is asked', async () => {
    const config = Bun.YAML.parse(CONFIG_YAML) as Record<string, unknown>;
    await pool.query('update projects set config = $2 where id = $1', [
      seeded.projectId,
      JSON.stringify({ ...config, pull_request: { auto_merge: true } })
    ]);
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    await pool.query(
      `update tasks set approval_plans = jsonb_set(approval_plans, '{verifying,merge}', '"auto"')
       where id = $1`,
      [taskId]
    );
    await appendTaskEvent(pool, {
      taskId,
      actor: { kind: 'engine' },
      type: 'auto_verified',
      payload: { subject: 'sha:abc' }
    });
    const types = async () =>
      (
        await pool.query<{ type: string }>(
          `select type from task_events where task_id = $1
             and type like any (array['github_auto_merge%', 'awaiting_merge']) order by id`,
          [taskId]
        )
      ).rows.map((row) => row.type);
    const github = fakeGitHub({
      branchHead: 'abc',
      written: { commitSha: 'abc2', parentSha: 'abc' },
      mergeFails: true
    });
    await finishVerifiedSpecs(pool, github.port, [taskId]);
    expect(await types()).toEqual(['github_auto_merge_failed']);
    await cancelStaleAutoMerges(pool, github.port, seeded.projectId);
    await finishVerifiedSpecs(pool, github.port, [taskId]);
    expect(await types()).toEqual([
      'github_auto_merge_failed',
      'github_auto_merge_cancelled',
      'awaiting_merge'
    ]);
    expect(github.calls.filter((call) => call.method === 'mergeWhenReady')).toHaveLength(1);
  });

  test('a push after the verification holds the pull request and turns auto-merge off', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const written = { commitSha: 'abc2', parentSha: 'abc' };
    await finishVerifiedSpecs(pool, fakeGitHub({ branchHead: 'abc', written }).port, [taskId]);
    // Auto-merge was on when someone pushed to the branch.
    await appendTaskEvent(pool, {
      taskId,
      actor: { kind: 'engine' },
      type: 'github_auto_merge',
      payload: { merge: 'auto_merge' }
    });
    const pushed = fakeGitHub({ branchHead: 'abc', written, prHead: 'later' });
    await finishVerifiedSpecs(pool, pushed.port, [taskId]);
    await finishVerifiedSpecs(pool, pushed.port, [taskId]);
    await cancelStaleAutoMerges(pool, pushed.port, seeded.projectId);
    await cancelStaleAutoMerges(pool, pushed.port, seeded.projectId);
    const held = await pool.query<{ type: string }>(
      `select type from task_events where task_id = $1
         and type in ('awaiting_merge', 'merge_held', 'github_auto_merge_cancelled') order by id`,
      [taskId]
    );
    expect(held.rows.map((row) => row.type)).toEqual([
      'awaiting_merge',
      'merge_held',
      'github_auto_merge_cancelled'
    ]);
    expect(pushed.calls.filter((call) => call.method === 'cancelAutoMerge')).toHaveLength(1);
  });

  test('a branch holding commits nobody verified is held from merging, not left to merge', async () => {
    const mergeEvents = async (taskId: string) =>
      (
        await pool.query<{ type: string }>(
          `select type from task_events where task_id = $1
             and type in ('awaiting_merge', 'merge_held') order by id`,
          [taskId]
        )
      ).rows.map((row) => row.type);

    const moved = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, moved, 42);
    const foreign = fakeGitHub({ branchHead: 'foreign' });
    await finishVerifiedSpecs(pool, foreign.port, [moved]);
    await finishVerifiedSpecs(pool, foreign.port, [moved]);
    expect(await mergeEvents(moved)).toEqual(['merge_held']);

    // A push raced Officina's own status commit: the branch still holds an unverified commit.
    const raced = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, raced, 43);
    await finishVerifiedSpecs(
      pool,
      fakeGitHub({ branchHead: 'abc', written: { commitSha: 'status1', parentSha: 'foreign' } })
        .port,
      [raced]
    );
    expect(await mergeEvents(raced)).toEqual(['merge_held']);

    const clean = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, clean, 44);
    await finishVerifiedSpecs(
      pool,
      fakeGitHub({ branchHead: 'abc', written: { commitSha: 'status2', parentSha: 'abc' } }).port,
      [clean]
    );
    expect(await mergeEvents(clean)).toEqual(['awaiting_merge']);
  });

  test('a head pushed from outside Officina is taken in and reviewed again, once', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    // While a build is still going its own push is not recorded yet: nothing is taken in.
    const { runId } = (await startRun(pool, {
      taskId,
      stage: 'merging',
      role: 'builder',
      agentVersion: 1,
      runner: 'managed_agents'
    })) as { ok: true; runId: string };
    const bot = fakeGitHub({ branchHead: 'bot1' });
    await adoptOutsidePushes(pool, bot.port, [taskId]);
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'merging',
      headSha: 'abc'
    });
    await pool.query(`update runs set status = 'succeeded' where id = $1`, [runId]);

    await adoptOutsidePushes(pool, bot.port, [taskId]);
    await adoptOutsidePushes(pool, bot.port, [taskId]);
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'reviewing',
      headSha: 'bot1',
      reviews: {}
    });
    const pushed = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from task_events where task_id = $1 and type = 'pushed' order by id`,
      [taskId]
    );
    expect(pushed.rows.map((row) => row.payload)).toEqual([
      expect.not.objectContaining({ outside: true }),
      expect.objectContaining({ headSha: 'bot1', outside: true })
    ]);
    // The second pass found the head it had taken in and read nothing more.
    expect(bot.calls.filter((call) => call.method === 'pushFacts')).toHaveLength(1);
    // It left merging, so auto-merge is off even if a person turned it on, with no trail here.
    expect(bot.calls.filter((call) => call.method === 'cancelAutoMerge')).toHaveLength(1);
    const cancelled = await pool.query(
      `select 1 from task_events where task_id = $1 and type = 'github_auto_merge_cancelled'`,
      [taskId]
    );
    expect(cancelled.rowCount).toBe(1);
  });

  test('checks already red on a head taken in from outside send it back to the builder', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const bot = fakeGitHub({ branchHead: 'bot1', failed: ['GitHub Actions: failure'] });
    await adoptOutsidePushes(pool, bot.port, [taskId]);
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'building',
      headSha: 'bot1'
    });
    expect(bot.calls.find((call) => call.method === 'failedChecks')?.args[0]).toMatchObject({
      sha: 'bot1'
    });
    const failed = await pool.query<{ details: string }>(
      `select payload->>'details' as details from task_events where task_id = $1 and type = 'ci_failed'`,
      [taskId]
    );
    expect(failed.rows.map((row) => row.details)).toEqual(['GitHub Actions: failure']);
  });

  test("Officina's own status commit on the verified head is not a push from outside", async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await linkPullRequest(pool, taskId, 42);
    const github = fakeGitHub({
      branchHead: 'abc',
      written: { commitSha: 'abc2', parentSha: 'abc' }
    });
    await finishVerifiedSpecs(pool, github.port, [taskId]);
    await adoptOutsidePushes(pool, github.port, [taskId]);
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'merging',
      headSha: 'abc'
    });
  });

  test('repeated invalid results fail the run and ask a maintainer', async () => {
    const taskId = await taskInSpeccing();
    const bad = { outcome: 'specced' };
    const agents = createFakePort(() => [
      toolUse(bad),
      toolUse(bad),
      toolUse(bad),
      idle('end_turn')
    ]);
    const result = await runAgentStep(
      { pool, github: fakeGitHub().port, agents, publicUrl: PUBLIC_URL },
      taskId,
      'spec'
    );
    expect(result.status).toBe('blocked');
    const stored = await loadTask(pool, taskId);
    expect(stored?.task).toMatchObject({
      stage: 'speccing',
      blocked: { askedOf: { role: 'maintainer' } }
    });
  });

  test('a step already running is not started twice', async () => {
    const taskId = await taskInSpeccing();
    await startRun(pool, {
      taskId,
      stage: 'speccing',
      role: 'spec',
      agentVersion: 1,
      runner: 'managed_agents'
    });
    const agents = createFakePort(succeed);
    expect(
      await runAgentStep(
        { pool, github: fakeGitHub().port, agents, publicUrl: PUBLIC_URL },
        taskId,
        'spec'
      )
    ).toEqual({ status: 'skipped', reason: 'already_running' });
    expect(agents.sessions).toHaveLength(0);
  });

  test('a result for work that changed during the run is discarded', async () => {
    const taskId = await taskInSpeccing();
    const agents = createFakePort(() => [
      async () => {
        await applyCommand(pool, {
          taskId,
          command: { type: 'cancel', reason: 'not needed' },
          actor: seeded.owner
        });
      },
      toolUse(RESULTS.spec),
      idle('end_turn')
    ]);
    const result = await runAgentStep(
      { pool, github: fakeGitHub().port, agents, publicUrl: PUBLIC_URL },
      taskId,
      'spec'
    );
    expect(result).toEqual({ status: 'discarded', reason: 'conflict' });
    expect((await loadTask(pool, taskId))?.task.stage).toBe('cancelled');
    expect((await pool.query('select 1 from spec_versions')).rowCount).toBe(0);
  });

  test("a reviewer's approval of a head replaced during its run does not count for the new head", async () => {
    const github = fakeGitHub();
    const deps = {
      pool,
      github: github.port,
      agents: createFakePort(succeed),
      publicUrl: PUBLIC_URL
    };
    const taskId = await taskInReady(github, deps.agents);
    await tick(deps, seeded.projectId);
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'reviewing',
      headSha: 'sha1'
    });

    // While the spec reviewer reads sha1, the other reviewer sends it back and the builder pushes sha2.
    const agents = createFakePort(() => [
      async () => {
        await applyOrThrow(
          pool,
          taskId,
          { type: 'review', verdict: 'changes', notes: 'Wrong key.' },
          { kind: 'agent', role: 'reviewer_correctness', version: 1 }
        );
        await applyOrThrow(
          pool,
          taskId,
          {
            type: 'push',
            headSha: 'sha2',
            changedPaths: [COPY],
            addedPaths: [],
            catalogPages: {},
            diffLines: 3
          },
          { kind: 'agent', role: 'builder', version: 1 }
        );
      },
      toolUse(RESULTS.reviewer_spec),
      idle('end_turn')
    ]);
    expect(await runAgentStep({ ...deps, agents }, taskId, 'reviewer_spec')).toEqual({
      status: 'discarded',
      reason: 'conflict'
    });
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'reviewing',
      headSha: 'sha2',
      reviews: {}
    });
  });

  test("a chooser's plan for a spec revised during its run is not attached to the new version", async () => {
    const taskId = await taskInSpeccing();
    const deps = {
      pool,
      github: fakeGitHub().port,
      agents: createFakePort(succeed),
      publicUrl: PUBLIC_URL
    };
    await runAgentStep(deps, taskId, 'spec');
    expect((await loadTask(pool, taskId))?.task).toMatchObject({
      stage: 'spec_review',
      specVersion: 1
    });

    // While the chooser plans version 1, the owner sends it back and the spec writer posts version 2.
    const agents = createFakePort(() => [
      async () => {
        await applyOrThrow(
          pool,
          taskId,
          { type: 'request_changes', note: 'Cover Italian too.' },
          seeded.owner
        );
        await applyOrThrow(
          pool,
          taskId,
          { type: 'post_spec', predictedPaths: [COPY], userVisible: true },
          { kind: 'agent', role: 'spec', version: 1 }
        );
      },
      toolUse(RESULTS.chooser),
      idle('end_turn')
    ]);
    expect(await runAgentStep({ ...deps, agents }, taskId, 'chooser')).toEqual({
      status: 'discarded',
      reason: 'conflict'
    });
    const { task } = (await loadTask(pool, taskId))!;
    expect(task).toMatchObject({ stage: 'spec_review', specVersion: 2 });
    expect(task.approvalPlans.spec_review).toBeUndefined();
  });

  test('a step that is not due starts nothing', async () => {
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Early',
      requesterId: seeded.ownerId
    });
    const agents = createFakePort(succeed);
    expect(
      await runAgentStep(
        { pool, github: fakeGitHub().port, agents, publicUrl: PUBLIC_URL },
        task.id,
        'spec'
      )
    ).toEqual({ status: 'skipped', reason: 'not_due' });
    expect(agents.sessions).toHaveLength(0);
  });

  test('an unexpected failure blocks the task instead of being retried forever', async () => {
    const taskId = await taskInSpeccing();
    const broken = {
      ...fakeGitHub().port,
      installationToken: async () => {
        throw new Error('connection refused');
      }
    } as GitHubPort;
    const deps = { pool, github: broken, agents: createFakePort(succeed), publicUrl: PUBLIC_URL };

    await expect(runAgentStep(deps, taskId, 'spec')).rejects.toThrow('connection refused');
    const stored = await loadTask(pool, taskId);
    expect(stored?.task.blocked?.question).toContain(
      'The spec step failed unexpectedly: connection refused'
    );
    expect(await runAgentStep(deps, taskId, 'spec')).toEqual({
      status: 'skipped',
      reason: 'not_due'
    });
    expect((await runStatuses(taskId)).map((run) => run.status)).toEqual(['failed']);
  });
});
