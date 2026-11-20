import { z } from 'zod';
import type { RunOutcome, SessionError } from './run';

/** How a run ended when it left no result to apply. */
export type UnfinishedOutcome = Exclude<RunOutcome, { kind: 'result' }>;

/**
 * An unfinished outcome read back from a run's recorded result, which holds it as it was when the
 * step failed the run.
 */
export const unfinishedOutcomeSchema: z.ZodType<UnfinishedOutcome> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invalid_result'), errors: z.array(z.string()) }),
  z.object({ kind: z.literal('no_result') }),
  z.object({ kind: z.literal('budget_reached') }),
  z.object({
    kind: z.literal('failed'),
    reason: z.string(),
    error: z.object({ type: z.string(), message: z.string() }).exactOptional()
  })
]);

/** The words of Anthropic's error when the workspace reaches the spend limit set in the Console. */
const SPEND_LIMIT = /usage limits?/i;
/** When that error says access returns: "You will regain access on 2026-12-01 at 00:00 UTC." */
const ACCESS_RETURNS = /regain access on ([^.]+)/i;

/** What a session's error means for a maintainer, when it is one that retrying cannot fix. */
const errorMeaning = (error: SessionError): string | null => {
  if (SPEND_LIMIT.test(error.message)) {
    const returns = ACCESS_RETURNS.exec(error.message)?.[1]?.trim();
    const until = returns
      ? `access returns on ${returns} or the limit is raised`
      : 'the limit is raised';
    return `the Anthropic workspace reached its API spend limit, so retrying will not help until ${until} in the Anthropic Console`;
  }
  if (error.type === 'billing_error') {
    return 'the Anthropic workspace cannot make model requests, so retrying will not help until its billing is resolved in the Anthropic Console';
  }
  return null;
};

/** A failure in words, with the error the session reported last when it reported one. */
const describeFailure = (reason: string, error: SessionError | undefined): string => {
  if (!error) return reason;
  const reported = `${reason} after this error (${error.type}): "${error.message}"`;
  const meaning = errorMeaning(error);
  return meaning ? `${meaning}; ${reported}` : reported;
};

/** Why a run left no result, in the words the question to a maintainer and the task views use. */
export const describeOutcome = (outcome: UnfinishedOutcome): string => {
  switch (outcome.kind) {
    case 'invalid_result':
      return `its result did not match the contract: ${outcome.errors.join('; ')}`;
    case 'no_result':
      return 'it finished without submitting a result';
    case 'budget_reached':
      return 'it reached the spending limit for this step';
    case 'failed':
      return describeFailure(outcome.reason, outcome.error);
  }
};
