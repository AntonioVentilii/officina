import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadAgentVersions, migrate } from '@officina/db';
import { Pool } from 'pg';
import { CONFIG_YAML } from '../../../packages/core/test/fixtures';
import { RUNNER_ROLES } from '@officina/runner';
import { createFakePort } from '../../../packages/runner/test/fake-port';
import { SetupError, addProject, environmentNameFor, setupAgents, type SetupGitHub } from '../src';

const url = process.env.TEST_DATABASE_URL;

/** Serves the config at its path and every other file unless it is listed as missing. */
const fakeGitHub = (config: string | null, missing: readonly string[] = []): SetupGitHub => ({
  repoInstallationId: async () => 99,
  defaultBranch: async () => 'main',
  fileContent: async ({ path }) =>
    path === '.github/officina.yml' ? config : missing.includes(path) ? null : '# page'
});

const input = {
  workspace: 'vici',
  repo: 'ViciApp/vici-app',
  owner: { email: 'antonio@example.com', name: 'Antonio' }
};

describe.skipIf(!url)('setup', () => {
  const pool = new Pool({ connectionString: url });

  beforeEach(async () => {
    await pool.query('drop schema public cascade; create schema public;');
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  test('registers a project with its owner, config and agent environment, idempotently', async () => {
    const agents = createFakePort(() => []);
    const yaml = `${CONFIG_YAML}\nruntime:\n  allowed_hosts: ['registry.example.com']\n`;
    const first = await addProject(pool, { github: fakeGitHub(yaml), agents }, input);
    expect(first).toMatchObject({
      installationId: 99,
      environmentId: 'env_1',
      missingDocs: [],
      onboardingTask: null
    });

    const project = await pool.query(
      `select github_repo, github_installation_id::int as installation, default_branch, agent_environment_id,
              config->'docs'->>'entry' as entry
       from projects`
    );
    expect(project.rows).toEqual([
      {
        github_repo: 'ViciApp/vici-app',
        installation: 99,
        default_branch: 'main',
        agent_environment_id: 'env_1',
        entry: 'AGENTS.md'
      }
    ]);
    const role = await pool.query('select role from project_roles where member_id = $1', [
      first.ownerId
    ]);
    expect(role.rows).toEqual([{ role: 'owner' }]);
    expect(agents.environments.get(environmentNameFor(input.repo))?.allowedHosts).toEqual([
      'registry.example.com'
    ]);

    const second = await addProject(pool, { github: fakeGitHub(yaml), agents }, input);
    expect(second).toEqual(first);
    expect((await pool.query('select 1 from projects')).rowCount).toBe(1);
    expect((await pool.query('select 1 from members')).rowCount).toBe(1);
  });

  test('reports the required agent docs the repository does not hold yet', async () => {
    const agents = createFakePort(() => []);
    const missing = ['AGENTS.md', 'docs/ai/reusability.md', 'docs/ai/testing.md'];
    const result = await addProject(
      pool,
      { github: fakeGitHub(CONFIG_YAML, [...missing, 'docs/ai/unrelated.md']), agents },
      input
    );
    expect(result.missingDocs).toEqual(missing);
    expect(result.onboardingTask).toBe(1);
    const tasks = await pool.query('select kind, stage from tasks');
    expect(tasks.rows).toEqual([{ kind: 'onboarding', stage: 'spec_review' }]);

    const again = await addProject(
      pool,
      { github: fakeGitHub(CONFIG_YAML, missing), agents },
      input
    );
    expect(again.onboardingTask).toBe(1);
    expect((await pool.query('select 1 from tasks')).rowCount).toBe(1);
  });

  test('a missing or invalid config writes nothing', async () => {
    const agents = createFakePort(() => []);
    await expect(addProject(pool, { github: fakeGitHub(null), agents }, input)).rejects.toThrow(
      'has no .github/officina.yml'
    );
    await expect(
      addProject(pool, { github: fakeGitHub('version: 2'), agents }, input)
    ).rejects.toBeInstanceOf(SetupError);
    expect((await pool.query('select 1 from projects')).rowCount).toBe(0);
    expect(agents.environments.size).toBe(0);
  });

  test('an explicit config text is used instead of the repository file', async () => {
    const agents = createFakePort(() => []);
    const result = await addProject(
      pool,
      { github: fakeGitHub(null), agents },
      { ...input, configYaml: CONFIG_YAML }
    );
    expect(result.projectId).toBeString();
  });

  test('agent setup syncs every role once and then reports no changes', async () => {
    const agents = createFakePort(() => []);
    const promptsDir = join(import.meta.dir, '..', '..', '..', 'agents');
    expect((await setupAgents(pool, agents, promptsDir, 'claude-opus-5-5')).changed).toHaveLength(
      RUNNER_ROLES.length
    );
    expect(await loadAgentVersions(pool)).toHaveLength(RUNNER_ROLES.length);
    expect((await setupAgents(pool, agents, promptsDir, 'claude-opus-5-5')).changed).toEqual([]);
  });
});
