import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { parseProjectConfig, requiredDocs } from '@officina/core';
import { createTask, loadTask, loadTaskContext, saveAgentVersion } from '@officina/db';
import { RUNNER_ROLES } from '@officina/runner';
import { Pool } from 'pg';
import { PLAN, applyOrThrow, resetAndSeed, type Seeded } from '../../db/test/seed';
import { createFakePort, idle, toolUse } from '../../runner/test/fake-port';
import { collectDueSteps, ensureOnboarding, runAgentStep, type GitHubPort } from '../src';

const url = process.env.TEST_DATABASE_URL;
const PUBLIC_URL = 'https://officina.example';
const DOCS = ['AGENTS.md', 'CLAUDE.md', 'docs/ai/README.md', 'docs/ai/reusability.md'];

const ONBOARDED = {
  outcome: 'pushed',
  branch: 'officina/task-1',
  prTitle: 'docs(ai): add the agent docs',
  verified: ['bun run lint'],
  notVerified: [],
  followUps: ['src/lib/format.ts and src/utils/format.ts duplicate the date helpers']
};

const fakeGitHub = (changedPaths: readonly string[]) => {
  const opened: { title: string; body: string }[] = [];
  const port = {
    refSnapshot: async () => ({ defaultHead: 'main1', tags: {} }),
    isPullRequestMerge: async () => false,
    installationToken: async () => 'token',
    pushFacts: async () => ({ headSha: 'sha1', changedPaths, diffLines: 200 }),
    readFile: async () => null,
    openPullRequest: async (input: { title: string; body: string }) => {
      opened.push(input);
      return { number: 7, url: 'https://github.com/ViciApp/vici-app/pull/7' };
    }
  } as unknown as GitHubPort;
  return { port, opened };
};

