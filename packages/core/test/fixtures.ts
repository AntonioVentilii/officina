import {
  decide,
  parseProjectConfigYaml,
  type Actor,
  type AgentRole,
  type Approval,
  type Command,
  type DecideContext,
  type Decision,
  type DomainEvent,
  type Member,
  type PlanInput,
  type ProjectConfig,
  type Task,
  type TaskKind
} from '../src';

/** A task as a request opens it, before anyone acts on it. */
export const newTask = (id: string, requesterId: string, kind: TaskKind = 'request'): Task => ({
  id,
  kind,
  requesterId,
  stage: 'request',
  lane: null,
  specVersion: 0,
  headSha: null,
  userVisible: false,
  assignee: null,
  blocked: null,
  paused: false,
  fixRounds: 0,
  reviews: {},
  approvalPlans: {},
  guards: [],
  diffAllowance: null,
  splitProposed: false
});

export const CONFIG_YAML = `
version: 1
docs: { entry: AGENTS.md }
lanes:
  red:
    paths: ['src/satellite/**', '.github/**']
  green:
    paths: ['src/lib/constants/messages/**']
    approvals:
      spec_review: [{ requester: true }, { domain: product }]
      verifying: [{ requester: true }]
  standard:
    approvals:
      spec_review: [{ role: owner }]
      verifying: [{ domain: product, when: user_visible }, { role: owner }]
`;

export const loadConfig = (yaml = CONFIG_YAML): ProjectConfig => {
  const result = parseProjectConfigYaml(yaml);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.config;
};

export const owner: Member = { id: 'antonio', role: 'owner', domains: [] };
export const productContributor: Member = { id: 'gio', role: 'contributor', domains: ['product'] };
export const watcher: Member = { id: 'visitor', role: 'watcher', domains: [] };

export const asMember = (member: Member): Actor => ({ kind: 'member', memberId: member.id });
export const asAgent = (role: AgentRole): Actor => ({ kind: 'agent', role, version: 1 });
export const engine: Actor = { kind: 'engine' };

/** A plain approval plan that adds nothing, for tests about other rules. */
export const PLAN: PlanInput = {
  depth: 'test',
  rationale: 'Ordinary change.',
  extra: [],
  verifiers: []
};

/** Applies commands like the engine will: approvals recorded by earlier decisions feed later ones. */
export const createDriver = (
  members: readonly Member[],
  config = loadConfig(),
  facts: Partial<Pick<DecideContext, 'onboardingOpen' | 'buildWait'>> = {}
) => {
  const approvals: Approval[] = [];
  let lastEvents: readonly DomainEvent[] = [];

  const attempt = (task: Task, command: Command, actor: Actor): Decision =>
    decide(task, command, actor, {
      config,
      members,
      approvals,
      onboardingOpen: facts.onboardingOpen ?? false,
      buildWait: facts.buildWait ?? null
    });

  const step = (task: Task, command: Command, actor: Actor): Task => {
    const decision = attempt(task, command, actor);
    if (!decision.ok) throw new Error(`${command.type} rejected: ${decision.error}`);
    for (const event of decision.events) {
      if (event.type === 'approval_recorded') {
        approvals.push({ memberId: event.memberId, subject: event.subject });
      }
    }
    lastEvents = decision.events;
    return decision.task;
  };

  return { attempt, step, events: () => lastEvents, config };
};
