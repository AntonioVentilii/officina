import type { Card, Stage } from './types';

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
}

export const COLUMNS: readonly Column[] = [
  { id: 'intake', title: 'Requests', hint: 'New ideas', stages: ['request', 'triage'] },
  {
    id: 'plan',
    title: 'Plan',
    hint: 'An agent writes it, people approve it',
    stages: ['speccing', 'spec_review']
  },
  {
    id: 'build',
    title: 'Building',
    hint: 'Agents build and review it',
    stages: ['ready', 'building', 'reviewing', 'choosing']
  },
  { id: 'check', title: 'Check', hint: 'People try the result', stages: ['verifying', 'merging'] },
  { id: 'done', title: 'Done', hint: 'Shipped', stages: ['done'] }
];

export const CLOSED: readonly Stage[] = ['declined', 'cancelled'];

/** The path every task walks; the task page draws it as a track. */
export const TRACK: readonly { readonly label: string; readonly stages: readonly Stage[] }[] = [
  { label: 'Request', stages: ['request', 'triage'] },
  { label: 'Plan', stages: ['speccing', 'spec_review'] },
  { label: 'Build', stages: ['ready', 'building', 'reviewing', 'choosing'] },
  { label: 'Check', stages: ['verifying'] },
  { label: 'Ship', stages: ['merging'] },
  { label: 'Done', stages: ['done'] }
];

export const trackIndex = (stage: Stage) => TRACK.findIndex((step) => step.stages.includes(stage));

export const isClosed = (card: Pick<Card, 'stage'>) =>
  card.stage === 'done' || CLOSED.includes(card.stage);