describe.skipIf(!url)('onboarding', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
    await pool.query(
      "update projects set github_installation_id = 99, agent_environment_id = 'env_1' where id = $1",
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

  const config = async () => {
    const { rows } = await pool.query<{ config: unknown }>('select config from projects');
    const parsed = parseProjectConfig(rows[0]!.config);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    return parsed.config;
  };

  const openOnboarding = async () =>
    ensureOnboarding(pool, {
      projectId: seeded.projectId,
      requesterId: seeded.ownerId,
      repo: 'ViciApp/vici-app',
      config: await config(),
      missing: ['AGENTS.md', 'docs/ai/reusability.md']
    });

  /** A request taken to `ready` by people, as if its spec was written and approved. */
  const readyRequest = async () => {
    const { task } = await createTask(pool, {
      projectId: seeded.projectId,
      title: 'Rename settings',
      requesterId: seeded.ownerId
    });
    await applyOrThrow(pool, task.id, { type: 'submit_request' }, seeded.owner);
    await applyOrThrow(pool, task.id, { type: 'accept' }, seeded.owner);
    await applyOrThrow(
      pool,
      task.id,
      { type: 'post_spec', predictedPaths: ['src/routes/+page.svelte'], userVisible: false },
      seeded.owner
    );
    await applyOrThrow(
      pool,
      task.id,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      { kind: 'engine' }
    );
    await applyOrThrow(pool, task.id, { type: 'approve' }, seeded.owner);
    return task.id;
  };

  test('a project without its agent docs gets one onboarding task, waiting for people to approve its spec', async () => {
    expect(
      await ensureOnboarding(pool, {
        projectId: seeded.projectId,
        requesterId: seeded.ownerId,
        repo: 'ViciApp/vici-app',
        config: await config(),
        missing: []
      })
    ).toBeNull();

    const number = await openOnboarding();
    expect(number).toBe(1);
    expect(await openOnboarding()).toBe(1);

    const { rows } = await pool.query<{ id: string; kind: string }>('select id, kind from tasks');
    expect(rows).toHaveLength(1);
    const context = await loadTaskContext(pool, rows[0]!.id);
    expect(context?.task).toMatchObject({
      kind: 'onboarding',
      stage: 'spec_review',
      specVersion: 1,
      lane: 'standard'
    });
    expect(context?.latestSpec).toContain('`docs/ai/reusability.md`');
    for (const path of requiredDocs(await config())) expect(context?.latestSpec).toContain(path);
  });

  test('no other build is dispatched until the onboarding task is done', async () => {
    await openOnboarding();
    const onboardingId = (
      await pool.query<{ id: string }>("select id from tasks where kind = 'onboarding'")
    ).rows[0]!.id;
    const requestId = await readyRequest();

    const held = await collectDueSteps({ pool }, seeded.projectId);
    expect(held.dispatched).toEqual([]);
    expect(held.due).toEqual([{ taskId: onboardingId, role: 'chooser' }]);
    expect((await loadTask(pool, requestId))?.task.stage).toBe('ready');

    await applyOrThrow(
      pool,
      onboardingId,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      { kind: 'engine' }
    );
    await applyOrThrow(pool, onboardingId, { type: 'approve' }, seeded.owner);
    const started = await collectDueSteps({ pool }, seeded.projectId);
    expect(started.dispatched).toEqual([onboardingId]);
    expect(started.due).toEqual([{ taskId: onboardingId, role: 'onboarder' }]);
    expect((await loadTask(pool, onboardingId))?.task.assignee).toEqual({
      kind: 'agent',
      role: 'onboarder'
    });

    await pool.query("update tasks set stage = 'done' where id = $1", [onboardingId]);
    const released = await collectDueSteps({ pool }, seeded.projectId);
    expect(released.dispatched).toEqual([requestId]);
  });

  test('the onboarder pushes the docs and the pull request lists its follow-ups', async () => {
    await openOnboarding();
    const onboardingId = (
      await pool.query<{ id: string }>("select id from tasks where kind = 'onboarding'")
    ).rows[0]!.id;
    await applyOrThrow(
      pool,
      onboardingId,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      { kind: 'engine' }
    );
    await applyOrThrow(pool, onboardingId, { type: 'approve' }, seeded.owner);
    await collectDueSteps({ pool }, seeded.projectId);

    const github = fakeGitHub(DOCS);
    const agents = createFakePort(() => [
      toolUse(ONBOARDED),
      idle('requires_action'),
      idle('end_turn')
    ]);
    const result = await runAgentStep(
      { pool, github: github.port, agents, publicUrl: PUBLIC_URL },
      onboardingId,
      'onboarder'
    );
    expect(result).toEqual({ status: 'applied' });
    expect((await loadTask(pool, onboardingId))?.task.stage).toBe('reviewing');
    expect(github.opened[0]?.title).toBe('docs(ai): add the agent docs');
    expect(github.opened[0]?.body).toContain('duplicate the date helpers');
    expect(JSON.stringify(agents.sent[0]?.events)).toContain(
      '## Agent docs this project must hold'
    );
  });

  test('an onboarder that changes code is stopped', async () => {
    await openOnboarding();
    const onboardingId = (
      await pool.query<{ id: string }>("select id from tasks where kind = 'onboarding'")
    ).rows[0]!.id;
    await applyOrThrow(
      pool,
      onboardingId,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      { kind: 'engine' }
    );
    await applyOrThrow(pool, onboardingId, { type: 'approve' }, seeded.owner);
    await collectDueSteps({ pool }, seeded.projectId);

    const github = fakeGitHub([...DOCS, 'src/lib/format.ts']);
    const agents = createFakePort(() => [
      toolUse(ONBOARDED),
      idle('requires_action'),
      idle('end_turn')
    ]);
    await runAgentStep(
      { pool, github: github.port, agents, publicUrl: PUBLIC_URL },
      onboardingId,
      'onboarder'
    );
    const task = (await loadTask(pool, onboardingId))?.task;
    expect(task).toMatchObject({ stage: 'ready', assignee: null });
    expect(task?.blocked?.question).toContain('src/lib/format.ts');
    expect(github.opened).toEqual([]);
  });
});
