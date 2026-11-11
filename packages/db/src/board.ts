import type { Actor, Task } from '@officina/core';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface BoardTaskRow {
  readonly id: string;
  readonly kind: Task['kind'];
  readonly number: number;
  readonly title: string;
  readonly stage: Task['stage'];
  readonly lane: Task['lane'];
  readonly blocked: Task['blocked'];
  readonly paused: boolean;
  readonly userVisible: boolean;
  readonly assignee: Task['assignee'];
  readonly requesterId: string;
  readonly requesterName: string;
  readonly specVersion: number;
  readonly headSha: string | null;
  readonly fixRounds: number;
  readonly approvalPlans: Task['approvalPlans'];
  readonly pullRequest: number | null;
  readonly costCents: number;
  readonly runningRoles: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly stageSince: Date;
  /** The latest way into merging skipped people's verification. */
  readonly autoVerified: boolean;
  /** GitHub's auto-merge was turned on since the task last reached merging. */
  readonly autoMergeOn: boolean;
}

const BOARD_COLUMNS = `
  t.id, t.kind, t.number, t.title, t.stage, t.lane, t.blocked, t.paused,
  t.user_visible as "userVisible", t.assignee, t.requester_id as "requesterId",
  m.display_name as "requesterName", t.spec_version as "specVersion", t.head_sha as "headSha",
  t.fix_rounds as "fixRounds", t.approval_plans as "approvalPlans", t.github_pr as "pullRequest",
  coalesce((select sum(r.list_cost_cents) from runs r where r.task_id = t.id), 0)::int as "costCents",
  coalesce(
    (select array_agg(distinct r.agent_role) from runs r
     where r.task_id = t.id and r.status in ('queued', 'running')),
    '{}'
  ) as "runningRoles",
  t.created_at as "createdAt", t.updated_at as "updatedAt",
  coalesce(
    (select max(e.created_at) from task_events e where e.task_id = t.id and e.type = 'stage_changed'),
    t.created_at
  ) as "stageSince",
  exists (
    select 1 from task_events e where e.task_id = t.id and e.type = 'auto_verified'
      and e.id > coalesce((select max(c.id) from task_events c where c.task_id = t.id
        and c.type = 'stage_changed' and c.payload->>'to' = 'choosing'), 0)
  ) as "autoVerified",
  exists (
    select 1 from task_events e where e.task_id = t.id
      and (e.type = 'github_auto_merge'
        or (e.type = 'github_approved' and e.payload->>'merge' = 'auto_merge'))
      and e.id > coalesce((select max(m.id) from task_events m where m.task_id = t.id
        and m.type = 'stage_changed' and m.payload->>'to' = 'merging'), 0)
  ) as "autoMergeOn"`;

export const listBoardTasks = async (db: Queryable, projectId: string): Promise<BoardTaskRow[]> =>
  (
    await db.query<BoardTaskRow>(
      `select ${BOARD_COLUMNS}
       from tasks t join members m on m.id = t.requester_id
       where t.project_id = $1
       order by t.priority desc, t.number desc`,
      [projectId]
    )
  ).rows;

export const loadBoardTask = async (
  db: Queryable,
  projectId: string,
  number: number
): Promise<BoardTaskRow | null> =>
  (
    await db.query<BoardTaskRow>(
      `select ${BOARD_COLUMNS}
       from tasks t join members m on m.id = t.requester_id
       where t.project_id = $1 and t.number = $2`,
      [projectId, number]
    )
  ).rows[0] ?? null;

