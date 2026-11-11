import type { LearningTarget } from '@officina/core';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type LearningStatus = 'proposed' | 'accepted' | 'rejected' | 'applied';

export interface LearningRow {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly taskNumber: number | null;
  readonly taskTitle: string | null;
  readonly title: string;
  readonly lesson: string;
  readonly evidence: string;
  readonly target: LearningTarget;
  readonly file: string;
  readonly find: string | null;
  readonly text: string;
  readonly status: LearningStatus;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly createdAt: Date;
}

const COLUMNS = `
  l.id, l.project_id as "projectId", l.task_id as "taskId", t.number as "taskNumber",
  t.title as "taskTitle", l.title, l.text as lesson, l.evidence->>'text' as evidence, l.target,
  l.file, l.find, l.proposed_change as text, l.status, l.decided_by as "decidedBy",
  l.decided_at as "decidedAt", l.decision_note as "decisionNote", l.pr_number as "prNumber",
  l.pr_url as "prUrl", l.created_at as "createdAt"`;

export interface NewLearning {
  readonly title: string;
  readonly lesson: string;
  readonly evidence: string;
  readonly target: LearningTarget;
  readonly edit: {
    readonly file: string;
    readonly find?: string | undefined;
    readonly text: string;
  };
}

export const insertLearnings = async (
  db: Queryable,
  input: { projectId: string; taskId: string; runId: string; learnings: readonly NewLearning[] }
) => {
  for (const learning of input.learnings) {
    await db.query(
      `insert into learnings (project_id, task_id, run_id, title, text, evidence, target, file, find, proposed_change)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.projectId,
        input.taskId,
        input.runId,
        learning.title,
        learning.lesson,
        JSON.stringify({ text: learning.evidence }),
        learning.target,
        learning.edit.file,
        learning.edit.find ?? null,
        learning.edit.text
      ]
    );
  }
};

export const listLearnings = async (db: Queryable, projectId: string): Promise<LearningRow[]> =>
  (
    await db.query<LearningRow>(
      `select ${COLUMNS} from learnings l left join tasks t on t.id = l.task_id
       where l.project_id = $1 order by l.created_at desc limit 200`,
      [projectId]
    )
  ).rows;

export const loadLearning = async (
  db: Queryable,
  projectId: string,
  id: string
): Promise<LearningRow | null> =>
  (
    await db.query<LearningRow>(
      `select ${COLUMNS} from learnings l left join tasks t on t.id = l.task_id
       where l.project_id = $1 and l.id = $2`,
      [projectId, id]
    )
  ).rows[0] ?? null;

/** Records a decision once: a learning that is no longer proposed cannot be decided again. */
export const decideLearning = async (
  db: Queryable,
  input: {
    id: string;
    status: 'accepted' | 'rejected';
    memberId: string;
    note: string | null;
    prNumber?: number;
    prUrl?: string;
  }
): Promise<boolean> =>
  ((
    await db.query(
      `update learnings set status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
         pr_number = $5, pr_url = $6
       where id = $1 and status = 'proposed'`,
      [
        input.id,
        input.status,
        input.memberId,
        input.note,
        input.prNumber ?? null,
        input.prUrl ?? null
      ]
    )
  ).rowCount ?? 0) === 1;

/** A merged learning pull request makes its learning applied. */
export const markLearningsApplied = async (db: Queryable, repo: string, prNumber: number) =>
  (
    await db.query<{ id: string }>(
      `update learnings l set status = 'applied'
       from projects p
       where p.id = l.project_id and p.github_repo = $1 and l.pr_number = $2 and l.status = 'accepted'
       returning l.id`,
      [repo, prNumber]
    )
  ).rows.map((row) => row.id);

/** Done tasks the learner has not looked at yet, recent ones only. */
export const listTasksAwaitingLearning = async (
  db: Queryable,
  projectId: string
): Promise<string[]> =>
  (
    await db.query<{ id: string }>(
      `select t.id from tasks t
       where t.project_id = $1 and t.stage = 'done' and t.updated_at > now() - interval '14 days'
         and not exists (select 1 from runs r where r.task_id = t.id and r.agent_role = 'learner')
       order by t.updated_at`,
      [projectId]
    )
  ).rows.map((row) => row.id);

/** What the project has already learned or turned down, so the learner does not repeat it. */
export const listRecentLearningTitles = async (db: Queryable, projectId: string) =>
  (
    await db.query<{ title: string; status: LearningStatus; file: string }>(
      `select title, status, file from learnings where project_id = $1
       order by created_at desc limit 40`,
      [projectId]
    )
  ).rows;
