import { branchForLearning, can, editsProject, type Role } from '@officina/core';
import {
  claimLearningDecision,
  decideLearning,
  holdLearningDecision,
  loadLearning,
  loadProject,
  releaseLearningDecision,
  requestLearningRewrite,
  type LearningRow
} from '@officina/db';
import type { Pool } from 'pg';
import {
  openLearningPullRequest,
  type Hold,
  type LearningGitHub,
  type OpenedLearning
} from './learning-pull-request';
import { TaskCommandError } from './tasks';

interface Target {
  readonly projectId: string;
  readonly memberId: string;
  readonly role: Role;
  readonly publicUrl: string;
}

/** Why a learning cannot be accepted while its edit is being rewritten, or after that failed. */
const REWRITE_BLOCKS = {
  requested:
    'the learner is rewriting this edit against the current file; decide it once it is back',
  failed: 'the edit no longer applies and the learner could not rewrite it; reject it instead'
} as const;

/** Said when the claim of a decision was taken over, after its lease ran out, by another one. */
const TAKEN_OVER = 'someone else decided this learning meanwhile; look at it again';

/** A decision under way: the learning as it was when claimed, and the claim that records it. */
interface Claimed {
  readonly learning: LearningRow;
  readonly claim: string;
}

interface Decision {
  readonly pool: Pool;
  readonly github: LearningGitHub | undefined;
  readonly target: Target;
  readonly decision: 'accept' | 'reject';
  readonly note: string | undefined;
}

/** The `Hold` of a claimed decision. */
const holding =
  (pool: Pool, { learning, claim }: Claimed): Hold =>
  async () => {
    if (!(await holdLearningDecision(pool, learning.id, claim)))
      throw new TaskCommandError(TAKEN_OVER);
  };

/**
 * Opens the pull request of a project learning being accepted, or hands an edit the default branch
 * has moved past back to the learner to be rewritten, and then returns null.
 */
const acceptIntoPullRequest = async (
  { pool, github, target, note }: Decision,
  claimed: Claimed
): Promise<OpenedLearning | null> => {
  const { learning } = claimed;
  if (learning.rewrite) throw new TaskCommandError(REWRITE_BLOCKS[learning.rewrite]);
  if (!github) throw new TaskCommandError('the GitHub App is not configured');
  const project = (await loadProject(pool, target.projectId))!;
  const opened = await openLearningPullRequest(github, project, learning, {
    publicUrl: target.publicUrl,
    note,
    hold: holding(pool, claimed)
  });
  if (opened.ok) return opened.pr;
  // The learner works per task; a learning without one cannot be rewritten.
  if (learning.taskId === null)
    throw new TaskCommandError(`the edit no longer applies (${opened.why}); reject it instead`);
  if (!(await requestLearningRewrite(pool, learning.id, claimed.claim)))
    throw new TaskCommandError(TAKEN_OVER);
  return null;
};

/**
 * An accept whose decision failed to save may have left its pull request open; rejecting the
 * learning closes it, so nobody merges an edit people turned down.
 */
const closeLeftPullRequest = async (
  { pool, github, target }: Decision,
  learning: LearningRow,
  hold: Hold
): Promise<void> => {
  if (!github || !editsProject(learning.target)) return;
  const project = (await loadProject(pool, target.projectId))!;
  if (project.installationId === null) return;
  // The branch of the edit as it stands, and the first one, which an accept before a rewrite used.
  const branches = new Set([
    branchForLearning(learning),
    branchForLearning({ ...learning, rewrittenAt: null })
  ]);
  for (const branch of branches) {
    await hold();
    await github.closePullRequestsFrom({
      installationId: project.installationId,
      repo: project.repo,
      branch
    });
  }
};

/** A rejected learning stays rejected, so closing what an accept left after it needs no claim. */
const settled: Hold = async () => {};

interface DecisionInput {
  readonly id: string;
  readonly decision: 'accept' | 'reject';
  /** The `rewrittenAt` of the edit the person read, as the board received it. */
  readonly rewrittenAt: string | null;
  readonly note?: string | undefined;
}

/**
 * The learning a decision is about, if it can still be decided as asked: still proposed, and for an
 * accept, the edit the person read, never one rewritten since.
 */
