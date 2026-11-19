import {
  REVIEWER_ROLES,
  clip,
  reviewNotes,
  reviewerOutputSchema,
  seesReviewFindings,
  type Guard,
  type Member
} from '@officina/core';
import { listTaskEvents, listTaskRuns, type RunRow, type TaskEventRow } from '@officina/db';
import type { Pool } from 'pg';
import { z } from 'zod';
import { roleLabel } from './board';

/**
 * What the reviewer agents found on each build of a task, read from their runs' results, the rows
 * the board's Agent runs tab shows, for `show_task` and `task show`, so a developer's Claude reads
 * why a build came back without opening the board.
 */

/** How much of the reviews one reply prints, so a long result never floods it. */
const REVIEW_LIMITS = {
  /** Characters of one reviewer's written result. */
  result: 6_000,
  /** Earlier builds summarised, the most recent first; older ones are only counted. */
  earlierBuilds: 5
} as const;

/** What starts a new build for the reviewers to look at: a push, or a builder's "nothing to change". */
const NEW_BUILD: ReadonlySet<string> = new Set(['pushed', 'build_unchanged']);

const REVIEWERS: ReadonlySet<string> = new Set(REVIEWER_ROLES);

/** A result the task did not take, because it had moved on by the time it came in. */
const discardedSchema = z.object({ discarded: z.string(), output: reviewerOutputSchema });
const errorSchema = z.object({ error: z.string() });

type Verdict = 'approve' | 'changes' | 'running' | 'failed' | 'cancelled';

const VERDICT_WORDS: Readonly<Record<Verdict, string>> = {
  approve: 'approved',
  changes: 'asked for changes',
  running: 'is still reviewing',
  failed: 'failed',
  cancelled: 'was cancelled'
};

interface Review {
  readonly label: string;
  readonly verdict: Verdict;
  readonly findings: number;
  /** Why a written result did not count, when the task had moved on before it came in. */
  readonly discarded: string | null;
  /** What the reviewer wrote: its summary, its findings with file and line, or why it failed. */
  readonly text: string | null;
}

interface Round {
  /** The build the reviewers looked at, counted from the task's first. */
  readonly build: number;
  /** The most recent first. */
  readonly reviews: readonly Review[];
}

interface ReviewFindings {
  /** The reviews of the latest build reviewed; null before any reviewer ran. */
  readonly latest: Round | null;
  /** The builds before it, the most recent first. */
  readonly earlier: readonly Round[];
  /** The latest build reviewed was sent back and nothing was built since: what to fix now. */
  readonly sentBack: boolean;
}

type ReviewRun = Pick<RunRow, 'role' | 'status' | 'result' | 'createdAt'>;

const written = (
  output: z.infer<typeof reviewerOutputSchema>,
  discarded: string | null
): Omit<Review, 'label'> =>
  output.outcome === 'approve'
    ? { verdict: 'approve', findings: 0, discarded, text: output.summary }
    : {
        verdict: 'changes',
        findings: output.items.length,
        discarded,
        text: reviewNotes(output.items)
      };

const reviewOf = (run: ReviewRun): Review => {
  const label = roleLabel(run.role);
  const direct = reviewerOutputSchema.safeParse(run.result);
  if (direct.success) return { label, ...written(direct.data, null) };
  const discarded = discardedSchema.safeParse(run.result);
  if (discarded.success)
    return { label, ...written(discarded.data.output, discarded.data.discarded) };
  const failed = errorSchema.safeParse(run.result);
  const verdict: Verdict =
    run.status === 'running' || run.status === 'cancelled' ? run.status : 'failed';
  return {
    label,
    verdict,
    findings: 0,
    discarded: null,
    text: failed.success ? failed.data.error : null
  };
};

/**
 * The reviewer runs grouped by the build they looked at: a run belongs to the last build started
 * before it, so a round holds both reviewers of one build, and a build sent back while the task
 * still builds is the one to fix.
 */
export const reviewRounds = (
  runs: readonly ReviewRun[],
  events: readonly Pick<TaskEventRow, 'type' | 'createdAt'>[],
  stage: string
): ReviewFindings => {
  const builds = events
    .filter((event) => NEW_BUILD.has(event.type))
    .map((event) => event.createdAt.getTime());
  const rounds = new Map<number, Review[]>();
  for (const run of runs) {
    if (!REVIEWERS.has(run.role)) continue;
    const build = builds.filter((at) => at <= run.createdAt.getTime()).length;
    rounds.set(build, [reviewOf(run), ...(rounds.get(build) ?? [])]);
  }
  const [latest, ...earlier] = [...rounds.entries()]
    .sort(([a], [b]) => b - a)
    .map(([build, reviews]) => ({ build, reviews }));
  return {
    latest: latest ?? null,
    earlier,
    sentBack:
      stage === 'building' &&
      latest?.build === builds.length &&
      latest.reviews.some((review) => review.verdict === 'changes')
  };
};

/** A task's reviews, or null for a member who may not read them (`seesReviewFindings`). */
export const reviewFindingsFor = async (
  pool: Pool,
  member: Pick<Member, 'role'> & Partial<Pick<Member, 'domains'>>,
  task: { readonly id: string; readonly guards: readonly Guard[]; readonly stage: string }
): Promise<ReviewFindings | null> => {
  if (!seesReviewFindings(member, task)) return null;
  const [runs, events] = await Promise.all([
    listTaskRuns(pool, task.id),
    listTaskEvents(pool, task.id)
  ]);
  return reviewRounds(runs, events, task.stage);
};

const headline = (review: Review) =>
  `${review.label} ${VERDICT_WORDS[review.verdict]}${review.findings ? ` (${review.findings} ${review.findings === 1 ? 'finding' : 'findings'})` : ''}`;

const reviewBlock = (review: Review, quote: (text: string) => string): string[] => [
  `- ${headline(review)}${review.discarded ? `, not applied: the task had moved on (${review.discarded})` : ''}:`,
  ...(review.text ? [quote(clip(review.text, REVIEW_LIMITS.result))] : [])
];

const earlierLine = (round: Round) =>
  `- Build ${round.build}: ${round.reviews.map(headline).join('; ')}.`;

/** Where a build sent back by the reviewers is told to look for what to fix. */
export const SENT_BACK =
  'the reviewers sent the latest build back with changes; what to fix is under Reviews';

/**
 * The reviews as lines of text, the latest build's in full and earlier ones in one line each.
 * `quote` wraps what a reviewer wrote: a fence for Claude, an indent for the terminal.
 */
export const reviewLines = (
  findings: ReviewFindings,
  quote: (text: string) => string
): string[] => {
  const { latest, earlier } = findings;
  if (!latest) return [];
  const lines = [
    `Reviews of build ${latest.build}, the most recent first:`,
    ...latest.reviews.flatMap((review) => reviewBlock(review, quote))
  ];
  if (!earlier.length) return lines;
  const shown = earlier.slice(0, REVIEW_LIMITS.earlierBuilds);
  lines.push('Earlier builds:', ...shown.map(earlierLine));
  const hidden = earlier.length - shown.length;
  if (hidden) lines.push(`(${hidden} earlier ${hidden === 1 ? 'build' : 'builds'} not shown.)`);
  return lines;
};
