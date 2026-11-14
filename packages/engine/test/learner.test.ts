import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  failIdleLearningRewrite,
  failOrphanedRuns,
  insertLearnings,
  listLearnings,
  requestLearningRewrite,
  saveAgentVersion,
  startLearningRewriteRun
} from '@officina/db';
import { RUNNER_ROLES } from '@officina/runner';
import { Pool } from 'pg';
import { applyOrThrow, createTaskInMerging, resetAndSeed, type Seeded } from '../../db/test/seed';
import { createFakePort, idle, toolUse } from '../../runner/test/fake-port';
import { parseProjectConfig } from '@officina/core';
import { collectDueSteps, learningProblems, runAgentStep, type GitHubPort } from '../src';

const url = process.env.TEST_DATABASE_URL;

const DOCS = '# Agents\n\n## Copy\n\nKeep copy short.\n';

const fakeGitHub = () =>
  ({
    installationToken: async () => 'token-read',
    readFile: async ({ path }: { path: string }) =>
      path === 'AGENTS.md' ? { text: DOCS, sha: 'blob1' } : null
  }) as unknown as GitHubPort;

const learning = (overrides: Record<string, unknown>) => ({
  title: 'Say where locale files live',
  lesson: 'Copy changes must cover every live locale.',
  evidence: 'The reviewer sent the build back because Italian was missing.',
  target: 'docs',
  edit: { file: 'AGENTS.md', find: '## Copy\n', text: '## Copy\n\nUpdate every live locale.\n' },
  ...overrides
});

