import { TERMINAL_STAGES, redactDeep } from '@officina/core';
import type { StoredTaskContext } from './types';
import type { Pool, PoolClient } from 'pg';
import { runJson } from './run-json';
import { RUN_IS_ACTIVE } from './run-status';
import { loadTask } from './store';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

const UNIQUE_VIOLATION = '23505';

export interface NewRun {
  readonly taskId: string;
  readonly stage: string;
  readonly role: string;
  readonly agentVersion: number;
  readonly runner: string;
  /** The learning whose rewrite the run is for, if it is one. */
  readonly learningId?: string;
}

export const startRun = async (
  db: Pool | PoolClient,
  input: NewRun
): Promise<{ ok: true; runId: string } | { ok: false; error: 'already_running' }> => {
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into runs (task_id, stage, runner, agent_role, agent_version, status, started_at,
         learning_id)
       values ($1, $2, $3, $4, $5, 'running', now(), $6) returning id`,
      [
        input.taskId,
        input.stage,
        input.runner,
        input.role,
        input.agentVersion,
        input.learningId ?? null
      ]
    );
    return { ok: true, runId: rows[0]!.id };
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { ok: false, error: 'already_running' };
    }
    throw error;
  }
};

/**
 * Records the run's session, and whether the run is still in progress: one failed before its
 * session existed (a build taken over) has no session to interrupt yet, so the caller stops it.
 */
export const setRunExternalId = async (
  pool: Pool,
  runId: string,
  externalId: string
): Promise<boolean> =>
  (
    await pool.query<{ active: boolean }>(
      `update runs set external_id = $2 where id = $1 returning status ${RUN_IS_ACTIVE} as active`,
      [runId, externalId]
    )
  ).rows[0]?.active ?? false;

/**
 * Whether the run is still in progress, locked until the caller's transaction ends, so it cannot
 * be failed (a build taken over) while a result of it is being applied.
 */
export const runIsActive = async (client: PoolClient, runId: string): Promise<boolean> =>
  ((
    await client.query(`select 1 from runs where id = $1 and status ${RUN_IS_ACTIVE} for update`, [
      runId
    ])
  ).rowCount ?? 0) > 0;

/** Records a run's validated result before it is applied, so it outlives a crash that follows. */
export const recordRunResult = async (pool: Pool, runId: string, result: unknown) => {
  await pool.query('update runs set result = $2 where id = $1', [runId, runJson(result)]);
};

/** The task event a developer's hand-in records, with the build it handed in as its payload. */
export const HAND_IN_EVENT = 'build_handed_in';

/**
 * The latest build of a task, whoever made it: a run of these roles, whatever its status, with the
 * result it recorded, or a developer's hand-in (`HAND_IN_EVENT`), which has no run and counts as a
 * finished one.
 */
export const latestBuild = async (
  pool: Pool,
  taskId: string,
  roles: readonly string[]
): Promise<{ status: RunStatus; result: unknown } | null> =>
  (
    await pool.query<{ status: RunStatus; result: unknown }>(
      `select status, result from (
         select status, result, created_at from runs
         where task_id = $1 and agent_role = any($2::text[])
         union all
         select 'succeeded', payload, created_at from task_events
         where task_id = $1 and type = $3
       ) build order by created_at desc limit 1`,
      [taskId, roles, HAND_IN_EVENT]
    )
  ).rows[0] ?? null;

/**
 * The numbers of the other tasks of the same project whose run of one of these roles overlapped
 * this run, so far: their own branches could move while this run went on.
 */
export const overlappingRunTasks = async (
  pool: Pool,
  runId: string,
  roles: readonly string[]
): Promise<number[]> =>
  (
    await pool.query<{ number: number }>(
      `select distinct other_task.number from runs mine
       join tasks my_task on my_task.id = mine.task_id
       join tasks other_task on other_task.project_id = my_task.project_id
         and other_task.id <> my_task.id
       join runs other on other.task_id = other_task.id
       where mine.id = $1 and other.agent_role = any($2::text[])
         and other.started_at is not null
         and (other.finished_at is null or other.finished_at >= mine.started_at)
       order by other_task.number`,
      [runId, roles]
    )
  ).rows.map((row) => row.number);

/**
 * The spec status commits Officina itself wrote on the task branches of this run's project since
 * the run started, with the number of the task whose branch each is on: Officina pushes them with
 * the App's identity, like a builder's token would, so they are told apart by sha and branch.
 */
export const ownStatusCommitsDuring = async (
  pool: Pool,
  runId: string
): Promise<{ taskNumber: number; sha: string }[]> =>
  (
    await pool.query<{ taskNumber: number; sha: string }>(
      `select t.number as "taskNumber",
              coalesce(e.payload->>'commitSha', e.payload->>'unverified') as sha
       from runs mine
       join tasks my_task on my_task.id = mine.task_id
       join tasks t on t.project_id = my_task.project_id
       join task_events e on e.task_id = t.id
       where mine.id = $1 and e.type = 'spec_status_set' and e.created_at >= mine.started_at
         and coalesce(e.payload->>'commitSha', e.payload->>'unverified') is not null`,
      [runId]
    )
  ).rows;

/**
 * Records one event of a run. Agent messages, tool output and rejected results all pass through
 * here before anyone can read them in the run log, so secrets are redacted on the way in.
 */
export const appendRunEvent = async (pool: Pool, runId: string, type: string, payload: unknown) => {
  await pool.query('insert into run_events (run_id, type, payload) values ($1, $2, $3)', [
    runId,
    type,
    runJson(redactDeep(payload))
  ]);
};

export const finishRun = async (
  pool: Pool,
  runId: string,
  input: {
    status: Exclude<RunStatus, 'running'>;
    costCents: number | null;
    result: unknown;
  }
) => {
  await pool.query(
    `update runs set status = $2, list_cost_cents = $3, result = $4, finished_at = now() where id = $1`,
    [runId, input.status, input.costCents, runJson(input.result)]
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
export const SINCE_LAST_BUILD = `id > coalesce((select max(id) from task_events where task_id = $1
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
