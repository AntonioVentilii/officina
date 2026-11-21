import type { ApproverRole } from './roles';

/** The members a need goes to: whoever holds a role or above, or whoever holds an approval domain. */
type NeedTarget = { readonly role: ApproverRole } | { readonly domain: string };

/**
 * What agents can neither do nor decide, and who in the project provides it. An agent that needs
 * one of these says so with the `needs_person` outcome instead of guessing or stalling, and the
 * engine, not the agent, decides who it goes to (`routeHandoff`): what needs a role goes to the most
 * senior role any of them asks for, and a business or product decision to the members who hold the
 * `product` domain, or to the owner when nobody who may answer it does.
 */
export const HANDOFF_NEEDS = {
  infrastructure: { label: 'new infrastructure or a new service', askedOf: { role: 'maintainer' } },
  tooling: { label: "something the agents' tools cannot do", askedOf: { role: 'maintainer' } },
  secrets: { label: 'a secret, a credential or an environment value', askedOf: { role: 'owner' } },
  dns: { label: 'a domain or a DNS change', askedOf: { role: 'owner' } },
  hosting: { label: 'a new host or deployment target', askedOf: { role: 'owner' } },
  account: { label: 'an account with a third-party service', askedOf: { role: 'owner' } },
  access: {
    label: 'access for someone, or a change to who can see something',
    askedOf: { role: 'owner' }
  },
  publishing: { label: 'publishing or exposing content somewhere new', askedOf: { role: 'owner' } },
  decision: { label: 'a business or product decision', askedOf: { domain: 'product' } }
} as const satisfies Record<string, { label: string; askedOf: NeedTarget }>;

export type HandoffNeed = keyof typeof HANDOFF_NEEDS;

export const HANDOFF_NEED_KEYS = Object.keys(HANDOFF_NEEDS) as [HandoffNeed, ...HandoffNeed[]];
