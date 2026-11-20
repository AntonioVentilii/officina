/**
 * The learnings of a project and the pull requests accepting them opened, as the API sends them
 * (`learningsView` and the task views in `apps/api/src/board.ts`). `types.ts` re-exports them.
 */

/** Where a learning's pull request stands on GitHub. */
export type LearningPullRequestState = 'open' | 'merged' | 'closed';

export interface LearningPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: LearningPullRequestState;
}

/** What a maintainer decides about a learning (`LEARNING_DECISIONS` in `packages/core`). */
export type LearningDecision = 'accept' | 'reject';

/**
 * A decision under way, while its claim holds: which one (null for a claim from before claims
 * named it), who made it (null when nobody is named), whether that is the viewer, and since when.
 */
export interface LearningDeciding {
  readonly decision: LearningDecision | null;
  readonly by: string | null;
  readonly you: boolean;
  readonly since: string;
}

export interface Learning {
  readonly id: string;
  readonly title: string;
  readonly lesson: string;
  readonly evidence: string;
  readonly target: 'docs' | 'project' | 'agent';
  readonly file: string;
  readonly find: string | null;
  readonly text: string;
  readonly status: 'proposed' | 'accepted' | 'rejected' | 'applied';
  readonly taskNumber: number | null;
  readonly taskTitle: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  /** Null until an accept opened its pull request. */
  readonly prState: LearningPullRequestState | null;
  /** The learner is rewriting an edit the default branch moved past, or could not. */
  readonly rewrite: 'requested' | 'failed' | null;
  readonly rewrittenAt: string | null;
  readonly createdAt: string;
  readonly canDecide: boolean;
  /** A decision someone is making now; every board shows the learning at work until it lands. */
  readonly deciding: LearningDeciding | null;
}
