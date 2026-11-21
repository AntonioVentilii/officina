import type { Pool } from 'pg';

/**
 * What the task's agent runs cost that finished since the engine last held it for its spend
 * (`spend_limit`), so a maintainer's answer lets the agents spend the budget again, and a run still
 * going at the hold counts in the next window. The learner runs once the task is done, under its
 * own cap, and is not counted.
 */
export const taskSpendCents = async (db: Pool, taskId: string): Promise<number> =>
  Number(
    (
      await db.query<{ cents: string }>(
        `select coalesce(sum(list_cost_cents), 0) as cents from runs
         where task_id = $1 and agent_role <> 'learner'
           and coalesce(finished_at, created_at) > coalesce(
             (select max(created_at) from task_events
              where task_id = $1 and type = 'guardrail_tripped'
                and payload->>'guardrail' = 'spend_limit'),
             '-infinity')`,
        [taskId]
      )
    ).rows[0]!.cents
  );