export interface TaskEventRow {
  readonly id: string;
  readonly actor: Actor;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

export const listTaskEvents = async (db: Queryable, taskId: string): Promise<TaskEventRow[]> =>
  (
    await db.query<TaskEventRow>(
      `select id::text, actor, type, payload, created_at as "createdAt"
       from task_events e where e.task_id = $1 order by e.id`,
      [taskId]
    )
  ).rows;

export interface CommentRow {
  readonly id: string;
  readonly author: Actor;
  readonly body: string;
  readonly createdAt: Date;
}

export const listTaskComments = async (db: Queryable, taskId: string): Promise<CommentRow[]> =>
  (
    await db.query<CommentRow>(
      `select id, author, body, created_at as "createdAt"
       from comments where task_id = $1 order by created_at, id`,
      [taskId]
    )
  ).rows;

export interface SpecVersionRow {
  readonly version: number;
  readonly body: string;
  readonly createdBy: Actor;
  readonly createdAt: Date;
}

export const listSpecVersions = async (db: Queryable, taskId: string): Promise<SpecVersionRow[]> =>
  (
    await db.query<SpecVersionRow>(
      `select version, body, created_by as "createdBy", created_at as "createdAt"
       from spec_versions where task_id = $1 order by version`,
      [taskId]
    )
  ).rows;

export interface RunRow {
  readonly id: string;
  readonly taskId: string;
  readonly taskNumber: number;
  readonly taskTitle: string;
  readonly stage: string;
  readonly role: string;
  readonly agentVersion: number;
  readonly status: string;
  readonly costCents: number | null;
  readonly sessionId: string | null;
  readonly result: unknown;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
  readonly eventCount: number;
}

const RUN_COLUMNS = `
  r.id, r.task_id as "taskId", t.number as "taskNumber", t.title as "taskTitle", r.stage,
  r.agent_role as role, r.agent_version as "agentVersion", r.status,
  r.list_cost_cents as "costCents", r.external_id as "sessionId", r.result,
  r.started_at as "startedAt", r.finished_at as "finishedAt", r.created_at as "createdAt",
  (select count(*) from run_events e where e.run_id = r.id)::int as "eventCount"`;

export const listTaskRuns = async (db: Queryable, taskId: string): Promise<RunRow[]> =>
  (
    await db.query<RunRow>(
      `select ${RUN_COLUMNS} from runs r join tasks t on t.id = r.task_id
       where r.task_id = $1 order by r.created_at`,
      [taskId]
    )
  ).rows;

/** Recent runs across a project, running ones first: the workshop's live activity. */
export const listProjectRuns = async (
  db: Queryable,
  projectId: string,
  limit: number
): Promise<RunRow[]> =>
  (
    await db.query<RunRow>(
      `select ${RUN_COLUMNS} from runs r join tasks t on t.id = r.task_id
       where t.project_id = $1
       order by (r.status in ('queued', 'running')) desc, r.created_at desc
       limit $2`,
      [projectId, limit]
    )
  ).rows;

export const loadRun = async (
  db: Queryable,
  runId: string
): Promise<(RunRow & { projectId: string }) | null> =>
  (
    await db.query<RunRow & { projectId: string }>(
      `select ${RUN_COLUMNS}, t.project_id as "projectId" from runs r join tasks t on t.id = r.task_id
       where r.id = $1`,
      [runId]
    )
  ).rows[0] ?? null;

export interface RunEventRow {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

export const listRunEvents = async (
  db: Queryable,
  runId: string,
  afterId: number,
  limit: number
): Promise<RunEventRow[]> =>
  (
    await db.query<RunEventRow>(
      `select id::text, type, payload, created_at as "createdAt"
       from run_events e where e.run_id = $1 and e.id > $2 order by e.id limit $3`,
      [runId, afterId, limit]
    )
  ).rows;

export const memberNames = async (
  db: Queryable,
  workspaceId: string
): Promise<Map<string, string>> =>
  new Map(
    (
      await db.query<{ id: string; name: string }>(
        'select id, display_name as name from members where workspace_id = $1',
        [workspaceId]
      )
    ).rows.map((row) => [row.id, row.name])
  );

/** Where a notification belongs, so it reaches only the boards that show it. */
export const locateTask = async (
  db: Queryable,
  taskId: string
): Promise<{ projectId: string; number: number } | null> =>
  (
    await db.query<{ projectId: string; number: number }>(
      'select project_id as "projectId", number from tasks where id = $1',
      [taskId]
    )
  ).rows[0] ?? null;

export const locateRun = async (
  db: Queryable,
  runId: string
): Promise<{ projectId: string; number: number } | null> =>
  (
    await db.query<{ projectId: string; number: number }>(
      `select t.project_id as "projectId", t.number from runs r join tasks t on t.id = r.task_id
       where r.id = $1`,
      [runId]
    )
  ).rows[0] ?? null;

/** Members of a project with their names, for agents that must name people. */
export const listProjectMemberProfiles = async (db: Queryable, projectId: string) =>
  (
    await db.query<{ id: string; name: string; role: string; domains: string[] }>(
      `select m.id, m.display_name as name, r.role, r.domains
       from project_roles r join members m on m.id = r.member_id
       where r.project_id = $1 order by m.display_name`,
      [projectId]
    )
  ).rows;

/** The changed paths of the task's latest push, as the engine read them from GitHub. */
export const latestPushedPaths = async (db: Queryable, taskId: string): Promise<string[]> =>
  (
    await db.query<{ paths: string[] }>(
      `select payload->'changedPaths' as paths from task_events
       where task_id = $1 and type = 'pushed' order by id desc limit 1`,
      [taskId]
    )
  ).rows[0]?.paths ?? [];
