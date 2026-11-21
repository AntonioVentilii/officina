import type { Task } from '@officina/core';

/** A task as the store keeps it, with the row's version, which every decision applied bumps. */
export type StoredTask = { readonly task: Task; readonly version: number };

/** A `tasks` row as Postgres returns it. */
export interface TaskRow {
  id: string;
  kind: Task['kind'];
  project_id: string;
  /** The task this one is a sub-task of, if any. */
  parent_id: string | null;
  requester_id: string;
  stage: Task['stage'];
  lane: Task['lane'];
  spec_version: number;
  head_sha: string | null;
  user_visible: boolean;
  assignee: Task['assignee'];
  blocked: Task['blocked'];
  paused: boolean;
  fix_rounds: number;
  reviews: Task['reviews'];
  approval_plans: Task['approvalPlans'];
  guards: Task['guards'];
  diff_allowance: Task['diffAllowance'];
  merged_early: Task['mergedEarly'];
  version: number;
}

export const toStored = (row: TaskRow): StoredTask => ({
  version: row.version,
  task: {
    id: row.id,
    kind: row.kind,
    requesterId: row.requester_id,
    stage: row.stage,
    lane: row.lane,
    specVersion: row.spec_version,
    headSha: row.head_sha,
    userVisible: row.user_visible,
    assignee: row.assignee,
    blocked: row.blocked,
    paused: row.paused,
    fixRounds: row.fix_rounds,
    reviews: row.reviews,
    approvalPlans: row.approval_plans,
    guards: row.guards,
    diffAllowance: row.diff_allowance,
    mergedEarly: row.merged_early
  }
});
