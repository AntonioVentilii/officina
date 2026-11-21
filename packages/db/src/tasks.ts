import {
  BUILD_ROLES,
  READS_PROPOSALS,
  openProposals,
  type Actor,
  type Approval,
  type Command,
  type Member,
  type ProposalEntry,
  type Task
} from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { findProjectsByRepo } from './projects';
import { RUN_IS_ACTIVE } from './run-status';

type Queryable = Pool | PoolClient;

/** A project by repository, or the only project when no repository is given. */
export const resolveProjectId = async (db: Queryable, repo?: string): Promise<string | null> => {
  if (repo) return (await findProjectsByRepo(db, repo))[0]?.id ?? null;
  const { rows } = await db.query<{ id: string }>('select id from projects');
  return rows.length === 1 ? rows[0]!.id : null;
};

export const findTaskIdByNumber = async (
  db: Queryable,
  projectId: string,
  number: number
): Promise<string | null> =>
  (
    await db.query<{ id: string }>('select id from tasks where project_id = $1 and number = $2', [
      projectId,
      number
    ])
  ).rows[0]?.id ?? null;

/** A request as its client named it: the same id from the same requester is the same request. */
interface NamedRequest {
  readonly projectId: string;
  readonly requesterId: string;
  readonly requestId: string;
}

/** The task a requester already opened with this request id, if any, at its current stage. */
export const findRequestedTask = async (
  db: Queryable,
  request: NamedRequest
): Promise<{ id: string; stage: Task['stage'] } | null> =>
  (
    await db.query<{ id: string; stage: Task['stage'] }>(
      `select id, stage from tasks
       where project_id = $1 and requester_id = $2 and request_id = $3`,
      [request.projectId, request.requesterId, request.requestId]
    )
  ).rows[0] ?? null;

/** Names the task a request just opened, in its transaction, so a repeat finds it. */
export const nameRequestedTask = async (db: Queryable, taskId: string, requestId: string) => {
  await db.query('update tasks set request_id = $2 where id = $1', [taskId, requestId]);
};

/** A member of the project by email, or the project's owner when no email is given. */
export const resolveProjectMember = async (
  db: Queryable,
  projectId: string,
  email?: string
): Promise<string | null> => {
  const { rows } = email
    ? await db.query<{ id: string }>(
        `select m.id from members m join project_roles r on r.member_id = m.id and r.project_id = $1
         where lower(m.email) = lower($2)`,
        [projectId, email]
      )
    : await db.query<{ id: string }>(
        `select member_id as id from project_roles where project_id = $1 and role = 'owner'
         order by member_id limit 1`,
        [projectId]
      );
  return rows[0]?.id ?? null;
};

export const addComment = async (db: Queryable, taskId: string, author: Actor, body: string) => {
  await db.query('insert into comments (task_id, author, body) values ($1, $2, $3)', [
    taskId,
    JSON.stringify(author),
    body
  ]);
};

export interface TaskSummary {
  readonly number: number;
  readonly title: string;
  readonly stage: Task['stage'];
  readonly lane: Task['lane'];
  readonly blocked: Task['blocked'];
  readonly pullRequest: number | null;
}

export const listTaskSummaries = async (db: Queryable, projectId: string): Promise<TaskSummary[]> =>
  (
    await db.query<{
      number: number;
      title: string;
      stage: Task['stage'];
      lane: Task['lane'];
      blocked: Task['blocked'];
      github_pr: number | null;
    }>(
      'select number, title, stage, lane, blocked, github_pr from tasks where project_id = $1 order by number',
      [projectId]
    )
  ).rows.map((row) => ({
    number: row.number,
    title: row.title,
    stage: row.stage,
    lane: row.lane,
    blocked: row.blocked,
    pullRequest: row.github_pr
  }));

export interface RunSummary {
  readonly role: string;
  readonly status: string;
  readonly costCents: number | null;
  readonly sessionId: string | null;
  readonly result: unknown;
}

export const listRuns = async (db: Queryable, taskId: string): Promise<RunSummary[]> =>
  (
    await db.query<{
      agent_role: string;
      status: string;
      list_cost_cents: number | null;
      external_id: string | null;
      result: unknown;
    }>(
      `select agent_role, status, list_cost_cents, external_id, result from runs
       where task_id = $1 order by created_at`,
      [taskId]
    )
  ).rows.map((row) => ({
    role: row.agent_role,
    status: row.status,
    costCents: row.list_cost_cents,
    sessionId: row.external_id,
    result: row.result
  }));

export const listApprovedSubjects = async (
  db: Queryable,
  taskId: string
): Promise<{ memberId: string; subject: string }[]> =>
  (
    await db.query<{ memberId: string; subject: string }>(
      `select member_id as "memberId", subject from approvals where task_id = $1 and decision = 'approve'`,
      [taskId]
    )
  ).rows;

/**
 * The approvals connected apps proposed on a task and the ones discarded, oldest first: what
 * `openProposals` reads to know which still wait.
 */
export const listProposalHistory = async (
  db: Queryable,
  taskId: string
): Promise<ProposalEntry[]> =>
  (
    await db.query<ProposalEntry>(
      `select type, payload->>'gate' as gate, payload->>'subject' as subject,
         payload->>'memberId' as "memberId", actor->'via' as via
       from task_events
       where task_id = $1 and type in ('approval_proposed', 'approval_proposal_discarded')
       order by id`,
      [taskId]
    )
  ).rows;

/** The proposals still open on a task, read only for the commands that decide on them. */
export const proposalsFor = async (
  db: Queryable,
  command: Command,
  task: Task,
  approvals: readonly Approval[]
) =>
  READS_PROPOSALS.has(command.type)
    ? openProposals(task, await listProposalHistory(db, task.id), approvals)
    : [];

/** One member's role in a project, or null when they hold none there. */
export const loadProjectMember = async (db: Queryable, projectId: string, memberId: string) =>
  (
    await db.query<Member>(
      'select member_id as id, role, domains from project_roles where project_id = $1 and member_id = $2',
      [projectId, memberId]
    )
  ).rows[0] ?? null;

export const listProjectMembers = async (db: Queryable, projectId: string) =>
  (
    await db.query<Member>(
      'select member_id as id, role, domains from project_roles where project_id = $1',
      [projectId]
    )
  ).rows;

/**
 * The tasks of a project with a build run an agent still holds, or one that ended after `since`.
 * A build's ref check counts every branch Officina's identity moves while it runs, so nothing else
 * may push as the App beside one: asked with `since` now, before pushing, and with the push's start,
 * after it.
 */
export const tasksBuildingSince = async (
  db: Queryable,
  projectId: string,
  since: Date
): Promise<number[]> =>
  (
    await db.query<{ number: number }>(
      `select distinct t.number from runs r join tasks t on t.id = r.task_id
       where t.project_id = $1 and r.agent_role = any($2::text[])
         and (r.status ${RUN_IS_ACTIVE} or r.finished_at >= $3)
       order by t.number`,
      [projectId, BUILD_ROLES, since]
    )
  ).rows.map((row) => row.number);
