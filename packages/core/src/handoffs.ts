import { z } from 'zod';
import type { Command } from './lifecycle';
import type { Role } from './roles';

/**
 * What agents can neither do nor decide, and who in the project provides it. An agent that needs
 * one of these says so with the `needs_person` outcome instead of guessing or stalling, and the
 * engine, not the agent, decides who it goes to: the most senior role any of the needs asks for.
 */
export const HANDOFF_NEEDS = {
  infrastructure: { label: 'new infrastructure or a new service', askedOf: 'maintainer' },
  tooling: { label: "something the agents' tools cannot do", askedOf: 'maintainer' },
  secrets: { label: 'a secret, a credential or an environment value', askedOf: 'owner' },
  dns: { label: 'a domain or a DNS change', askedOf: 'owner' },
  hosting: { label: 'a new host or deployment target', askedOf: 'owner' },
  account: { label: 'an account with a third-party service', askedOf: 'owner' },
  access: { label: 'access for someone, or a change to who can see something', askedOf: 'owner' },
  publishing: { label: 'publishing or exposing content somewhere new', askedOf: 'owner' },
  decision: { label: 'a business or product decision only the owner can take', askedOf: 'owner' }
} as const satisfies Record<
  string,
  { label: string; askedOf: Extract<Role, 'maintainer' | 'owner'> }
>;

export type HandoffNeed = keyof typeof HANDOFF_NEEDS;

export const HANDOFF_NEED_KEYS = Object.keys(HANDOFF_NEEDS) as [HandoffNeed, ...HandoffNeed[]];

/** Who a handoff goes to: the owner when any need is the owner's, a maintainer otherwise. */
export const handoffAskedOf = (needs: readonly HandoffNeed[]): 'maintainer' | 'owner' =>
  needs.some((need) => HANDOFF_NEEDS[need].askedOf === 'owner') ? 'owner' : 'maintainer';

/**
 * The task needs something agents can neither do nor decide (`HANDOFF_NEEDS`). The engine routes it
 * to the owner or a maintainer by rule; the agent says why and exactly what is needed.
 */
export const needsPersonSchema = z.strictObject({
  outcome: z.literal('needs_person'),
  needs: z.array(z.enum(HANDOFF_NEED_KEYS)).min(1),
  why: z.string().trim().min(1).max(1500),
  /** Each thing the person must provide or decide, one per line. */
  asks: z.array(z.string().trim().min(1).max(500)).min(1).max(8)
});

type NeedsPerson = z.infer<typeof needsPersonSchema>;

/** A handoff to a person: a held task with what is needed, asked of the role the needs call for. */
export const handoffCommand = (output: NeedsPerson): Command => ({
  type: 'block',
  question: `${output.why}\n\nNeeded:\n${output.asks.map((ask) => `- ${ask}`).join('\n')}`,
  askedOf: { role: handoffAskedOf(output.needs) },
  handoff: { needs: [...new Set(output.needs)] }
});
