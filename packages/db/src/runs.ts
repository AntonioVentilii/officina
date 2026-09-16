import type { Actor, StoredTaskContext } from './types';
import type { Pool, PoolClient } from 'pg';
import { loadTask } from './store';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

const UNIQUE_VIOLATION = '23505';

export const startRun = async (
  pool: Pool,
  input: { taskId: string; stage: string; role: string; agentVersion: number; runner: string }
): Promise<{ ok: true; runId: string } | { ok: false; error: 'already_running' }> => {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `insert into runs (task_id, stage, runner, agent_role, agent_version, status, started_at)
       values ($1, $2, $3, $4, $5, 'running', now()) returning id`,
      [input.taskId, input.stage, input.runner, input.role, input.agentVersion]
    );
    return { ok: true, runId: rows[0]!.id };
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { ok: false, error: 'already_running' };
    }
    throw error;
  }
};

export const setRunExternalId = async (pool: Pool, runId: string, externalId: string) => {
  await pool.query('update runs set external_id = $2 where id = $1', [runId, externalId]);
};

export const appendRunEvent = async (pool: Pool, runId: string, type: string, payload: unknown) => {
  await pool.query('insert into run_events (run_id, type, payload) values ($1, $2, $3)', [
    runId,
    type,
    JSON.stringify(payload)
  ]);
};

export const finishRun = async (
  pool: Pool,
  runId: string,
  input: {
    status: Exclude<RunStatus, 'queued' | 'running'>;
    costCents: number | null;
    result: unknown;
  }
) => {
  await pool.query(
    `update runs set status = $2, list_cost_cents = $3, result = $4, finished_at = now() where id = $1`,
    [runId, input.status, input.costCents, JSON.stringify(input.result)]
  );
};

/** Everything the engine needs about a task and its project to prepare an agent run. */
export const loadTaskContext = async (
  pool: Pool,
  taskId: string
): Promise<StoredTaskContext | null> => {
  const stored = await loadTask(pool, taskId);
  if (!stored) return null;
  const { rows } = await pool.query<{
    number: number;
    title: string;
    project_id: string;
    github_repo: string;
    github_installation_id: string | null;
    default_branch: string;
    config: unknown;
    github_pr: number | null;
    github_issue: number | null;
    spec: string | null;
  }>(
    `select t.number, t.title, t.project_id, t.github_pr, t.github_issue,
            p.github_repo, p.github_installation_id, p.default_branch, p.config,
            (select body from spec_versions s where s.task_id = t.id order by version desc limit 1) as spec
     from tasks t join projects p on p.id = t.project_id where t.id = $1`,
    [taskId]
  );
  const row = rows[0]!;
  return {
    ...stored,
    number: row.number,
    title: row.title,
    projectId: row.project_id,
    repo: row.github_repo,
    // bigint arrives as a string; installation ids fit comfortably in a JS number.
    installationId: row.github_installation_id === null ? null : Number(row.github_installation_id),
    defaultBranch: row.default_branch,
    rawConfig: row.config,
    pullRequest: row.github_pr,
    issue: row.github_issue,
    latestSpec: row.spec
  };
};

export const saveSpecVersion = async (
  pool: Pool | PoolClient,
  input: { taskId: string; version: number; body: string; createdBy: Actor }
) => {
  await pool.query(
    'insert into spec_versions (task_id, version, body, created_by) values ($1, $2, $3, $4)',
    [input.taskId, input.version, input.body, JSON.stringify(input.createdBy)]
  );
};

/** Tasks in a lane whose work an agent currently holds, for the lane's WIP limit. */
export const countOpenAgentWork = async (pool: Pool, projectId: string, lane: string) =>
  Number(
    (
      await pool.query<{ count: string }>(
        `select count(*) from tasks
         where project_id = $1 and lane = $2
           and stage in ('building', 'reviewing', 'choosing', 'verifying', 'merging')
           and assignee->>'kind' = 'agent'`,
        [projectId, lane]
      )
    ).rows[0]!.count
  );

export const listActiveTaskIds = async (pool: Pool, projectId: string): Promise<string[]> =>
  (
    await pool.query<{ id: string }>(
      `select id from tasks where project_id = $1
         and stage not in ('done', 'declined', 'cancelled') order by priority desc, number`,
      [projectId]
    )
  ).rows.map((row) => row.id);

export interface AgentVersionRecord {
  readonly role: string;
  readonly externalAgentId: string;
  readonly version: number;
  readonly definitionHash: string;
}

export const loadAgentVersions = async (pool: Pool): Promise<AgentVersionRecord[]> =>
  (
    await pool.query<AgentVersionRecord>(
      `select role, external_agent_id as "externalAgentId", version, definition_hash as "definitionHash"
       from agent_versions`
    )
  ).rows;

export const saveAgentVersion = async (pool: Pool, record: AgentVersionRecord) => {
  await pool.query(
    `insert into agent_versions (role, external_agent_id, version, definition_hash)
     values ($1, $2, $3, $4)
     on conflict (role) do update set external_agent_id = excluded.external_agent_id,
       version = excluded.version, definition_hash = excluded.definition_hash, updated_at = now()`,
    [record.role, record.externalAgentId, record.version, record.definitionHash]
  );
};

/** Review notes, change requests and CI failures since the builder last pushed, oldest first. */
export const feedbackSinceLastPush = async (pool: Pool, taskId: string): Promise<string[]> =>
  (
    await pool.query<{ text: string }>(
      `select coalesce(payload->>'notes', payload->>'note', payload->>'details') as text
       from task_events
       where task_id = $1
         and id > coalesce((select max(id) from task_events where task_id = $1 and type = 'pushed'), 0)
         and (type in ('changes_requested', 'ci_failed')
              or (type = 'review_recorded' and payload->>'verdict' = 'changes'))
       order by id`,
      [taskId]
    )
  ).rows.map((row) => row.text);

export const listComments = async (pool: Pool, taskId: string): Promise<string[]> =>
  (
    await pool.query<{ body: string }>(
      'select body from comments where task_id = $1 order by created_at',
      [taskId]
    )
  ).rows.map((row) => row.body);
