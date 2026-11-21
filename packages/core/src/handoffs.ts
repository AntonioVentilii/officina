import { z } from 'zod';
import { HANDOFF_NEED_KEYS } from './handoff-needs';
import { routeHandoff } from './handoff-routes';
import { BUILD_MODES, type Command } from './lifecycle';

/**
 * The task needs something agents can neither do nor decide (`HANDOFF_NEEDS`). The engine routes it
 * by rule (`routeHandoff`); the agent says why and exactly what is needed.
 */
export const needsPersonSchema = z.strictObject({
  outcome: z.literal('needs_person'),
  needs: z.array(z.enum(HANDOFF_NEED_KEYS)).min(1),
  why: z.string().trim().min(1).max(1500),
  /** Each thing the person must provide or decide, one per line. */
  asks: z.array(z.string().trim().min(1).max(500)).min(1).max(8)
});

type NeedsPerson = z.infer<typeof needsPersonSchema>;

/**
 * A handoff to a person: a held task with what is needed, asked of whoever the needs call for. The
 * lifecycle routes it again against the project's members when it applies it.
 */
export const handoffCommand = (output: NeedsPerson): Command => ({
  type: 'block',
  question: `${output.why}\n\nNeeded:\n${output.asks.map((ask) => `- ${ask}`).join('\n')}`,
  ...routeHandoff(output.needs)
});

/** The chooser's choice at spec review: the build agent, or a person when agents should not. */
export const buildChoice = {
  /** Is it too big or too risky for the build agent? */
  build: z.enum(BUILD_MODES).default('agent'),
  /** Required with `build: person`: why a human developer must build it. */
  buildReason: z.string().trim().min(1).max(600).optional()
};

/** A plan that asks for a developer says why, so the people asked can read it. */
export const buildReasonGiven = (approval: { build: string; buildReason?: string | undefined }) =>
  approval.build !== 'person' || Boolean(approval.buildReason);

export const BUILD_REASON_MISSING: { message: string; path: PropertyKey[] } = {
  message: 'buildReason is required when build is person',
  path: ['buildReason']
};
