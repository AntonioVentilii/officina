import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { applyCommand, createTask, loadTask, saveAgentVersion, startRun } from '@officina/db';
import { RUNNER_ROLES, type SessionRequest } from '@officina/runner';
import { Pool } from 'pg';
import { applyOrThrow, resetAndSeed, type Seeded } from '../../db/test/seed';
import { createFakePort, idle, toolUse, type ScriptItem } from '../../runner/test/fake-port';
import { finishVerifiedSpecs, runAgentStep, tick, type GitHubPort } from '../src';

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

const fakeGitHub = () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const port = {
    installationToken: async (...args: unknown[]) => {
      calls.push({ method: 'installationToken', args });
      return `token-${(args[1] as { contents: string }).contents}`;
    },
    pushFacts: async (...args: unknown[]) => {
      calls.push({ method: 'pushFacts', args });
      return { headSha: 'sha1', changedPaths: [COPY, SPEC], diffLines: 3 };
    },
    readFile: async (...args: unknown[]) => {
      calls.push({ method: 'readFile', args });
      return { text: '# Settings title\n\nStatus: Draft\n', sha: 'blob1' };
    },
    updateFile: async (...args: unknown[]) => {
      calls.push({ method: 'updateFile', args });
    },
    commentOnIssue: async (...args: unknown[]) => {
      calls.push({ method: 'commentOnIssue', args });
    },
    openPullRequest: async (...args: unknown[]) => {
      calls.push({ method: 'openPullRequest', args });
      return { number: 42, url: 'https://github.com/ViciApp/vici-app/pull/42' };
    }
  } as unknown as GitHubPort;
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
    expect(opened.body).toContain('[Officina task 1](https://officina.example/tasks/1)');
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