describe.skipIf(!url)('learner', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;
  let promptsDir: string;

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
    promptsDir = await mkdtemp(join(tmpdir(), 'prompts-'));
    await writeFile(join(promptsDir, 'builder.md'), 'You are the builder.\n');
  });

  afterAll(async () => {
    await pool.end();
  });

  test('a tool layer such as CLAUDE.md takes no learning under any target', async () => {
    const parsed = parseProjectConfig({ version: 1, docs: { entry: 'AGENTS.md' } });
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const problems = learningProblems({
      deps: { pool, github: fakeGitHub(), agents: createFakePort(() => []), publicUrl: 'x' },
      repoRef: { installationId: 99, repo: 'ViciApp/vici-app' },
      branch: 'main',
      config: parsed.config
    });
    // A pointer to the entry document holds no rule: neither target may write to it.
    expect(
      await problems({
        learnings: [
          learning({ edit: { file: 'CLAUDE.md', text: 'x' } }),
          learning({ target: 'project', edit: { file: 'CLAUDE.md', text: 'x' } }),
          learning({ edit: { file: 'docs/ai/workflows/new.md', text: 'x' } })
        ]
      } as never)
    ).toEqual([
      'learnings.0: docs edits go to AGENTS.md or a page under docs/ai/, not CLAUDE.md, a pointer to the entry document',
      'learnings.1: CLAUDE.md is part of the agent docs; it is a pointer to the entry document and takes no rule'
    ]);
  });

  const doneTask = async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    await applyOrThrow(pool, taskId, { type: 'merged' }, { kind: 'engine' });
    return taskId;
  };

  test('a done task is looked back at once, and only edits that apply exactly are kept', async () => {
    const taskId = await doneTask();
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([
      { taskId, role: 'learner' }
    ]);

    const agents = createFakePort(() => [
      toolUse({
        learnings: [
          learning({ target: 'project', edit: { file: '.github/README.md', text: 'x' } }),
          learning({ edit: { file: 'AGENTS.md', find: 'o', text: 'x' } }),
          learning({ target: 'agent', edit: { file: 'agents/wizard.md', text: 'x' } })
        ]
      }),
      idle('requires_action'),
      toolUse({
        learnings: [
          learning({ target: 'project', edit: { file: 'docs/ai/patterns.md', text: 'x' } }),
          learning({ edit: { file: 'docs/product.md', text: 'x' } })
        ]
      }),
      idle('requires_action'),
      toolUse({
        learnings: [
          learning({}),
          learning({
            title: 'Builders read the locale list',
            target: 'agent',
            edit: {
              file: 'agents/builder.md',
              find: 'You are the builder.',
              text: 'You are the builder. Check every locale.'
            }
          })
        ]
      }),
      idle('requires_action'),
      idle('end_turn')
    ]);
    const deps = { pool, github: fakeGitHub(), agents, publicUrl: 'https://o.example', promptsDir };

    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({ status: 'applied' });
    const feedback = JSON.stringify(agents.sent);
    expect(feedback).toContain('is a protected path');
    expect(feedback).toContain('must appear exactly once in AGENTS.md');
    expect(feedback).toContain('agents/<role>.md for a known role');
    expect(feedback).toContain('docs/ai/patterns.md is part of the agent docs; use target docs');
    expect(feedback).toContain('not docs/product.md; use target project');

    const brief = (agents.sent[0]!.events[0] as { text: string }).text;
    expect(brief).toContain('role: learner');
    expect(brief).toContain('## Timeline');
    expect(brief).toContain('review approve by reviewer_spec');
    expect(brief).toContain("- `docs`: the project's agent docs");
    expect(brief).toContain('  - `docs/ai/reusability.md`');
    expect(brief).toContain('## Security rules');
    expect(brief).toEndWith('When you are done, call `submit_result` once.');
    expect(agents.sessions[0]!.repository).toMatchObject({ token: 'token-read', branch: 'main' });

    const learnings = await listLearnings(pool, seeded.projectId);
    expect(learnings.map((item) => [item.target, item.file, item.status])).toEqual(
      expect.arrayContaining([
        ['docs', 'AGENTS.md', 'proposed'],
        ['agent', 'agents/builder.md', 'proposed']
      ])
    );
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([]);
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({
      status: 'skipped',
      reason: 'not_due'
    });
  });

  /** A learning proposed earlier whose text to replace the default branch no longer holds. */
  const staleLearning = async () => {
    const taskId = await doneTask();
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
        learning({
          edit: { file: 'AGENTS.md', find: '## Copy, short\n', text: '## Copy, short\n\nx\n' }
        }) as never
      ]
    });
    const [stale] = await listLearnings(pool, seeded.projectId);
    await requestLearningRewrite(pool, stale!.id);
    return { taskId, id: stale!.id };
  };

  test('an edit the default branch moved past is rewritten against the file as it is now', async () => {
    const { taskId, id } = await staleLearning();
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([
      { taskId, role: 'learner' }
    ]);

    const agents = createFakePort(() => [
      toolUse({ learnings: [learning({}), learning({ title: 'Another one' })] }),
      idle('requires_action'),
      toolUse({
        learnings: [
          learning({ target: 'project', edit: { file: 'docs/ai/patterns.md', text: 'x' } })
        ]
      }),
      idle('requires_action'),
      toolUse({ learnings: [learning({})] }),
      idle('requires_action'),
      idle('end_turn')
    ]);
    const deps = { pool, github: fakeGitHub(), agents, publicUrl: 'https://o.example' };
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({ status: 'applied' });

    const brief = (agents.sent[0]!.events[0] as { text: string }).text;
    expect(brief).toContain('role: learner, rewriting one edit');
    expect(brief).toContain('## Copy, short');
    expect(brief).toContain('## Security rules');
    expect(brief).toEndWith('When you are done, call `submit_result` once.');
    const feedback = JSON.stringify(agents.sent);
    expect(feedback).toContain('return this one learning rewritten, or none');
    expect(feedback).toContain('keep the target docs');
    expect(feedback).toContain('keep the file AGENTS.md');

    const [rewritten] = await listLearnings(pool, seeded.projectId);
    expect(rewritten).toMatchObject({
      id,
      status: 'proposed',
      rewrite: null,
      find: '## Copy\n',
      text: '## Copy\n\nUpdate every live locale.'
    });
    expect(rewritten!.rewrittenAt).toBeInstanceOf(Date);
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([]);
  });

  test('a rewrite that finds nothing to change leaves the learning for people to reject', async () => {
    const { taskId } = await staleLearning();
    const agents = createFakePort(() => [
      toolUse({ learnings: [] }),
      idle('requires_action'),
      idle('end_turn')
    ]);
    const deps = { pool, github: fakeGitHub(), agents, publicUrl: 'x' };
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({ status: 'applied' });
    expect((await listLearnings(pool, seeded.projectId))[0]).toMatchObject({
      rewrite: 'failed',
      find: '## Copy, short\n'
    });
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({
      status: 'skipped',
      reason: 'not_due'
    });
  });

  test('a rewrite the project cannot run fails instead of waiting on every pass', async () => {
    const { taskId } = await staleLearning();
    await pool.query('update projects set agent_environment_id = null where id = $1', [
      seeded.projectId
    ]);
    const agents = createFakePort(() => []);
    const deps = { pool, github: fakeGitHub(), agents, publicUrl: 'x' };
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({
      status: 'skipped',
      reason: 'no_environment'
    });
    expect((await listLearnings(pool, seeded.projectId))[0]).toMatchObject({ rewrite: 'failed' });
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([]);
    expect(agents.sessions).toHaveLength(0);
  });

  const learnerRunStatus = async (taskId: string) =>
    (
      await pool.query<{ status: string }>(
        'select status from runs where task_id = $1 and learning_id is not null',
        [taskId]
      )
    ).rows.map((row) => row.status);

  test('a rewrite run that ends without a result fails, and the learning stops waiting on it', async () => {
    const { taskId } = await staleLearning();
    const agents = createFakePort(() => [idle('end_turn')]);
    const deps = { pool, github: fakeGitHub(), agents, publicUrl: 'x' };
    expect(await runAgentStep(deps, taskId, 'learner')).toMatchObject({ status: 'discarded' });
    expect(await learnerRunStatus(taskId)).toEqual(['failed']);
    expect((await listLearnings(pool, seeded.projectId))[0]).toMatchObject({ rewrite: 'failed' });
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([]);
  });

  test('a rewrite run that throws fails, and the learning stops waiting on it', async () => {
    const { taskId } = await staleLearning();
    const agents = createFakePort(() => [
      async () => {
        throw new Error('the stream broke');
      }
    ]);
    const deps = { pool, github: fakeGitHub(), agents, publicUrl: 'x' };
    await expect(runAgentStep(deps, taskId, 'learner')).rejects.toThrow('the stream broke');
    expect(await learnerRunStatus(taskId)).toEqual(['failed']);
    expect((await listLearnings(pool, seeded.projectId))[0]).toMatchObject({ rewrite: 'failed' });
    expect((await collectDueSteps({ pool }, seeded.projectId)).due).toEqual([]);
  });

  /** Waits until `ready` holds, as a step running in the background gets there. */
  const until = async (ready: () => boolean | Promise<boolean>) => {
    for (let wait = 0; !(await ready()); wait++) {
      if (wait > 200) throw new Error('the step never got there');
      await Bun.sleep(10);
    }
  };
  /** Never resolves, as a step whose engine restarted at that point would look from the database. */
  const forever = () => new Promise<never>(() => {});
  const learnerRunsActive = async (taskId: string) =>
    (
      await pool.query(
        "select 1 from runs where task_id = $1 and agent_role = 'learner' and status = 'running'",
        [taskId]
      )
    ).rowCount === 1;
  const rewriteState = async () => (await listLearnings(pool, seeded.projectId))[0]!.rewrite;

  test('a rewrite whose run the engine lost is tried once more, then fails', async () => {
    const { taskId } = await staleLearning();
    const agents = createFakePort(() => [forever]);
    const deps = { pool, github: fakeGitHub(), agents, publicUrl: 'x' };
    const loseARun = async (sessions: number) => {
      void runAgentStep(deps, taskId, 'learner');
      await until(() => agents.sessions.length === sessions);
      expect(await failOrphanedRuns(pool)).toHaveLength(1);
    };

    await loseARun(1);
    expect((await listLearnings(pool, seeded.projectId))[0]).toMatchObject({
      rewrite: 'requested'
    });
    await loseARun(2);
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({
      status: 'skipped',
      reason: 'not_due'
    });
    expect((await listLearnings(pool, seeded.projectId))[0]).toMatchObject({ rewrite: 'failed' });
    expect(agents.sessions).toHaveLength(2);
  });

  test('a rewrite run lost right after its claim still counts', async () => {
    const { taskId } = await staleLearning();
    // The engine dies before the session exists: the token it asks for never comes.
    const github = { ...fakeGitHub(), installationToken: forever } as unknown as GitHubPort;
    const agents = createFakePort(() => []);
    const deps = { pool, github, agents, publicUrl: 'x' };
    for (const _ of [1, 2]) {
      void runAgentStep(deps, taskId, 'learner');
      await until(() => learnerRunsActive(taskId));
      expect(await failOrphanedRuns(pool)).toHaveLength(1);
    }
    expect(await rewriteState()).toBe('requested');
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({
      status: 'skipped',
      reason: 'not_due'
    });
    expect(await rewriteState()).toBe('failed');
    expect(agents.sessions).toHaveLength(0);
  });

  test('a pass the project cannot run leaves a rewrite whose run is in progress to that run', async () => {
    const { taskId } = await staleLearning();
    const agents = createFakePort(() => [forever]);
    const deps = { pool, github: fakeGitHub(), agents, publicUrl: 'x' };
    void runAgentStep(deps, taskId, 'learner');
    await until(() => agents.sessions.length === 1);
    await pool.query('update projects set agent_environment_id = null where id = $1', [
      seeded.projectId
    ]);
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({
      status: 'skipped',
      reason: 'no_environment'
    });
    expect(await rewriteState()).toBe('requested');
  });

  describe('claiming and failing a rewrite at the same time', () => {
    const NEW_RUN = { stage: 'done', role: 'learner', agentVersion: 1, runner: 'managed_agents' };

    /** Holds the learning's lock in a transaction of its own, as the other side would. */
    const holdingTheLearning = async (id: string) => {
      const other = await pool.connect();
      await other.query('begin');
      await other.query('select 1 from learnings where id = $1 for update', [id]);
      return {
        query: (sql: string, values: unknown[]) => other.query(sql, values),
        commit: async () => {
          await other.query('commit');
          other.release();
        }
      };
    };

    test('a pass that read the rewrite before another failed it does not claim it', async () => {
      const { taskId, id } = await staleLearning();
      const failing = await holdingTheLearning(id);
      const claim = startLearningRewriteRun(pool, { ...NEW_RUN, taskId }, id, 2);
      await Bun.sleep(50);
      await failing.query("update learnings set rewrite = 'failed' where id = $1", [id]);
      await failing.commit();

      expect(await claim).toEqual({ ok: false, error: 'settled' });
      expect(await learnerRunsActive(taskId)).toBe(false);
    });

    test('a failure that waited on a claim leaves the rewrite to the run claimed', async () => {
      const { taskId, id } = await staleLearning();
      const claiming = await holdingTheLearning(id);
      const failure = failIdleLearningRewrite(pool, id);
      await Bun.sleep(50);
      await claiming.query(
        `insert into runs (task_id, stage, runner, agent_role, agent_version, status, learning_id)
         values ($1, 'done', 'managed_agents', 'learner', 1, 'running', $2)`,
        [taskId, id]
      );
      await claiming.commit();

      expect(await failure).toBe(false);
      expect(await rewriteState()).toBe('requested');
    });
  });

  test('a task that is not done is never looked back at', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const deps = { pool, github: fakeGitHub(), agents: createFakePort(() => []), publicUrl: 'x' };
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({
      status: 'skipped',
      reason: 'not_due'
    });
  });
});
