import { ENGINE } from '@officina/core';
import { applyCommand, taskSpendCents } from '@officina/db';
import type { RunnerRole } from '@officina/runner';
import type { Pool } from 'pg';

/**
 * The most one run of a role may spend, below the lane's `budget_usd`, which stays the ceiling of a
 * build. About three times the most such a run cost on Officina's own tasks, so a run that loops
 * stops early instead of spending a build's budget on reading.
 */
const ROLE_BUDGET_CENTS: Readonly<Partial<Record<RunnerRole, number>>> = {
  interviewer: 200,
  chooser: 100,
  spec: 600,
  reviewer_spec: 300,
  reviewer_correctness: 300,
  learner: 300
};

/** The session budget of one run: its role's cap, never above the lane's per-run budget. */
export const runBudgetCents = (role: RunnerRole, laneBudgetUsd: number): number =>
  Math.min(ROLE_BUDGET_CENTS[role] ?? Infinity, Math.round(laneBudgetUsd * 100));

/**
 * What a task's agent runs may spend before a maintainer is asked whether they go on: well above a
 * large task's spec, build and two review rounds, and reached by a build that loops on the same work
 * within three or four runs.
 */
export const TASK_BUDGET_CENTS = 2000;

/**
 * Holds a task whose agent runs spent the per-task budget since a maintainer last let them go
 * on, so no new run starts until one answers. `true` when the task is held now.
 */
export const heldForSpend = async (pool: Pool, taskId: string): Promise<boolean> => {
  const spentCents = await taskSpendCents(pool, taskId);
  if (spentCents < TASK_BUDGET_CENTS) return false;
  const held = await applyCommand(pool, {
    taskId,
    command: { type: 'hold_for_spend', spentCents, limitCents: TASK_BUDGET_CENTS },
    actor: ENGINE
  });
  return held.ok;
};
