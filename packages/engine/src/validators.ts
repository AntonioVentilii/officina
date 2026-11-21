import type { AgentOutput, SpecShape } from '@officina/core';
import { copilotVerdict } from '@officina/github';
import type { RunnerRole } from '@officina/runner';
import { MAX_INTERVIEW_QUESTIONS } from './brief';

/**
 * The project's checks on an agent's result, beyond its contract. Each returns the problems, which
 * go back to the agent to fix before the result counts.
 */

export const interviewProblems = (asked: number) => (output: AgentOutput<RunnerRole>) =>
  (output as AgentOutput<'interviewer'>).outcome === 'question' && asked >= MAX_INTERVIEW_QUESTIONS
    ? [`you have asked ${asked} questions already: complete the request now`]
    : [];

const SHAPE_PROBLEMS: Readonly<Record<SpecShape, { wrong: string; problem: string }>> = {
  split: {
    wrong: 'specced',
    problem:
      'a maintainer picked Split when the size check held the build: submit `split`, not one spec'
  },
  whole: {
    wrong: 'split',
    problem:
      'this task is built as one (a sub-task, or a split people kept whole): submit one spec, not `split`'
  }
};

/** A spec whose shape people decided must take it: a proposed split, or one spec. */
export const shapeProblems = (shape: SpecShape | null) => (output: AgentOutput<RunnerRole>) =>
  shape && (output as AgentOutput<'spec'>).outcome === SHAPE_PROBLEMS[shape].wrong
    ? [SHAPE_PROBLEMS[shape].problem]
    : [];

export const planProblems =
  (gate: 'spec_review' | 'verifying', memberIds: ReadonlySet<string>) =>
  (output: AgentOutput<RunnerRole>) => {
    const chosen = output as AgentOutput<'chooser'>;
    const problems = chosen.approval.verifiers
      .filter((verifier) => !memberIds.has(verifier.memberId))
      .map((verifier) => `verifier ${verifier.memberId} is not a member of this project`);
    if (gate === 'verifying' && chosen.checklist.length === 0)
      problems.push('checklist: at verification the checklist must have at least one step');
    return problems;
  };

export const titleProblems = (pattern: string | null) => (output: AgentOutput<RunnerRole>) => {
  const built = output as AgentOutput<'builder' | 'onboarder'>;
  if (!pattern || built.outcome !== 'pushed' || new RegExp(pattern).test(built.prTitle)) return [];
  return [`prTitle "${built.prTitle}" does not match the required pattern ${pattern}`];
};

export type GitHubReview = { readonly by: string; readonly notes: string };

/**
 * A build round may end `unchanged` only when it answers a GitHub review, and a round answering a
 * Copilot review that asked for a closer look must say what it checked, even when nothing changed.
 */
export const reviewProblems =
  (reviews: readonly GitHubReview[]) =>
  (output: AgentOutput<RunnerRole>): string[] => {
    const built = output as AgentOutput<'builder' | 'onboarder'>;
    const problems: string[] = [];
    if (built.outcome === 'unchanged' && reviews.length === 0) {
      problems.push('`unchanged` only answers a GitHub review, and this round has none');
    }
    const answers = built.outcome === 'pushed' || built.outcome === 'unchanged';
    const closerLook = reviews.some((review) => copilotVerdict(review.notes) === 'closer_look');
    if (answers && closerLook && !('reviewReply' in built && built.reviewReply)) {
      problems.push('a review that asked for a closer look needs `reviewReply`');
    }
    return problems;
  };
