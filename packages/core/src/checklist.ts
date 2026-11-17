import { z } from 'zod';
import { redactSecrets } from './guards';
import type { Task } from './lifecycle';

/**
 * What a person found when they checked one item of the verification checklist. `partial` means
 * part of the item was checked and the evidence says what is still open.
 */
export const CHECK_OUTCOMES = ['ok', 'problem', 'partial'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Where a check was recorded: on the board, or by Claude through the connector for the person. */
export const CHECK_CHANNELS = ['board', 'claude'] as const;
export type CheckChannel = (typeof CHECK_CHANNELS)[number];

/** Words for each outcome, on the board, in Claude's answers and in the pull request comment. */
export const CHECK_OUTCOME_LABELS: Record<CheckOutcome, string> = {
  ok: 'ok',
  problem: 'problem',
  partial: 'partly checked'
};

/** How each channel is named after the person: "Antonio on the board", "Antonio via Claude". */
export const CHECK_CHANNEL_LABELS: Record<CheckChannel, string> = {
  board: 'on the board',
  claude: 'via Claude'
};

/** How long the evidence for one check may be: one line, read next to the item. */
export const CHECK_EVIDENCE_MAX = 300;

/**
 * The evidence for a check as it is stored: one line, nothing shaped like a secret, since it is
 * posted on the pull request.
 */
export const evidenceSchema = z
  .string()
  .trim()
  .max(CHECK_EVIDENCE_MAX)
  .transform((text) => redactSecrets(text.replace(/\s+/g, ' ')));

/** One recorded check of one item, for one head. Checks are added, never changed. */
export interface ChecklistCheck {
  /** The item's position in the checklist, from 0. */
  readonly item: number;
  readonly outcome: CheckOutcome;
  readonly evidence: string;
  readonly memberId: string;
  readonly channel: CheckChannel;
  readonly at: Date;
}

/** Each item's latest check, by position; an item nobody checked has none. */
export const latestChecks = <T extends Pick<ChecklistCheck, 'item'>>(
  checks: readonly T[],
  items: number
): (T | null)[] => {
  const latest: (T | null)[] = Array.from({ length: items }, () => null);
  for (const check of checks) if (check.item < items) latest[check.item] = check;
  return latest;
};

/** How many items stand at each outcome, and how many nobody checked. */
export const checkCounts = (latest: readonly (Pick<ChecklistCheck, 'outcome'> | null)[]) => {
  const counts: Record<CheckOutcome | 'unchecked', number> = {
    ok: 0,
    problem: 0,
    partial: 0,
    unchecked: 0
  };
  for (const check of latest) counts[check?.outcome ?? 'unchecked'] += 1;
  return counts;
};

/**
 * The head the verification checklist was written for: the subject of the chooser's plan at
 * verification. Checks belong to it, so a new push starts a checklist of its own.
 */
export const checklistHead = (task: Pick<Task, 'approvalPlans'>): string | null => {
  const subject = task.approvalPlans.verifying?.subject;
  return subject?.startsWith('sha:') ? subject.slice('sha:'.length) : null;
};
