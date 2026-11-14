import { TERMINAL_STAGES, redactDeep } from '@officina/core';
import type { Actor, StoredTaskContext } from './types';
import type { Pool, PoolClient } from 'pg';
import { RUN_IS_ACTIVE } from './run-status';
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

/** Records a run's validated result before it is applied, so it outlives a crash that follows. */
export const recordRunResult = async (pool: Pool, runId: string, result: unknown) => {
  await pool.query('update runs set result = $2 where id = $1', [runId, JSON.stringify(result)]);
};

/** The latest run of these roles on a task, whatever its status, with the result it recorded. */
export const latestBuildRun = async (
  pool: Pool,
  taskId: string,
  roles: readonly string[]
): Promise<{ status: RunStatus; result: unknown } | null> =>
  (
    await pool.query<{ status: RunStatus; result: unknown }>(
      `select status, result from runs where task_id = $1 and agent_role = any($2::text[])
       order by created_at desc limit 1`,
      [taskId, roles]
    )
  ).rows[0] ?? null;

/**
 * Records one event of a run. Agent messages, tool output and rejected results all pass through
 * here before anyone can read them in the run log, so secrets are redacted on the way in.
 */
export const appendRunEvent = async (pool: Pool, runId: string, type: string, payload: unknown) => {
  await pool.query('insert into run_events (run_id, type, payload) values ($1, $2, $3)', [
    runId,
    type,
    JSON.stringify(redactDeep(payload))
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
    agent_environment_id: string | null;
    config: unknown;
    github_pr: number | null;
    github_issue: number | null;
    spec: string | null;
  }>(
    `select t.number, t.title, t.project_id, t.github_pr, t.github_issue,
            p.github_repo, p.github_installation_id, p.default_branch, p.agent_environment_id, p.config,
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
    environmentId: row.agent_environment_id,
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
         and stage <> all($2) order by priority desc, number`,
      [projectId, [...TERMINAL_STAGES]]
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

/** Where the current build round's feedback starts: the builder's last push or unchanged finish. */
const SINCE_LAST_BUILD = `id > coalesce((select max(id) from task_events where task_id = $1
  and type in ('pushed', 'build_unchanged')), 0)`;

/**
 * Review notes, change requests and CI failures since the builder last pushed or finished a round
 * unchanged, oldest first.
 */
export const feedbackSinceLastPush = async (pool: Pool, taskId: string): Promise<string[]> =>
  (
    await pool.query<{ text: string }>(
      `select coalesce(payload->>'notes', payload->>'note', payload->>'details') as text
       from task_events
       where task_id = $1
         and ${SINCE_LAST_BUILD}
         and (type in ('changes_requested', 'ci_failed')
              or (type = 'review_recorded' and payload->>'verdict' = 'changes')
              or (type = 'guardrail_tripped' and payload->>'guardrail' = 'unlisted_files'))
       order by id`,
      [taskId]
    )
  ).rows.map((row) => row.text);

/** How many questions the interviewer has asked on a task so far. */
export const countInterviewQuestions = async (pool: Pool, taskId: string): Promise<number> =>
  Number(
    (
      await pool.query<{ count: string }>(
        `select count(*) from task_events
         where task_id = $1 and type = 'blocked' and actor->>'role' = 'interviewer'`,
        [taskId]
      )
    ).rows[0]!.count
  );

/** The GitHub reviews the current build round answers, oldest first: who left each, and its notes. */
export const githubReviewsSinceLastPush = async (
  pool: Pool,
  taskId: string
): Promise<{ by: string; notes: string }[]> =>
  (
    await pool.query<{ by: string; notes: string }>(
      `select payload->>'by' as by, payload->>'notes' as notes
       from task_events
       where task_id = $1 and ${SINCE_LAST_BUILD}
         and type = 'review_recorded' and payload->>'reviewer' = 'github'
       order by id`,
      [taskId]
    )
  ).rows;

/** Records an engine action in the task's audit log. */
export const appendTaskEvent = async (
  pool: Pool,
  input: { taskId: string; actor: Actor; type: string; payload: unknown }
) => {
  await pool.query(
    'insert into task_events (task_id, actor, type, payload) values ($1, $2, $3, $4)',
    [input.taskId, JSON.stringify(input.actor), input.type, JSON.stringify(input.payload)]
  );
};

export const hasTaskEvent = async (pool: Pool, taskId: string, type: string, payload: unknown) =>
  ((
    await pool.query(
      'select 1 from task_events where task_id = $1 and type = $2 and payload @> $3::jsonb',
      [taskId, type, JSON.stringify(payload)]
    )
  ).rowCount ?? 0) > 0;

/** The latest successful chooser result for a task, if any. */
export const latestChooserResult = async (pool: Pool, taskId: string): Promise<unknown> =>
  (
    await pool.query<{ result: unknown }>(
      `select result from runs where task_id = $1 and agent_role = 'chooser' and status = 'succeeded'
       order by created_at desc limit 1`,
      [taskId]
    )
  ).rows[0]?.result ?? null;

/**
 * Runs left `running` by a previous engine process can never finish: their stream is gone. They are
 * failed so the step can run again; a result the run already recorded is kept beside the error.
 * Assumes a single scheduler instance.
 */
export const failOrphanedRuns = async (
  db: Pool | PoolClient
): Promise<{ id: string; externalId: string | null }[]> =>
  (
    await db.query<{ id: string; external_id: string | null }>(
      `update runs set status = 'failed', finished_at = now(),
         result = coalesce(result, '{}'::jsonb)
           || '{"error": "the engine restarted while this run was in progress"}'::jsonb
       where status ${RUN_IS_ACTIVE} returning id, external_id`
    )
  ).rows.map((row) => ({ id: row.id, externalId: row.external_id }));