const decidable = (learning: LearningRow | null, input: DecisionInput): LearningRow => {
  if (!learning) throw new TaskCommandError('learning not found');
  if (learning.status !== 'proposed')
    throw new TaskCommandError('this learning was already decided');
  const read = learning.rewrittenAt?.toISOString() ?? null;
  if (input.decision === 'accept' && read !== input.rewrittenAt)
    throw new TaskCommandError('the edit was rewritten since you read it; read it again first');
  return learning;
};

/**
 * Claims the learning for this decision, if it can still be decided as asked. One another decision
 * holds is refused rather than waited on: that decision may be in the middle of its GitHub calls.
 */
const claimDecision = async (
  pool: Pool,
  projectId: string,
  input: DecisionInput
): Promise<Claimed> => {
  const claim = await claimLearningDecision(pool, projectId, input.id);
  const learning = await loadLearning(pool, projectId, input.id);
  if (!claim) {
    decidable(learning, input);
    throw new TaskCommandError('someone is deciding this learning right now; look again shortly');
  }
  try {
    return { learning: decidable(learning, input), claim };
  } catch (error) {
    await releaseLearningDecision(pool, input.id, claim);
    throw error;
  }
};

/**
 * The claim was taken over and the learning decided by someone else. If they rejected it while the
 * pull request of this accept was being opened, it is closed now, as their reject would have.
 */
const decidedMeanwhile = async (
  decision: Decision,
  learning: LearningRow,
  pr: OpenedLearning | undefined
): Promise<never> => {
  const now = await loadLearning(decision.pool, decision.target.projectId, learning.id);
  if (pr && now?.status === 'rejected') await closeLeftPullRequest(decision, learning, settled);
  throw new TaskCommandError(TAKEN_OVER);
};

/** What a decision records of the pull request an accept opened, if it opened one. */
const pullRequestOf = (pr: OpenedLearning | undefined) =>
  pr
    ? {
        prNumber: pr.number,
        prUrl: pr.url,
        ...(pr.branchCommit ? { branchCommit: pr.branchCommit } : {})
      }
    : {};

/**
 * Makes the GitHub calls of a claimed decision, renewing the claim before each write, then records
 * it under the claim. A decision that finds its claim taken over stops before its next write.
 */
const decideClaimed = async (decision: Decision, claimed: Claimed): Promise<LearningRow> => {
  const { pool, target } = decision;
  const { learning, claim } = claimed;
  const reload = async () => (await loadLearning(pool, target.projectId, learning.id))!;
  let pr: OpenedLearning | undefined;
  if (decision.decision === 'accept' && editsProject(learning.target)) {
    const opened = await acceptIntoPullRequest(decision, claimed);
    if (!opened) return reload();
    pr = opened;
  }
  if (decision.decision === 'reject')
    await closeLeftPullRequest(decision, learning, holding(pool, claimed));
  const recorded = await decideLearning(pool, {
    id: learning.id,
    claim,
    status: decision.decision === 'accept' ? 'accepted' : 'rejected',
    memberId: target.memberId,
    note: decision.note ?? null,
    ...pullRequestOf(pr)
  });
  if (!recorded) await decidedMeanwhile(decision, learning, pr);
  return reload();
};

/**
 * Accepting a learning for the project's docs or agent docs opens a pull request with exactly the
 * edit people saw; an agent learning is recorded for Officina's maintainers, whose repository
 * Officina does not write to. Either way people merge, never Officina. The decision claims the
 * learning first, so a second decision made meanwhile is refused and never leaves a pull request
 * for a learning it rejected, and is recorded last, so one that fails halfway leaves the learning
 * proposed for the next attempt to finish. No transaction stays open across the GitHub calls. An
 * edit the default branch has moved past goes back to the learner to be rewritten, and the
 * learning stays proposed until people see the new edit.
 */
export const decide = async (
  pool: Pool,
  github: LearningGitHub | undefined,
  target: Target,
  input: DecisionInput
): Promise<LearningRow> => {
  if (!can(target, 'decide_learnings'))
    throw new TaskCommandError('only maintainers and owners decide on learnings');
  const claimed = await claimDecision(pool, target.projectId, input);
  try {
    return await decideClaimed(
      { pool, github, target, decision: input.decision, note: input.note },
      claimed
    );
  } finally {
    await releaseLearningDecision(pool, input.id, claimed.claim);
  }
};
