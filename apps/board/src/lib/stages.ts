import { HUES } from './hues';
import type { Stage } from './types';

/** Plain words for every stage, for people who never read a pull request. */
export const STAGE_LABELS: Record<Stage, string> = {
  request: 'Draft',
  triage: 'New request',
  speccing: 'Writing the plan',
  spec_review: 'Plan to approve',
  ready: 'Queued',
  building: 'Being built',
  reviewing: 'Being reviewed',
  choosing: 'Being reviewed',
  verifying: 'Ready to check',
  merging: 'Shipping',
  done: 'Done',
  declined: 'Declined',
  cancelled: 'Cancelled'
};

export interface Column {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly stages: readonly Stage[];
  /** Fucina draws the column, its cards and the task's track in it. */
  readonly hue: string;
}

/** The stage groups the board's columns and the task's track share. */
const INTAKE: readonly Stage[] = ['request', 'triage'];
const PLAN: readonly Stage[] = ['speccing', 'spec_review'];
const BUILD: readonly Stage[] = ['ready', 'building', 'reviewing', 'choosing'];

export const COLUMNS: readonly Column[] = [
  { id: 'intake', title: 'Requests', hint: 'New ideas', stages: INTAKE, hue: HUES.blue },
  {
    id: 'plan',
    title: 'Plan',
    hint: 'An agent writes it, people approve it',
    stages: PLAN,
    hue: HUES.violet
  },
  {
    id: 'build',
    title: 'Building',
    hint: 'Agents build and review it',
    stages: BUILD,
    hue: HUES.orange
  },
  {
    id: 'check',
    title: 'Check',
    hint: 'People try the result',
    stages: ['verifying', 'merging'],
    hue: HUES.teal
  },
  { id: 'done', title: 'Done', hint: 'Shipped', stages: ['done'], hue: HUES.green }
];

/** The hue of the column a stage sits in. A closed task sits in none, so it has no hue. */
export const stageHue = (stage: Stage): string | undefined =>
  COLUMNS.find((column) => column.stages.includes(stage))?.hue;

export const CLOSED: readonly Stage[] = ['declined', 'cancelled'];

/** The stages a task never leaves, shipped or closed: `TERMINAL_STAGES` in `packages/core`. */
const TERMINAL: readonly Stage[] = ['done', ...CLOSED];

/** Whether a task at this stage is still open: neither shipped nor closed. */
export const isOpen = (stage: Stage) => !TERMINAL.includes(stage);

/** The path every task walks; the task page draws it as a track. */
export const TRACK: readonly { readonly label: string; readonly stages: readonly Stage[] }[] = [
  { label: 'Request', stages: INTAKE },
  { label: 'Plan', stages: PLAN },
  { label: 'Build', stages: BUILD },
  { label: 'Check', stages: ['verifying'] },
  { label: 'Ship', stages: ['merging'] },
  { label: 'Done', stages: ['done'] }
];

export const trackIndex = (stage: Stage) => TRACK.findIndex((step) => step.stages.includes(stage));

/** What a task's move from one stage to the next stamps on it in Fucina, if anything. */
export type Stamp = 'approved' | 'accepted' | 'shipped';

export const STAMP_LABELS: Record<Stamp, string> = {
  approved: 'Approved',
  accepted: 'Accepted',
  shipped: 'Shipped'
};

/** People said yes to the plan, or to the result, or the work shipped. Any other move stamps nothing. */
export const stampFor = (from: Stage, to: Stage): Stamp | null => {
  if (from === 'spec_review' && BUILD.includes(to)) return 'approved';
  if (from === 'verifying' && (to === 'merging' || to === 'done')) return 'accepted';
  if (from === 'merging' && to === 'done') return 'shipped';
  return null;
};
