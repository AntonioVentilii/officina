import {
  can,
  CHECK_CHANNEL_LABELS,
  CHECK_OUTCOME_LABELS,
  CHECK_OUTCOMES,
  checklistHead,
  type Member,
  type Task
} from '@officina/core';
import { listChecks } from '@officina/db';
import type { Pool } from 'pg';

/** What the checklist's latest result, as the approval chooser wrote it, holds for people. */
export interface ChosenChecklist {
  readonly checklist: string[];
  readonly beforeAfter?: { key: string; locale: string; before: string; after: string }[];
  readonly userVisible: boolean;
}

/**
 * The verification checklist as a task page shows it: the chooser's items, every check recorded
 * for the head it was written for (oldest first; the last per item is where it stands), the
 * outcomes a check may have in words, and whether this viewer may record one now.
 */
export const checklistView = async (
  pool: Pool,
  input: {
    readonly taskId: string;
    readonly task: Pick<Task, 'stage' | 'headSha' | 'approvalPlans'>;
    readonly viewer: Member;
    readonly chosen: ChosenChecklist | null;
  }
) => {
  if (!input.chosen) return null;
  const headSha = checklistHead(input.task);
  const checks = headSha ? await listChecks(pool, input.taskId, headSha) : [];
  return {
    ...input.chosen,
    headSha,
    checks: checks.map((check) => ({
      item: check.item,
      outcome: check.outcome,
      outcomeLabel: CHECK_OUTCOME_LABELS[check.outcome],
      by: `${check.name} ${CHECK_CHANNEL_LABELS[check.channel]}`,
      evidence: check.evidence,
      at: check.at
    })),
    outcomes: CHECK_OUTCOMES.map((value) => ({ value, label: CHECK_OUTCOME_LABELS[value] })),
    canCheck:
      input.task.stage === 'verifying' &&
      headSha !== null &&
      headSha === input.task.headSha &&
      can(input.viewer, 'verify_result')
  };
};

/**
 * The checklist as Claude reads it to the person: each item by its number, where its latest check
 * stands, and the before/after rows.
 */
export const checklistLines = (
  view: NonNullable<Awaited<ReturnType<typeof checklistView>>>
): string[] => {
  const latest = new Map(view.checks.map((check) => [check.item, check]));
  const lines = ['What to check (record each with check_item):'];
  view.checklist.forEach((item, index) => {
    const check = latest.get(index);
    const state = check
      ? `${check.outcomeLabel}, ${check.by}${check.evidence ? `: ${check.evidence}` : ''}`
      : 'not checked';
    lines.push(`${index + 1}. ${item} [${state}]`);
  });
  for (const row of view.beforeAfter ?? [])
    lines.push(`- ${row.key} (${row.locale}): "${row.before}" becomes "${row.after}"`);
  return lines;
};
