import type { Card, Stage } from './types';

export const STAGE_LABELS: Record<Stage, string> = {
  request: 'Draft',
  triage: 'Triage',
  speccing: 'Writing spec',
  spec_review: 'Spec review',
  ready: 'Ready to build',
  building: 'Building',
  reviewing: 'In review',
  choosing: 'Preparing checklist',
  verifying: 'Verifying',
  merging: 'Ready to merge',
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
  {
    id: 'intake',
    title: 'Requests',
    hint: 'New ideas waiting for triage',
    stages: ['request', 'triage']
  },
  {
    id: 'spec',
    title: 'Spec',
    hint: 'Written by an agent, approved by people',
    stages: ['speccing', 'spec_review']
  },
  {
    id: 'build',
    title: 'Build',
    hint: 'Implemented on a task branch',
    stages: ['ready', 'building']
  },
  {
    id: 'review',
    title: 'Review',
    hint: 'Two independent agent reviews',
    stages: ['reviewing', 'choosing']
  },
  { id: 'verify', title: 'Verify', hint: 'People check the result', stages: ['verifying'] },
  { id: 'merge', title: 'Merge', hint: 'Approve and merge on GitHub', stages: ['merging'] },
  { id: 'done', title: 'Done', hint: 'Merged', stages: ['done'] }
];

export const CLOSED: readonly Stage[] = ['declined', 'cancelled'];

/** The path every task walks; the task page draws it as a track. */
export const TRACK: readonly { readonly label: string; readonly stages: readonly Stage[] }[] = [
  { label: 'Request', stages: ['request', 'triage'] },
  { label: 'Spec', stages: ['speccing'] },
  { label: 'Approve', stages: ['spec_review'] },
  { label: 'Build', stages: ['ready', 'building'] },
  { label: 'Review', stages: ['reviewing', 'choosing'] },
  { label: 'Verify', stages: ['verifying'] },
  { label: 'Merge', stages: ['merging'] },
  { label: 'Done', stages: ['done'] }
];

export const trackIndex = (stage: Stage) => TRACK.findIndex((step) => step.stages.includes(stage));

export const isClosed = (card: Pick<Card, 'stage'>) =>
  card.stage === 'done' || CLOSED.includes(card.stage);
