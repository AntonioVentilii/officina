import { parseProjectConfigYaml, requiredDocs, type Role } from '@officina/core';
import {
  loadAgentVersions,
  saveAgentVersion,
  setProjectEnvironment,
  setProjectRole,
  upsertMember,
  upsertProject,
  upsertWorkspace
} from '@officina/db';
import type { GitHubClient } from '@officina/github';
import {
  ensureEnvironment,
  loadDefinitions,
  syncAgents,
  type ManagedAgentsPort
} from '@officina/runner';
import type { Pool } from 'pg';
import { CONFIG_PATH } from './webhooks';

export type SetupGitHub = Pick<
  GitHubClient,
  'repoInstallationId' | 'defaultBranch' | 'fileContent'
>;

/**
 * Syncs every role agent from its checked-in prompt on the given model and records the versions the
 * engine will use. Unchanged definitions are left alone, so running it on every boot is cheap.
 */
export const setupAgents = async (
  pool: Pool,
  agents: ManagedAgentsPort,
  promptsDir: string,
  modelId: string
): Promise<{ changed: string[] }> => {
  const definitions = await loadDefinitions(promptsDir, modelId);
  const { agents: synced, changed } = await syncAgents(
    agents,
    definitions,
    await loadAgentVersions(pool)
  );
  for (const record of synced) await saveAgentVersion(pool, record);
  return { changed };
};

export class SetupError extends Error {}

export const environmentNameFor = (repo: string): string =>
  `officina-${repo.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

export interface AddProjectInput {
  readonly workspace: string;
  readonly repo: string;
  readonly owner: { readonly email: string; readonly name: string };
  /** Config text to use instead of the repository's `.github/officina.yml`, e.g. before it is merged. */
  readonly configYaml?: string;
}

/**
 * Registers a repository as a project: finds the app installation and default branch, validates the
 * project config, records workspace, owner and project, and prepares the project's agent environment.
 * Nothing is written when the config is missing or invalid. It also reports which of the agent docs
 * the config requires are not on the default branch yet.
 */
export const addProject = async (
  pool: Pool,
  deps: { github: SetupGitHub; agents: ManagedAgentsPort },
  input: AddProjectInput
): Promise<{
  projectId: string;
  ownerId: string;
  environmentId: string;
  installationId: number;
  /** Required agent docs (the entry document, `docs/ai` pages, catalog pages) the repository lacks. */
  missingDocs: string[];
}> => {
  const installationId = await deps.github.repoInstallationId(input.repo);
  const ref = { installationId, repo: input.repo };
  const defaultBranch = await deps.github.defaultBranch(ref);
  const configYaml =
    input.configYaml ??
    (await deps.github.fileContent({ ...ref, path: CONFIG_PATH, branch: defaultBranch }));
  if (configYaml === null) {
    throw new SetupError(`${input.repo} has no ${CONFIG_PATH} on ${defaultBranch}`);
  }
  const parsed = parseProjectConfigYaml(configYaml);
  if (!parsed.ok) throw new SetupError(`invalid project config:\n${parsed.errors.join('\n')}`);

  const missingDocs: string[] = [];
  for (const path of requiredDocs(parsed.config)) {
    if ((await deps.github.fileContent({ ...ref, path, branch: defaultBranch })) === null) {
      missingDocs.push(path);
    }
  }

  const environment = await ensureEnvironment(deps.agents, {
    name: environmentNameFor(input.repo),
    allowedHosts: parsed.config.runtime.allowedHosts
  });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const workspaceId = await upsertWorkspace(client, input.workspace);
    const ownerId = await upsertMember(client, {
      workspaceId,
      email: input.owner.email,
      displayName: input.owner.name
    });
    const projectId = await upsertProject(client, {
      workspaceId,
      name: input.repo.split('/')[1]!,
      repo: input.repo,
      installationId,
      defaultBranch,
      config: Bun.YAML.parse(configYaml)
    });
    const role: Role = 'owner';
    await setProjectRole(client, { projectId, memberId: ownerId, role });
    await setProjectEnvironment(client, projectId, environment.id);
    await client.query('commit');
    return { projectId, ownerId, environmentId: environment.id, installationId, missingDocs };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};
