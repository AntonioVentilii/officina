import { describe, expect, test } from 'bun:test';
import type { StoredTaskContext } from '@officina/db';
import { PINNED_MODELS, PROMPTS_DIR, trialBuilders } from '@officina/runner';
import { loadConfig, newTask } from '../../core/test/fixtures';
import { createFakePort, idle, toolUse } from '../../runner/test/fake-port';
import { firstBuildChoice, planTrialBuild, runTrialBuild, TrialError } from '../src';
import { gitHubWith } from './fake-github';

const BASE = '1febbe1b1c1435302abfb8035b985ec901e65be3';
const BRANCH = 'officina/trial-task-9-solo-1';

const context: StoredTaskContext = {
  task: { ...newTask('task-9', 'antonio'), stage: 'cancelled', specVersion: 1 },
  version: 12,
  number: 9,
  title: 'Pause and resume a task from Claude',
  projectId: 'project-1',
  repo: 'AntonioVentilii/officina',
  installationId: 42,
  defaultBranch: 'main',
  environmentId: 'env_1',
  rawConfig: {},
  pullRequest: 301,
  issue: null,
  latestSpec: '# Pause and resume\n\nAdd pause_task and resume_task.'
};

const pushed = {
  outcome: 'pushed',
  branch: BRANCH,
  prTitle: 'feat(api): pause and resume a task from Claude',
  verified: ['bun run test'],
  notVerified: []
};

const firstBuild = firstBuildChoice(context, loadConfig(), []);

const trial = async (overrides: { attempt?: number; base?: string } = {}) => ({
  context,
  config: loadConfig(),
  arm: 'solo' as const,
  definition: (await trialBuilders(PROMPTS_DIR, PINNED_MODELS)).solo,
  model: {
    id: PINNED_MODELS[firstBuild.tier],
    effort: firstBuild.effort,
    reason: firstBuild.reason
  },
  base: BASE,
  attempt: 1,
  budgetCents: 200,
  ...overrides
});

const github = (branchesAfter: Record<string, string>) => {
  const revoked: string[] = [];
  const snapshots = [
    { branches: { main: 'aaa' }, tags: {} },
    { branches: branchesAfter, tags: {} }
  ];
  return {
    revoked,
    port: gitHubWith({
      refSnapshot: async () => snapshots.shift()!,
      runToken: async () => 'ghs_run',
      revokeToken: async (token) => {
        revoked.push(token);
      }
    })
  };
};

describe('a trial build', () => {
  test('its plan briefs a first round on its own branch from the base commit, and writes nothing', async () => {
    const plan = await planTrialBuild(gitHubWith({}), await trial());

    expect(plan).toMatchObject({
      task: 9,
      arm: 'solo',
      branch: BRANCH,
      base: BASE,
      budgetCents: 200
    });
    expect(plan.agentName).toBe('officina-trial-builder-solo');
    expect(plan.readerName).toBeNull();
    expect(plan.brief).toContain(`task branch \`${BRANCH}\``);
    expect(plan.brief).toContain('First round');
    expect(plan.brief).toContain('Add pause_task and resume_task.');
    expect(plan.brief).toContain(`at commit \`${BASE}\``);
  });

  test('runs on the base commit with a token it revokes, and reports the cost, the measure and nothing else moved', async () => {
    const agents = createFakePort(() => [toolUse(pushed), idle('end_turn')]);
    const { port, revoked } = github({ main: 'aaa', [BRANCH]: 'bbb' });

    const report = await runTrialBuild({ github: port, agents }, await trial());

    expect(agents.sessions[0]!.repository).toEqual({
      url: 'https://github.com/AntonioVentilii/officina',
      token: 'ghs_run',
      branch: 'main',
      commit: BASE
    });
    // Both arms run at the model a first build of the task gets today.
    expect(agents.sessions[0]!.model).toEqual({
      id: PINNED_MODELS[firstBuild.tier],
      effort: firstBuild.effort
    });
    expect(agents.agentWrites.map(({ agent }) => agent.name)).toEqual([
      'officina-trial-builder-solo'
    ]);
    expect(revoked).toEqual(['ghs_run']);
    expect(report.outcome).toMatchObject({ kind: 'result', output: { outcome: 'pushed' } });
    expect(report.usage.costCents).toBe(12);
    expect(report.measure.threads).toHaveLength(1);
    expect(report.measure.delegations).toBe(0);
    expect(report.otherRefsMoved).toEqual([]);
    expect(report.tokenRevoked).toBe(true);
    expect(report.problems).toEqual([]);
  });

  test('says which other refs moved while it ran', async () => {
    const agents = createFakePort(() => [toolUse(pushed), idle('end_turn')]);
    const { port } = github({ main: 'ccc', [BRANCH]: 'bbb', 'officina/task-3': 'ddd' });

    const report = await runTrialBuild({ github: port, agents }, await trial());

    expect(report.otherRefsMoved).toEqual(['main', 'officina/task-3']);
    expect(report.problems).toEqual([
      'main moved while the trial ran: check who moved it',
      'officina/task-3 moved while the trial ran: check who moved it'
    ]);
  });

  test('names a run token GitHub would not take back among its problems', async () => {
    const agents = createFakePort(() => [toolUse(pushed), idle('end_turn')]);
    const snapshots = [
      { branches: { main: 'aaa' }, tags: {} },
      { branches: { main: 'aaa', [BRANCH]: 'bbb' }, tags: {} }
    ];
    const port = gitHubWith({
      refSnapshot: async () => snapshots.shift()!,
      runToken: async () => 'ghs_run',
      revokeToken: async () => {
        throw new Error('GitHub is down');
      }
    });

    const report = await runTrialBuild({ github: port, agents }, await trial());

    expect(report.tokenRevoked).toBe(false);
    expect(report.problems).toEqual([
      'GitHub did not take the run token back: revoke it, or wait the hour it lasts'
    ]);
  });

  test('refuses a branch an earlier attempt already pushed, before writing or spending anything', async () => {
    const agents = createFakePort(() => []);
    const port = gitHubWith({
      refSnapshot: async () => ({ branches: { main: 'aaa', [BRANCH]: 'bbb' }, tags: {} })
    });

    await expect(runTrialBuild({ github: port, agents }, await trial())).rejects.toThrow(
      TrialError
    );
    expect(agents.agentWrites).toEqual([]);
    expect(agents.sessions).toEqual([]);
  });

  test('refuses a base that is not a full commit sha', async () => {
    await expect(planTrialBuild(gitHubWith({}), await trial({ base: '1febbe1' }))).rejects.toThrow(
      'full commit sha'
    );
  });
});
