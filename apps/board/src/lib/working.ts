import type { Learning, LearningDecision } from './learning-types';
import type { Card } from './types';

/** Work under way on something on the board, as its status line words it. */
export interface Work {
  /** What is being done, in one word: `Accepting`. */
  readonly label: string;
  /** What it is doing right now: `opening its pull request on GitHub`. */
  readonly detail: string;
  /** Who started it: `You`, a member's name, or null when nobody is named. */
  readonly who: string | null;
  /** When it started, to show how long it has run. */
  readonly since: string;
}

/** A decision this board has sent and is waiting on, before the API reports its claim. */
export interface SentDecision {
  readonly decision: LearningDecision;
  readonly since: string;
}

/** How each decision on a learning reads, by whether accepting it opens a pull request. */
const DECISION_WORK = {
  accept: {
    label: 'Accepting',
    pullRequest: 'opening its pull request on GitHub',
    board: 'recording it for the Officina prompts'
  },
  reject: {
    label: 'Rejecting',
    pullRequest: 'closing any pull request an accept left',
    board: 'recording it'
  }
} as const;

const wordsOf = (learning: Learning, decision: LearningDecision | null) => {
  if (!decision) return { label: 'Deciding', detail: '' };
  const words = DECISION_WORK[decision];
  return {
    label: words.label,
    detail: learning.target === 'agent' ? words.board : words.pullRequest
  };
};

/**
 * The work under way on a learning: the decision the API says someone is making, which every board
 * shows, or else the one this board sent and is still waiting on. Null when nothing is.
 */
export const learningWork = (learning: Learning, sent: SentDecision | null): Work | null => {
  const { deciding } = learning;
  if (deciding)
    return {
      ...wordsOf(learning, deciding.decision),
      who: deciding.you ? 'You' : deciding.by,
      since: deciding.since
    };
  if (sent) return { ...wordsOf(learning, sent.decision), who: 'You', since: sent.since };
  return null;
};

/** How each action on a task reads while it is at work, by the type the API takes. */
const TASK_WORK = {
  accept: { label: 'Accepting', detail: 'the request; an agent writes the plan next' },
  decline: { label: 'Declining', detail: 'the request' },
  claim: { label: 'Claiming', detail: 'the build for you' },
  release: { label: 'Handing back', detail: 'the build, to be built again' },
  changes: { label: 'Sending back', detail: 'with your notes' },
  keep_whole: { label: 'Sending back', detail: 'to be planned as one task' },
  approve: { label: 'Approving', detail: 'recording your approval' },
  submit: { label: 'Submitting', detail: 'to triage as it is' },
  answer: { label: 'Answering', detail: 'the step runs again next' },
  cancel: { label: 'Cancelling', detail: 'the task' },
  discard_proposal: { label: 'Discarding', detail: 'the approval Claude proposed' },
  hand_in: {
    label: 'Handing in',
    detail: 'reading the push on GitHub and opening the pull request'
  }
} as const;

/** An action on a task, as the API takes it (`hand_in` has its own route). */
export type TaskAction = keyof typeof TASK_WORK;

/** An action this board has sent on a task and is waiting on, until a refresh lands. */
export interface SentAction {
  readonly action: TaskAction;
  readonly since: string;
}

/**
 * The work under way on a task: a hand-in the API says someone is making, which every board shows,
 * or else the action this board sent and is still waiting on. Null when nothing is.
 */
export const taskWork = (task: Pick<Card, 'handingIn'>, sent: SentAction | null): Work | null => {
  const { handingIn } = task;
  if (handingIn)
    return {
      ...TASK_WORK.hand_in,
      who: handingIn.you ? 'You' : handingIn.by,
      since: handingIn.since
    };
  if (sent) return { ...TASK_WORK[sent.action], who: 'You', since: sent.since };
  return null;
};
