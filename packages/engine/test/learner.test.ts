import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLearnings, saveAgentVersion } from '@officina/db';
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

  test('a task that is not done is never looked back at', async () => {
    const taskId = await createTaskInMerging(pool, seeded);
    const deps = { pool, github: fakeGitHub(), agents: createFakePort(() => []), publicUrl: 'x' };
    expect(await runAgentStep(deps, taskId, 'learner')).toEqual({
      status: 'skipped',
      reason: 'not_due'
    });
  });
});
