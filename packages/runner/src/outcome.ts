import { z } from 'zod';
import type { RunOutcome } from './run';

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
  z.object({ kind: z.literal('failed'), reason: z.string() })
]);

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
      return outcome.reason;
  }
};
