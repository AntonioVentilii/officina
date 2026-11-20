import { z } from 'zod';
import { TASK_BRANCH_PREFIX } from './steps';

/**
 * How long each field a person or an agent hands in may be, in characters, and how many items a
 * list may hold. The board's API, the Claude connector and the agent contracts all read them here,
 * so a request typed on the board and the same request sent through Claude are held to one rule.
 */
export const INPUT_LIMITS = {
  /** A task's title. */
  title: { min: 3, max: 200 },
  /** A member's display name, as cards, avatars and the Members page show it. */
  memberName: 100,
  /** What a person asks for when they open a request. */
  request: 20_000,
  /** The name a client gives one request it sends, so sending it again opens nothing new. */
  requestId: 200,
  comment: 20_000,
  /** What a person says should change when they ask for changes. */
  note: 10_000,
  answer: 10_000,
  /** Why a person declines or cancels a task. */
  reason: 2_000,
  /** The letter of a question's option ("a", "b"). */
  option: 2,
  /** A pull request title handed in with a push, by a person or the builder. */
  prTitle: { min: 3, max: 120 },
  /**
   * A pull request body handed in with a push, in the sections of the project's template. GitHub
   * holds 65,536 characters; this leaves room for what Officina adds after it: the task link, the
   * issue it closes and an onboarding's follow-ups (15 of at most 500 characters).
   */
  prBody: 50_000,
  /** One thing checked, or left unchecked, in a hand-in. */
  check: 500,
  /** How many checks a hand-in lists, of each kind. */
  checks: 30
} as const;

/** Text cut to `max` characters, saying how many were left out, for a brief or a log to show. */
export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)} … (${text.length - max} more characters)` : text;

/**
 * How much of an error's message a task event, a run event or a run's result keeps: enough to read
 * the cause, short of a whole response body a failed call can carry.
 */
export const ERROR_TEXT_MAX = 500;

/** An error's message as an event or a run's result records it, clipped to `ERROR_TEXT_MAX`. */
export const errorText = (error: unknown): string =>
  clip(error instanceof Error ? error.message : String(error), ERROR_TEXT_MAX);

/**
 * What the approval chooser's checklist for verification may hold: its items and the rows of its
 * before/after table. Posted together as one comment, they stay under GitHub's limit at these sizes.
 */
export const CHECKLIST_LIMITS = {
  /** How many items, and how long each. */
  items: 30,
  item: 300,
  /** How many before/after rows, and how long each cell. */
  rows: 30,
  row: { key: 120, locale: 35, before: 350, after: 350 }
} as const;

/** What a hand-in lists as checked or left unchecked, the same for a person and the builder. */
export const checksSchema = z
  .array(z.string().trim().min(1).max(INPUT_LIMITS.check))
  .max(INPUT_LIMITS.checks);

/** What every push hands back, the builder's and the onboarder's alike. */
export const pushedFields = {
  outcome: z.literal('pushed'),
  // A pattern, not a refinement, so the agent's tool schema shows it too.
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(new RegExp(`^${TASK_BRANCH_PREFIX}`), `branch must start with ${TASK_BRANCH_PREFIX}`),
  /** The pull request title, in the repository's required format. */
  prTitle: z.string().trim().min(1).max(INPUT_LIMITS.prTitle.max),
  prBody: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_LIMITS.prBody)
    .optional()
    .describe(
      "The pull request body, in Markdown, only when the brief names the project's pull request template, and then required: keep every heading of the template and fill each one. Officina adds the link to the task and the issue it closes after it."
    ),
  verified: checksSchema,
  notVerified: checksSchema
};
