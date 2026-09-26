import type { Actor, Task } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { findProjectsByRepo } from './projects';

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

export const listProjectMembers = async (db: Queryable, projectId: string) =>
  (
    await db.query<{
      id: string;
      role: 'watcher' | 'contributor' | 'maintainer' | 'owner';
      domains: string[];
    }>('select member_id as id, role, domains from project_roles where project_id = $1', [
      projectId
    ])
  ).rows;
