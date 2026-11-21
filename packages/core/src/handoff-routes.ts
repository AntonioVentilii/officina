import { HANDOFF_NEEDS, type HandoffNeed } from './handoff-needs';
import type { Blocked, QuestionTarget, Task } from './lifecycle';
import { isAskedOf, takesQuestion } from './permissions';
import { hasRole, type ApproverRole, type Member } from './roles';

/** The needs of a handoff that go to one target, and who answered them once someone has. */
export interface HandoffPart {
  readonly askedOf: QuestionTarget;
  readonly needs: readonly HandoffNeed[];
  readonly answeredBy?: string;
}

/** Whether someone in the project could take a question asked of a domain's holders. */
type HoldsDomain = (domain: string) => boolean;

/** Before the members are known, as the agent's result is read, every domain counts as held. */
const EVERY_DOMAIN_HELD: HoldsDomain = () => true;

/** The targets a question waits on: its one target, or each of a handoff's parts'. */
export const targetsOf = (askedOf: Blocked['askedOf']): readonly QuestionTarget[] =>
  'anyOf' in askedOf ? askedOf.anyOf : [askedOf];

/** One target for one or several: itself, or any of them. */
const askedOfAll = (targets: readonly QuestionTarget[]): Blocked['askedOf'] => {
  const [only, ...more] = targets;
  return only && more.length === 0 ? only : { anyOf: targets };
};

/** Where one need goes: its role or its domain, and the owner when nobody can take its domain. */
const needTarget = (need: HandoffNeed, holds: HoldsDomain): QuestionTarget => {
  const target: QuestionTarget = HANDOFF_NEEDS[need].askedOf;
  return 'domain' in target && !holds(target.domain) ? { role: 'owner' } : target;
};

/**
 * The needs grouped by who they go to: every need for a role in one part, asked of the owner when
 * any of them is the owner's and of a maintainer otherwise, and one part for each domain.
 */
const handoffParts = (needs: readonly HandoffNeed[], holds: HoldsDomain): HandoffPart[] => {
  const routed = needs.map((need) => ({ need, target: needTarget(need, holds) }));
  const byRole = routed.flatMap(({ need, target }) => ('role' in target ? [{ need, target }] : []));
  const domains = new Map<string, HandoffNeed[]>();
  for (const { need, target } of routed)
    if ('domain' in target)
      domains.set(target.domain, [...(domains.get(target.domain) ?? []), need]);
  const role: ApproverRole = byRole.some(({ target }) => target.role === 'owner')
    ? 'owner'
    : 'maintainer';
  return [
    ...(byRole.length ? [{ askedOf: { role }, needs: byRole.map(({ need }) => need) }] : []),
    ...[...domains].map(([domain, domainNeeds]) => ({ askedOf: { domain }, needs: domainNeeds }))
  ];
};

/**
 * Who a handoff's question waits on, and the handoff it records. Needs that go to different people
 * become parts, each answered by its own people, and the question waits on any of them.
 */
export const routeHandoff = (
  needs: readonly HandoffNeed[],
  holds: HoldsDomain = EVERY_DOMAIN_HELD
): { askedOf: Blocked['askedOf']; handoff: NonNullable<Blocked['handoff']> } => {
  const unique = [...new Set(needs)];
  const parts = handoffParts(unique, holds);
  return {
    askedOf: askedOfAll(parts.map((part) => part.askedOf)),
    handoff: parts.length > 1 ? { needs: unique, parts } : { needs: unique }
  };
};

/** Whether a member who could take the task's question holds the domain. */
export const domainHolders =
  (members: readonly Member[], task: Pick<Task, 'guards'>): HoldsDomain =>
  (domain) =>
    members.some((member) => member.domains.includes(domain) && takesQuestion(member, task));

/**
 * Who a question still waits on, and for which needs: each part of a handoff not answered yet, or
 * the whole question as one.
 */
export const openParts = (
  blocked: Blocked
): readonly { readonly askedOf: Blocked['askedOf']; readonly needs: readonly HandoffNeed[] }[] =>
  blocked.handoff?.parts?.filter((part) => part.answeredBy === undefined) ?? [
    { askedOf: blocked.askedOf, needs: blocked.handoff?.needs ?? [] }
  ];

/**
 * The question once this member answers the parts asked of them, while other parts still wait;
 * `null` when nothing would be left open, so the answer closes the question. An owner, who may
 * answer any question, answers every part.
 */
export const answeredPart = (
  blocked: Blocked,
  member: Member
): { readonly blocked: Blocked; readonly needs: readonly HandoffNeed[] } | null => {
  const handoff = blocked.handoff;
  if (!handoff?.parts || hasRole(member, 'owner')) return null;
  const open = handoff.parts.filter((part) => part.answeredBy === undefined);
  const theirs = open.filter((part) => isAskedOf(member, part.askedOf));
  const left = open.filter((part) => !theirs.includes(part));
  if (!left.length || !theirs.length) return null;
  const parts = handoff.parts.map((part) =>
    theirs.includes(part) ? { ...part, answeredBy: member.id } : part
  );
  return {
    blocked: {
      ...blocked,
      askedOf: askedOfAll(left.map((part) => part.askedOf)),
      handoff: { ...handoff, parts }
    },
    needs: theirs.flatMap((part) => part.needs)
  };
};

/** The question as one, asked as a whole: the parts it had are dropped, its needs kept. */
export const asOneQuestion = (blocked: Blocked, askedOf: Blocked['askedOf']): Blocked => ({
  ...blocked,
  askedOf,
  ...(blocked.handoff ? { handoff: { needs: blocked.handoff.needs } } : {})
});
