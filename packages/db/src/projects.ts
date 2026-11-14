import type { Role } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { RUN_IS_ACTIVE } from './run-status';

type Queryable = Pool | PoolClient;

export const upsertWorkspace = async (db: Queryable, name: string): Promise<string> => {
  const existing = await db.query<{ id: string }>('select id from workspaces where name = $1', [
    name
  ]);
  if (existing.rows[0]) return existing.rows[0].id;
  return (
    await db.query<{ id: string }>('insert into workspaces (name) values ($1) returning id', [name])
  ).rows[0]!.id;
};

export const upsertMember = async (
  db: Queryable,
  input: { workspaceId: string; email: string; displayName: string }
): Promise<string> => {
  const existing = await db.query<{ id: string }>(
    'select id from members where workspace_id = $1 and lower(email) = lower($2)',
    [input.workspaceId, input.email]
  );
  if (existing.rows[0]) return existing.rows[0].id;
  return (
    await db.query<{ id: string }>(
      'insert into members (workspace_id, email, display_name) values ($1, $2, $3) returning id',
      [input.workspaceId, input.email, input.displayName]
    )
  ).rows[0]!.id;
};

export const upsertProject = async (
  db: Queryable,
  input: {
    workspaceId: string;
    name: string;
    repo: string;
    installationId: number;
    defaultBranch: string;
    config: unknown;
  }
): Promise<string> =>
  (
    await db.query<{ id: string }>(
      `insert into projects (workspace_id, name, github_repo, github_installation_id, default_branch, config)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (workspace_id, github_repo) do update set
         name = excluded.name,
         github_installation_id = excluded.github_installation_id,
         default_branch = excluded.default_branch,
         config = excluded.config
       returning id`,
      [
        input.workspaceId,
        input.name,
        input.repo,
        input.installationId,
        input.defaultBranch,
        JSON.stringify(input.config)
      ]
    )
  ).rows[0]!.id;

export const setProjectRole = async (
  db: Queryable,
  input: { projectId: string; memberId: string; role: Role; domains?: readonly string[] }
) => {
  await db.query(
    `insert into project_roles (project_id, member_id, role, domains) values ($1, $2, $3, $4)
     on conflict (project_id, member_id) do update set role = excluded.role, domains = excluded.domains`,
    [input.projectId, input.memberId, input.role, input.domains ?? []]
  );
};

export const setProjectEnvironment = async (
  db: Queryable,
  projectId: string,
  environmentId: string
) => {
  await db.query('update projects set agent_environment_id = $2 where id = $1', [
    projectId,
    environmentId
  ]);
};

export interface ProjectRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly repo: string;
  readonly installationId: number | null;
  readonly defaultBranch: string;
  readonly environmentId: string | null;
}

const PROJECT_COLUMNS = `id, workspace_id, github_repo, github_installation_id, default_branch,
  agent_environment_id`;

interface ProjectRow {
  id: string;
  workspace_id: string;
  github_repo: string;
  github_installation_id: string | null;
  default_branch: string;
  agent_environment_id: string | null;
}

const toProjectRecord = (row: ProjectRow): ProjectRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  repo: row.github_repo,
  installationId: row.github_installation_id === null ? null : Number(row.github_installation_id),
  defaultBranch: row.default_branch,
  environmentId: row.agent_environment_id
});

export const findProjectsByRepo = async (db: Queryable, repo: string): Promise<ProjectRecord[]> =>
  (
    await db.query<ProjectRow>(
      `select ${PROJECT_COLUMNS} from projects where lower(github_repo) = lower($1)`,
      [repo]
    )
  ).rows.map(toProjectRecord);

export const loadProject = async (
  db: Queryable,
  projectId: string
): Promise<ProjectRecord | null> => {
  const row = (
    await db.query<ProjectRow>(`select ${PROJECT_COLUMNS} from projects where id = $1`, [projectId])
  ).rows[0];
  return row ? toProjectRecord(row) : null;
};

/** The project's stored config, raw: parse it with `parseProjectConfig`. */
export const loadProjectConfig = async (db: Queryable, projectId: string): Promise<unknown> =>
  (await db.query<{ config: unknown }>('select config from projects where id = $1', [projectId]))
    .rows[0]?.config;

/**
 * The project's config, read under the project's row lock inside the caller's transaction, so
 * everything decided from it holds until the transaction ends.
 */
export const lockProjectConfig = async (client: PoolClient, projectId: string): Promise<unknown> =>
  (
    await client.query<{ config: unknown }>(
      'select config from projects where id = $1 for update',
      [projectId]
    )
  ).rows[0]?.config;

export const updateProjectConfig = async (db: Queryable, projectId: string, config: unknown) => {
  await db.query('update projects set config = $2 where id = $1', [
    projectId,
    JSON.stringify(config)
  ]);
};

/** Projects the scheduler can work on: installed on GitHub and with an agent environment. */
export const listSchedulableProjectIds = async (db: Queryable): Promise<string[]> =>
  (
    await db.query<{ id: string }>(
      `select id from projects
       where github_installation_id is not null and agent_environment_id is not null
       order by created_at`
    )
  ).rows.map((row) => row.id);

/**
 * Runs left `running` by a previous engine process can never finish: their stream is gone. They are
 * failed so the step can run again; a result the run already recorded is kept beside the error.
 * Assumes a single scheduler instance.
 */
export const failOrphanedRuns = async (
  db: Queryable
): Promise<{ id: string; externalId: string | null }[]> =>
  (
    await db.query<{ id: string; external_id: string | null }>(
      `update runs set status = 'failed', finished_at = now(),
         result = coalesce(result, '{}'::jsonb)
           || '{"error": "the engine restarted while this run was in progress"}'::jsonb
       where status ${RUN_IS_ACTIVE} returning id, external_id`
    )
  ).rows.map((row) => ({ id: row.id, externalId: row.external_id }));
