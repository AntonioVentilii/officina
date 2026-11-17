import type { BeforeAfter } from './types';

/** One recorded check of one checklist item; `item` counts from 0. */
export interface ChecklistCheck {
  readonly item: number;
  readonly outcome: string;
  readonly outcomeLabel: string;
  /** Who recorded it and where, in words: "Antonio via Claude". */
  readonly by: string;
  readonly evidence: string;
  readonly at: string;
}

/** The verification checklist of a task, with the checks recorded for the head it was written for. */
export interface ChecklistView {
  readonly checklist: readonly string[];
  readonly beforeAfter?: readonly BeforeAfter[];
  readonly userVisible: boolean;
  readonly headSha: string | null;
  /** Oldest first: the last check of an item is where it stands. */
  readonly checks: readonly ChecklistCheck[];
  /** What a check may find, in the API's words. */
  readonly outcomes: readonly { readonly value: string; readonly label: string }[];
  readonly canCheck: boolean;
}

/** Each item's latest check, by position: the checks come oldest first. */
export const latestChecks = (view: ChecklistView): (ChecklistCheck | null)[] => {
  const latest: (ChecklistCheck | null)[] = view.checklist.map(() => null);
  for (const check of view.checks) if (check.item < latest.length) latest[check.item] = check;
  return latest;
};

/**
 * What is not ok yet, in words ("2 not checked, 1 partly checked"), said before a "Looks good"
 * passes over it; empty when every item is ok.
 */
export const stillOpen = (view: ChecklistView): string => {
  const counts: Record<string, number> = {};
  for (const check of latestChecks(view)) {
    if (check?.outcome === 'ok') continue;
    const label = check?.outcomeLabel ?? 'not checked';
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, count]) => `${count} ${label}`)
    .join(', ');
};
