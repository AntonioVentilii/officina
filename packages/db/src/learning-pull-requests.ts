/**
 * Where a learning's pull request stands on GitHub, as the webhooks and the catch-up last read it:
 * a merge makes the learning applied, a close without merging records when it was closed.
 */
export type LearningPullRequestState = 'open' | 'merged' | 'closed';

/** A pull request Officina opened for a learning of a task. */
export interface LearningPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: LearningPullRequestState;
}

/** The `LearningPullRequestState` of the learning under `alias`, the one place it is derived. */
export const prStateOf = (alias: string) => `case when ${alias}.status = 'applied' then 'merged'
  when ${alias}.pr_closed_at is not null then 'closed' else 'open' end`;

/**
 * The pull requests opened for the learnings of the task with id `taskId` (a column of the outer
 * query), oldest first, as a JSON list of `LearningPullRequest`.
 */
export const learningPullRequestsOf = (taskId: string) => `coalesce(
  (select json_agg(json_build_object('number', l.pr_number, 'url', l.pr_url, 'state', ${prStateOf('l')})
     order by l.pr_number)
   from learnings l where l.task_id = ${taskId} and l.pr_number is not null),
  '[]'::json)`;

/** Another learning of the project with the same edit, accepted with its pull request. */
export interface LearningDuplicate {
  readonly id: string;
  readonly title: string;
  readonly taskNumber: number | null;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prState: LearningPullRequestState;
}

/**
 * The `LearningDuplicate` of a proposed learning `l`: the same edit (target, file, find and text)
 * already accepted in the project with its pull request open or merged, the earliest decided.
 */
export const DUPLICATE_OF = `case when l.status = 'proposed' then (
  select json_build_object('id', d.id, 'title', d.title, 'taskNumber', dt.number,
    'prNumber', d.pr_number, 'prUrl', d.pr_url, 'prState', ${prStateOf('d')})
  from learnings d left join tasks dt on dt.id = d.task_id
  where d.project_id = l.project_id and d.id <> l.id and d.target = l.target and d.file = l.file
    and d.find is not distinct from l.find and d.proposed_change = l.proposed_change
    and d.pr_number is not null and d.status in ('accepted', 'applied')
    and ${prStateOf('d')} <> 'closed'
  order by d.decided_at, d.id limit 1) end`;
