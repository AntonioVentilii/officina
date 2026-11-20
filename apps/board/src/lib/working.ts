import type { Learning, LearningDecision } from './learning-types';

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
