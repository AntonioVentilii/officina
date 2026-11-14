import { z } from 'zod';

/**
 * How long each field a person or an agent hands in may be, in characters, and how many items a
 * list may hold. The board's API, the Claude connector and the agent contracts all read them here,
 * so a request typed on the board and the same request sent through Claude are held to one rule.
 */
export const INPUT_LIMITS = {
  /** A task's title. */
  title: { min: 3, max: 200 },
  /** What a person asks for when they open a request. */
  request: 20_000,
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
  /** One thing checked, or left unchecked, in a hand-in. */
  check: 500,
  /** How many checks a hand-in lists, of each kind. */
  checks: 30
} as const;

/** What a hand-in lists as checked or left unchecked, the same for a person and the builder. */
export const checksSchema = z
  .array(z.string().trim().min(1).max(INPUT_LIMITS.check))
  .max(INPUT_LIMITS.checks);
