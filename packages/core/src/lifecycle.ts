import { describeUnlisted, unlistedFiles, type CatalogPages } from './catalogs';
import {
  isAgentDocsPath,
  isGate,
  type Gate,
  type Policy,
  type ProjectConfig,
  type Requirement
} from './config';
import {
  GUARD_LABELS,
  OWNER_GUARDS,
  guardsForHandoff,
  guardsForPaths,
  guardsInRequest,
  secretFiles,
  withGuards,
  type Guard
} from './guards';
import type { HandoffNeed } from './handoffs';
import { computeLane, redPaths, stricterLane, type Lane } from './lanes';
import { GATE_ACTIONS, PERMISSIONS, can, canAnswer, readsTask, type Action } from './permissions';
import {
  applicableRequirements,
  eligibleMembers,
  evaluatePolicy,
  policyContext,
  type Approval
} from './policies';
import type { QuestionOption } from './questions';
import type { ApproverRole, Member, Role } from './roles';

export const STAGES = [
  'request',
  'triage',
  'speccing',
  'spec_review',
  'ready',
  'building',
  'reviewing',
  'choosing',
  'verifying',
  'merging',
  'done',
  'declined',
  'cancelled'
] as const;
export type Stage = (typeof STAGES)[number];

export const TERMINAL_STAGES: ReadonlySet<Stage> = new Set(['done', 'declined', 'cancelled']);

export const AGENT_ROLES = [
  'interviewer',
  'spec',
  'builder',
  'reviewer_spec',
  'reviewer_correctness',
  'chooser',
  'learner',
  'onboarder'
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * A request people made, or the task that writes a project's agent docs. A project with an open
 * onboarding task gets no other build dispatched until it is done.
 */
export const TASK_KINDS = ['request', 'onboarding'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** The agent roles that change files on a task branch, one per kind of task. */
export const BUILD_ROLES = ['builder', 'onboarder'] as const;
export type BuildRole = (typeof BUILD_ROLES)[number];

export const isBuildRole = (role: string): role is BuildRole =>
  (BUILD_ROLES as readonly string[]).includes(role);

export const buildRoleFor = (kind: TaskKind): BuildRole =>
  kind === 'onboarding' ? 'onboarder' : 'builder';

/** Every one of these must approve the same head commit before a task leaves review. */
export const REVIEWER_ROLES = ['reviewer_spec', 'reviewer_correctness'] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export type Actor =
  | { readonly kind: 'member'; readonly memberId: string }
  | { readonly kind: 'agent'; readonly role: AgentRole; readonly version: number }
  | { readonly kind: 'engine' };

/** Officina itself acting: dispatching, recording GitHub events, blocking a failed step. */
export const ENGINE: Actor = { kind: 'engine' };

export type Assignee =
  | { readonly kind: 'member'; readonly memberId: string }
  | { readonly kind: 'agent'; readonly role: BuildRole };

export interface Blocked {
  readonly question: string;
  readonly askedOf: { readonly memberId: string } | { readonly role: Role };
  /** Set when agents cannot go on without something only a person can provide or decide. */
  readonly handoff?: { readonly needs: readonly HandoffNeed[] };
  /** Choices an agent offered, each with an optional preview; people may still answer freely. */
  readonly options?: readonly QuestionOption[];
}

export interface Task {
  readonly id: string;
  readonly kind: TaskKind;
  readonly requesterId: string;
  readonly stage: Stage;
  readonly lane: Lane | null;
  readonly specVersion: number;
  readonly headSha: string | null;
  readonly userVisible: boolean;
  readonly assignee: Assignee | null;
  readonly blocked: Blocked | null;
  readonly paused: boolean;
  /** Times work went back to building since the last dispatch. */
  readonly fixRounds: number;
  readonly reviews: Readonly<Partial<Record<ReviewerRole, 'approve'>>>;
  /** The approval chooser's decision for each human gate. */
  readonly approvalPlans: Readonly<Partial<Record<Gate, ApprovalPlan>>>;
  /** What the task touches that no agent may handle alone (`GUARDS`); set by rule, only grows. */
  readonly guards: readonly Guard[];
}

/** How closely people should check: a read, a hands-on test, or a test on a real device. */
export const CHECK_DEPTHS = ['glance', 'test', 'device'] as const;
export type CheckDepth = (typeof CHECK_DEPTHS)[number];

/**
 * Who merges a verified result: a person on GitHub, or GitHub's auto-merge once the branch rules
 * pass. The chooser decides per result; `auto` only takes effect when the project allows it.
 */
export const MERGE_MODES = ['person', 'auto'] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

/**
 * Who builds an approved spec: the build agent, or a person with the technical role who claims it,
 * when the work is too big or too risky for agents. The chooser decides at spec review.
 */
export const BUILD_MODES = ['agent', 'person'] as const;
export type BuildMode = (typeof BUILD_MODES)[number];

/** An approval the chooser adds to a gate on top of the lane policy. It can only add, never remove. */
export type ExtraRequirement = { readonly domain: string } | { readonly role: ApproverRole };

export interface ApprovalPlan {
  /** What the plan was made for: `spec:<version>` or `sha:<head commit>`. */
  readonly subject: string;
  readonly depth: CheckDepth;
  readonly rationale: string;
  readonly extra: readonly { readonly requirement: ExtraRequirement; readonly reason: string }[];
  /** People the chooser asks to verify; a request, not a requirement. */
  readonly verifiers: readonly { readonly memberId: string; readonly reason: string }[];
  /** Absent in plans made before the chooser decided it, which means `person`. */
  readonly merge?: MergeMode;
  /** At spec review: who builds it. Absent means the build agent. */
  readonly build?: BuildMode;
  /** Why a person must build it, for the people asked. */
  readonly buildReason?: string;
}

export type PlanInput = Omit<ApprovalPlan, 'subject'>;

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
  guards: []
});

/** What the real diff of a pushed head says, read from GitHub, never from an agent. */
export interface PushedHead {
  readonly headSha: string;
  readonly changedPaths: readonly string[];
  readonly addedPaths: readonly string[];
  /** The catalog pages the added files fall under, as pushed, for the catalog check. */
  readonly catalogPages: CatalogPages;
  readonly diffLines: number;
}

/** Where feedback left on GitHub came from: a review, or a comment on the pull request. */
export type GitHubFeedbackSource = { readonly reviewId: number } | { readonly commentId: number };

export type Command =
  | { readonly type: 'submit_request' }
  | { readonly type: 'accept' }
  | { readonly type: 'decline'; readonly reason: string }
  | {
      readonly type: 'post_spec';
      readonly predictedPaths: readonly string[];
      readonly userVisible: boolean;
    }
  | { readonly type: 'approve' }
  | { readonly type: 'request_changes'; readonly note: string }
  | {
      readonly type: 'dispatch';
      readonly assignee: Assignee;
      readonly openInLane: number;
    }
  | { readonly type: 'claim' }
  | { readonly type: 'release' }
  | ({ readonly type: 'push' } & PushedHead)
  /** The builder answered a GitHub review and found nothing to change, so the head stays. */
  | { readonly type: 'unchanged'; readonly note: string }
  | { readonly type: 'review'; readonly verdict: 'approve' | 'changes'; readonly notes: string }
  | { readonly type: 'plan_approval'; readonly userVisible: boolean; readonly plan: PlanInput }
  | { readonly type: 'choose'; readonly userVisible: boolean; readonly plan: PlanInput }
  | { readonly type: 'merged' }
  /** A check or a commit status failed on `headSha`, the task's head in its own terms. */
  | { readonly type: 'ci_failed'; readonly headSha: string; readonly details: string }
  /** The task's pull request was closed on GitHub without being merged. */
  | { readonly type: 'pull_request_closed'; readonly pullRequest: number }
  | {
      readonly type: 'github_review';
      readonly headSha: string;
      readonly by: string;
      readonly source: GitHubFeedbackSource;
      readonly notes: string;
      /** A bot review or comment that left nothing on the code, only its verdict and overview. */
      readonly overviewOnly: boolean;
    }
  /**
   * The task branch moved on GitHub to a head Officina did not push: a review bot's fix, a person's
   * commit, an update from the default branch. The new head is taken in like a build round's push.
   */
  | ({ readonly type: 'outside_push' } & PushedHead)
  | {
      readonly type: 'block';
      readonly question: string;
      readonly askedOf: Blocked['askedOf'];
      readonly handoff?: Blocked['handoff'];
      readonly options?: Blocked['options'];
    }
  | { readonly type: 'answer'; readonly text: string }
  /** A person's words on the task after its request, a comment: they guard it as the request's would. */
  | { readonly type: 'guard_words'; readonly text: string }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'cancel'; readonly reason: string };

/** `unlisted_files` sends the work back to its builder; the others hold it for a person. */
export type Guardrail =
  | 'red_paths'
  | 'secret_files'
  | 'outside_agent_docs'
  | 'diff_too_large'
  | 'unlisted_files'
  | 'fix_rounds_exhausted';

export type DomainEvent =
  | { readonly type: 'stage_changed'; readonly from: Stage; readonly to: Stage }
  | { readonly type: 'lane_changed'; readonly from: Lane | null; readonly to: Lane }
  | { readonly type: 'spec_versioned'; readonly version: number }
  | { readonly type: 'user_visible_changed'; readonly userVisible: boolean }
  | { readonly type: 'guards_changed'; readonly guards: readonly Guard[] }
  | {
      readonly type: 'approval_recorded';
      readonly gate: Gate;
      readonly subject: string;
      readonly memberId: string;
      readonly satisfied: boolean;
      readonly pending: readonly Requirement[];
      readonly waived: readonly Requirement[];
    }
  | { readonly type: 'changes_requested'; readonly stage: Stage; readonly note: string }
  | { readonly type: 'assigned'; readonly assignee: Assignee | null }
  | {
      readonly type: 'pushed';
      readonly headSha: string;
      readonly changedPaths: readonly string[];
      readonly diffLines: number;
      /** Pushed on GitHub by someone other than the task's builder. */
      readonly outside?: true;
    }
  | { readonly type: 'build_unchanged'; readonly headSha: string; readonly note: string }
  | {
      readonly type: 'review_recorded';
      /** `github` is a review left on the pull request, such as Copilot's, sent back to the builder. */
      readonly reviewer: ReviewerRole | 'member' | 'github';
      readonly verdict: 'approve' | 'changes';
      readonly notes: string;
      readonly by?: string;
      readonly githubReviewId?: number;
      readonly githubCommentId?: number;
      readonly overviewOnly?: boolean;
    }
  | { readonly type: 'guardrail_tripped'; readonly guardrail: Guardrail; readonly details: string }
  | { readonly type: 'ci_failed'; readonly headSha: string; readonly details: string }
  | { readonly type: 'pull_request_closed'; readonly pullRequest: number }
  | { readonly type: 'blocked'; readonly blocked: Blocked }
  | { readonly type: 'unblocked'; readonly answer: string }
  | { readonly type: 'paused' }
  | { readonly type: 'resumed' }
  | { readonly type: 'closed'; readonly stage: 'declined' | 'cancelled'; readonly reason: string }
  /** The result went to merge without a person's check; `subject` is the head it covers. */
  | { readonly type: 'auto_verified'; readonly subject: string }
  | {
      readonly type: 'approval_planned';
      readonly gate: Gate;
      readonly plan: ApprovalPlan;
      /** Requirements this plan added to the gate beyond the lane policy and earlier plans. */
      readonly added: readonly ExtraRequirement[];
    };

export type DecisionError =
  | 'terminal'
  | 'wrong_stage'
  | 'not_allowed'
  | 'agents_cannot_approve'
  | 'blocked'
  | 'paused'
  | 'already_blocked'
  | 'not_blocked'
  | 'already_paused'
  | 'not_paused'
  | 'no_lane'
  | 'no_head'
  | 'wip_limit'
  | 'agents_cannot_build_lane'
  | 'needs_developer'
  | 'not_planned'
  | 'stale_head'
  | 'awaiting_onboarding';

export type Decision =
  | { readonly ok: true; readonly task: Task; readonly events: readonly DomainEvent[] }
  | { readonly ok: false; readonly error: DecisionError };

export interface DecideContext {
  readonly config: ProjectConfig;
  readonly members: readonly Member[];
  /** Every approval already recorded on this task, for any subject. */
  readonly approvals: readonly Approval[];
  /**
   * The project has an onboarding task that is not done yet. The store reads it under the project
   * lock that opening one takes, so a dispatch and a new gate can never cross.
   */
  readonly onboardingOpen: boolean;
}

const fail = (error: DecisionError): Decision => ({ ok: false, error });

const ok = (task: Task, events: DomainEvent[]): Decision => ({ ok: true, task, events });

const moveTo = (task: Task, to: Stage, changes: Partial<Task> = {}): [Task, DomainEvent] => [
  { ...task, ...changes, stage: to },
  { type: 'stage_changed', from: task.stage, to }
];

const memberFor = (actor: Actor, context: DecideContext): Member | undefined =>
  actor.kind === 'member'
    ? context.members.find((member) => member.id === actor.memberId)
    : undefined;

/** Whether the actor is a member the permission matrix lets take the action. */
const memberCan = (actor: Actor, context: DecideContext, action: Action): boolean => {
  const member = memberFor(actor, context);
  return member !== undefined && can(member, action);
};

/**
 * Why a person must build this task instead of an agent: its lane forbids agents, or the chooser
 * asked for a human developer at spec review. `null` when agents may build it.
 */
export const humanBuildReason = (
  config: ProjectConfig,
  task: Pick<Task, 'lane' | 'approvalPlans'>
): string | null => {
  if (task.lane && !config.lanes[task.lane].agentsBuild)
    return `Agents may not build changes in the ${task.lane} lane.`;
  const plan = task.approvalPlans.spec_review;
  return plan?.build === 'person' ? (plan.buildReason ?? null) : null;
};

export const gateSubject = (
  task: Pick<Task, 'specVersion' | 'headSha'>,
  gate: Gate
): string | null =>
  gate === 'spec_review' ? `spec:${task.specVersion}` : task.headSha && `sha:${task.headSha}`;

/** The lane's policy for a gate plus whatever the approval chooser added to it. */
export const effectivePolicy = (
  config: ProjectConfig,
  task: Pick<Task, 'lane' | 'approvalPlans' | 'guards'>,
  gate: Gate
): Policy => [
  ...config.lanes[task.lane ?? 'standard'].approvals[gate],
  ...(task.approvalPlans[gate]?.extra.map((item) => item.requirement) ?? []),
  // Secrets, access and publishing always need whoever may `publish`, whatever the lane says.
  ...(needsOwner(task) ? [{ role: PERMISSIONS.publish }] : [])
];

/** Whether the task's guards call for the owner at both gates. */
export const needsOwner = (task: Pick<Task, 'guards'>): boolean =>
  task.guards.some((guard) => OWNER_GUARDS.has(guard));

/**
 * Whether the policy in force at a gate names a member: whatever they decide there would meet one
 * of its requirements, their own request included.
 */
const namedAt = (task: Task, context: DecideContext, gate: Gate, member: Member): boolean => {
  const eligibility = {
    ...policyContext(context.config, task, gate, { members: context.members, subject: '' }),
    selfApproval: true
  };
  return applicableRequirements(effectivePolicy(context.config, task, gate), task.userVisible).some(
    (requirement) => eligibleMembers(requirement, eligibility).some(({ id }) => id === member.id)
  );
};

/**
 * Whether a result may skip people's verification: only in a green lane that opts in, only when a
 * merge does not deploy to production, and only when the chooser saw no reason for anyone to look.
 * The chooser adding any approval, or asking for more than a glance, keeps the human gate.
 */
export const canAutoVerify = (
  config: ProjectConfig,
  task: Pick<Task, 'lane' | 'approvalPlans' | 'guards'>
): boolean => {
  const plan = task.approvalPlans.verifying;
  return (
    task.guards.length === 0 &&
    task.lane === 'green' &&
    config.lanes.green.autoVerify &&
    config.release.onMerge !== 'production' &&
    plan !== undefined &&
    plan.extra.length === 0 &&
    plan.depth === 'glance'
  );
};

const sameRequirement = (a: ExtraRequirement, b: ExtraRequirement) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Who builds only gets stricter too: once a spec plan asked for a person, agents never build it. */
const plannedBuild = (
  gate: Gate,
  input: PlanInput,
  earlier: ApprovalPlan | undefined
): Pick<ApprovalPlan, 'build' | 'buildReason'> => {
  const byPerson = input.build === 'person' ? input : earlier?.build === 'person' ? earlier : null;
  return gate === 'spec_review' && byPerson
    ? { build: 'person', buildReason: byPerson.buildReason ?? 'The chooser asked for a person.' }
    : { build: 'agent' };
};

/**
 * Records the chooser's plan for a gate. Requirements only accumulate across plans for the same
 * gate, so a later plan (after changes, or a manipulated one) can never lower the bar; people it
 * names must be contributors of the project.
 */
const withPlan = (
  task: Task,
  gate: Gate,
  subject: string,
  input: PlanInput,
  context: DecideContext
): [Partial<Task>, DomainEvent] => {
  const previous = task.approvalPlans[gate]?.extra ?? [];
  const extra = [...previous];
  const added: ExtraRequirement[] = [];
  for (const item of input.extra) {
    if (extra.some((existing) => sameRequirement(existing.requirement, item.requirement))) continue;
    extra.push(item);
    added.push(item.requirement);
  }
  const verifiers = input.verifiers.filter((verifier) => {
    const member = context.members.find((candidate) => candidate.id === verifier.memberId);
    return member !== undefined && can(member, GATE_ACTIONS[gate]);
  });
  // Like approvals, the merge only gets stricter: once a plan for this gate asked for a person, a
  // later plan cannot hand the merge back to GitHub. The spec gate has nothing to merge.
  // A plan without the field predates the choice and counts as `person`.
  const earlier = task.approvalPlans[gate];
  const merge: MergeMode =
    gate === 'verifying' &&
    input.merge === 'auto' &&
    (!earlier || earlier.merge === 'auto') &&
    task.guards.length === 0
      ? 'auto'
      : 'person';
  const plan: ApprovalPlan = {
    ...input,
    subject,
    extra,
    verifiers,
    merge,
    ...plannedBuild(gate, input, earlier)
  };
  return [
    { approvalPlans: { ...task.approvalPlans, [gate]: plan } },
    { type: 'approval_planned', gate, plan, added }
  ];
};

/** Whether a held question is the requester's own to answer. */
const isAskedOf = (blocked: Blocked, memberId: string): boolean =>
  'memberId' in blocked.askedOf && blocked.askedOf.memberId === memberId;

/** The task's guards once these are added, and the event when they grew. */
const withAdded = (task: Task, added: readonly Guard[]): [readonly Guard[], DomainEvent[]] => {
  const guards = withGuards(task.guards, added);
  return guards.length === task.guards.length
    ? [task.guards, []]
    : [guards, [{ type: 'guards_changed', guards }]];
};

/** The task's guards once these paths are counted, and the event when they grew. */
const guardedBy = (
  task: Task,
  context: DecideContext,
  paths: readonly string[]
): [readonly Guard[], DomainEvent[]] =>
  withAdded(task, guardsForPaths(context.config.guards, paths));

/**
 * The question a guarded request waits on, asked of whoever may `publish`. Submitting as is cannot
 * skip it; the owner answers, and the request goes on like any other, or cancels it.
 */
export const ownerHold = (guards: readonly Guard[]): Blocked => ({
  question: `This request is about ${guards.map((guard) => GUARD_LABELS[guard]).join(', ')}. Agents never reveal secrets or confidential content, and never publish, deploy or change access on their own. The owner decides: answer to let the work go on, or cancel it.`,
  askedOf: { role: PERMISSIONS.publish }
});

/** Whether a held question already waits on whoever may `publish`, who alone lifts a hold. */
const heldForOwner = (blocked: Blocked | null): boolean =>
  blocked !== null && 'role' in blocked.askedOf && blocked.askedOf.role === PERMISSIONS.publish;

/** The guards a person's words on a task call for, by the request's rule, that it lacks so far. */
export const guardsAddedBy = (
  task: Pick<Task, 'guards'>,
  config: Pick<ProjectConfig, 'guards'>,
  text: string
): Guard[] =>
  guardsInRequest(text, config.guards.confidentialTerms).filter(
    (guard) => !task.guards.includes(guard)
  );

/**
 * What a person's words on a task (an answer or a comment) guard. Words that add a guard from
 * someone who may not `publish` hold the task for the owner, as a guarded request is born held,
 * unless it already waits on the owner.
 */
const guardedByWords = (
  task: Task,
  context: DecideContext,
  member: Member,
  text: string
): [Task, DomainEvent[]] => {
  const added = guardsAddedBy(task, context.config, text);
  const [guards, events] = withAdded(task, added);
  if (!events.length) return [task, []];
  if (can(member, 'publish') || heldForOwner(task.blocked)) return [{ ...task, guards }, events];
  const blocked = ownerHold(added);
  return [{ ...task, guards, blocked }, [...events, { type: 'blocked', blocked }]];
};

/** Whether the actor is the one the task is assigned to, so it may report the build. */
const isAssignee = (assignee: Assignee, actor: Actor): boolean =>
  (assignee.kind === 'agent' && actor.kind === 'agent' && actor.role === assignee.role) ||
  (assignee.kind === 'member' && actor.kind === 'member' && actor.memberId === assignee.memberId);

/**
 * Sends work back to building. Once the lane's fix rounds are used up the task returns to `ready`
 * unassigned and asks a maintainer to decide, instead of looping between agents forever.
 */
const backToBuilding = (task: Task, context: DecideContext, ...why: DomainEvent[]): Decision => {
  const lane = task.lane ?? 'standard';
  const limit = context.config.lanes[lane].fixRounds;
  if (task.fixRounds >= limit) {
    const blocked: Blocked = {
      question: `Fix rounds exhausted (${limit}). Re-dispatch, claim the task, or cancel it.`,
      askedOf: { role: 'maintainer' }
    };
    const [moved, stageEvent] = moveTo(task, 'ready', {
      assignee: null,
      fixRounds: 0,
      reviews: {},
      blocked
    });
    return ok(moved, [
      ...why,
      {
        type: 'guardrail_tripped',
        guardrail: 'fix_rounds_exhausted',
        details: `limit ${limit}`
      },
      stageEvent,
      { type: 'assigned', assignee: null },
      { type: 'blocked', blocked }
    ]);
  }
  const [moved, stageEvent] = moveTo(task, 'building', {
    fixRounds: task.fixRounds + 1,
    reviews: {}
  });
  return ok(moved, [...why, stageEvent]);
};

const pushedEvent = (head: PushedHead): Extract<DomainEvent, { type: 'pushed' }> => ({
  type: 'pushed',
  headSha: head.headSha,
  changedPaths: head.changedPaths,
  diffLines: head.diffLines
});

/** A guardrail that holds a pushed head for a person, what it found, and whom it asks. */
interface Hold {
  readonly guardrail: Extract<Guardrail, 'secret_files' | 'red_paths' | 'outside_agent_docs'>;
  readonly found: readonly string[];
  readonly question: string;
  readonly askedOf: Role;
}

/**
 * The guardrail a pushed head trips that only a person can clear, if any. Secrets hold whoever
 * pushed; the paths an agent may not change, and the agent docs an onboarder must keep to, hold
 * while an agent carries the work on, since it is who would build on that head.
 */
const holdFor = (task: Task, head: PushedHead, context: DecideContext, lane: Lane): Hold | null => {
  // A secret committed to the branch must never reach a pull request people or bots read.
  const secrets = secretFiles(head.changedPaths);
  if (secrets.length)
    return {
      guardrail: 'secret_files',
      found: secrets,
      askedOf: 'owner',
      question: `The branch adds or changes files that hold secrets: ${secrets.join(', ')}. Remove them from the branch and its history, rotate anything exposed, then build again or cancel.`
    };
  if (task.assignee?.kind !== 'agent') return null;
  if (!context.config.lanes[lane].agentsBuild) {
    const touched = redPaths(head.changedPaths, context.config.laneMatcher);
    return {
      guardrail: 'red_paths',
      found: touched,
      askedOf: 'owner',
      question: `The branch changes paths an agent may not change: ${touched.join(', ')}. Claim the task or cancel it.`
    };
  }
  const outside =
    task.kind === 'onboarding'
      ? head.changedPaths.filter((path) => !isAgentDocsPath(context.config, path))
      : [];
  if (outside.length === 0) return null;
  return {
    guardrail: 'outside_agent_docs',
    found: outside,
    askedOf: 'maintainer',
    question: `The branch changes files outside the agent docs: ${outside.join(', ')}. Re-dispatch, claim the task, or cancel it.`
  };
};

/**
 * Takes a pushed head into a task that is building: the lane from the real diff (the stricter
 * one wins), then the guardrails, then review. The task's assignee decides which guardrails apply,
 * since it is who carries the work on: the paths an agent may not change, and the agent docs an
 * onboarder must keep to, hold for whoever pushed.
 */
const landPush = (
  task: Task,
  head: PushedHead,
  context: DecideContext,
  ...before: DomainEvent[]
): Decision => {
  const actual = computeLane(head.changedPaths, context.config.laneMatcher);
  const lane = stricterLane(task.lane ?? 'standard', actual);
  const [guards, guardEvents] = guardedBy(task, context, head.changedPaths);
  const pushed: DomainEvent[] = [...before];
  if (lane !== task.lane) pushed.push({ type: 'lane_changed', from: task.lane, to: lane });
  pushed.push(...guardEvents);
  task = { ...task, guards };

  const held = holdFor(task, head, context, lane);
  if (held) {
    const blocked: Blocked = { question: held.question, askedOf: { role: held.askedOf } };
    const [moved, stageEvent] = moveTo(task, 'ready', { lane, assignee: null, blocked });
    return ok(moved, [
      ...pushed,
      { type: 'guardrail_tripped', guardrail: held.guardrail, details: held.found.join(', ') },
      stageEvent,
      { type: 'assigned', assignee: null },
      { type: 'blocked', blocked }
    ]);
  }

  const maxLines = context.config.lanes[lane].diffLines;
  if (head.diffLines > maxLines) {
    const blocked: Blocked = {
      question: `The change has ${head.diffLines} lines, over the ${lane} lane limit of ${maxLines}. Split the spec or reduce the change.`,
      askedOf: { role: 'maintainer' }
    };
    return ok({ ...task, lane, blocked }, [
      ...pushed,
      {
        type: 'guardrail_tripped',
        guardrail: 'diff_too_large',
        details: `${head.diffLines} > ${maxLines}`
      },
      { type: 'blocked', blocked }
    ]);
  }

  // A new shared file nobody listed is the duplication of tomorrow: the builder lists it first.
  const unlisted = unlistedFiles(
    context.config.docs.standards.catalogs,
    head.addedPaths,
    head.catalogPages
  );
  if (unlisted.length) {
    return backToBuilding({ ...task, lane, headSha: head.headSha }, context, ...pushed, {
      type: 'guardrail_tripped',
      guardrail: 'unlisted_files',
      details: describeUnlisted(unlisted)
    });
  }

  const [moved, stageEvent] = moveTo(task, 'reviewing', {
    lane,
    headSha: head.headSha,
    reviews: {}
  });
  return ok(moved, [...pushed, stageEvent]);
};

/**
 * Stages where the pull request holds a head Officina took in, so feedback on it (a review, a
 * failed check, a push from outside) can still change the outcome.
 */
export const GITHUB_REVIEWABLE: ReadonlySet<Stage> = new Set([
  'reviewing',
  'choosing',
  'verifying',
  'merging'
]);

/** Stages where the task's pull request may exist: from the first push until it is merged. */
const WITH_PULL_REQUEST: ReadonlySet<Stage> = new Set(['building', ...GITHUB_REVIEWABLE]);

const ALLOWED_WHILE_HELD: ReadonlySet<Command['type']> = new Set([
  'submit_request',
  'answer',
  'guard_words',
  'resume',
  'cancel',
  'block',
  'pause',
  'pull_request_closed'
]);

export const decide = (
  task: Task,
  command: Command,
  actor: Actor,
  context: DecideContext
): Decision => {
  if (TERMINAL_STAGES.has(task.stage)) {
    return fail('terminal');
  }
  if (!ALLOWED_WHILE_HELD.has(command.type)) {
    if (task.blocked) return fail('blocked');
    if (task.paused) return fail('paused');
  }

  switch (command.type) {
    case 'submit_request': {
      if (task.stage !== 'request') return fail('wrong_stage');
      const member = memberFor(actor, context);
      // The interviewer submits a request once it is specific enough; people can submit it as is.
      const allowed =
        (actor.kind === 'agent' && actor.role === 'interviewer') ||
        (member !== undefined &&
          can(member, 'request') &&
          (member.id === task.requesterId || can(member, 'triage')));
      if (!allowed) return fail('not_allowed');
      if (task.paused) return fail('paused');
      // Only the interview's own question to the requester can be skipped; a hold for anyone else
      // (the owner, for a guarded request) stays until they answer.
      if (task.blocked && !isAskedOf(task.blocked, task.requesterId)) return fail('blocked');
      // Submitting as is closes an open interview question: triage decides with what is there.
      const [moved, event] = moveTo(task, 'triage', { blocked: null });
      const events: DomainEvent[] = task.blocked
        ? [{ type: 'unblocked', answer: '(submitted as is)' }, event]
        : [event];
      return ok(moved, events);
    }

    case 'accept': {
      if (task.stage !== 'triage') return fail('wrong_stage');
      if (!memberCan(actor, context, 'triage')) return fail('not_allowed');
      const [moved, event] = moveTo(task, 'speccing');
      return ok(moved, [event]);
    }

    case 'decline': {
      if (task.stage !== 'triage') return fail('wrong_stage');
      if (!memberCan(actor, context, 'triage')) return fail('not_allowed');
      const [moved, event] = moveTo(task, 'declined');
      return ok(moved, [event, { type: 'closed', stage: 'declined', reason: command.reason }]);
    }

    case 'post_spec': {
      if (task.stage !== 'speccing') return fail('wrong_stage');
      const allowed =
        (actor.kind === 'agent' && actor.role === 'spec') || memberCan(actor, context, 'request');
      if (!allowed) return fail('not_allowed');
      const predicted = computeLane(command.predictedPaths, context.config.laneMatcher);
      const lane = task.lane ? stricterLane(task.lane, predicted) : predicted;
      const specVersion = task.specVersion + 1;
      const userVisible = task.userVisible || command.userVisible;
      const [guards, guardEvents] = guardedBy(task, context, command.predictedPaths);
      const [moved, stageEvent] = moveTo(task, 'spec_review', {
        lane,
        specVersion,
        userVisible,
        guards
      });
      const events: DomainEvent[] = [{ type: 'spec_versioned', version: specVersion }];
      if (lane !== task.lane) events.push({ type: 'lane_changed', from: task.lane, to: lane });
      events.push(...guardEvents);
      if (userVisible !== task.userVisible)
        events.push({ type: 'user_visible_changed', userVisible });
      events.push(stageEvent);
      return ok(moved, events);
    }

    case 'approve': {
      if (!isGate(task.stage)) return fail('wrong_stage');
      if (actor.kind !== 'member') return fail('agents_cannot_approve');
      const member = memberFor(actor, context);
      const gate: Gate = task.stage;
      if (member === undefined || !can(member, GATE_ACTIONS[gate])) return fail('not_allowed');
      if (task.lane === null) return fail('no_lane');
      const subject = gateSubject(task, gate);
      if (subject === null) return fail('no_head');
      // Nobody can approve before the approval chooser has said who needs to.
      if (task.approvalPlans[gate]?.subject !== subject) return fail('not_planned');
      const approval: Approval = { memberId: member.id, subject };
      const result = evaluatePolicy(
        effectivePolicy(context.config, task, gate),
        [...context.approvals, approval],
        policyContext(context.config, task, gate, { members: context.members, subject })
      );
      const recorded: DomainEvent = {
        type: 'approval_recorded',
        gate,
        subject,
        memberId: member.id,
        satisfied: result.satisfied,
        pending: result.pending,
        waived: result.waived
      };
      if (!result.satisfied) return ok(task, [recorded]);
      const [moved, stageEvent] = moveTo(task, gate === 'spec_review' ? 'ready' : 'merging');
      return ok(moved, [recorded, stageEvent]);
    }

    case 'request_changes': {
      if (task.stage !== 'spec_review' && task.stage !== 'verifying') return fail('wrong_stage');
      const member = memberFor(actor, context);
      // Sending the work back is for the people the gate's policy names, as approving it is.
      if (member === undefined || !namedAt(task, context, task.stage, member))
        return fail('not_allowed');
      const why: DomainEvent = { type: 'changes_requested', stage: task.stage, note: command.note };
      if (task.stage === 'verifying') return backToBuilding(task, context, why);
      const [moved, stageEvent] = moveTo(task, 'speccing');
      return ok(moved, [why, stageEvent]);
    }

    case 'dispatch': {
      if (task.stage !== 'ready') return fail('wrong_stage');
      if (actor.kind !== 'engine') return fail('not_allowed');
      if (task.lane === null) return fail('no_lane');
      // Agents build in a project only once its agent docs exist, so they reuse what is there.
      if (task.kind === 'request' && context.onboardingOpen) return fail('awaiting_onboarding');
      const settings = context.config.lanes[task.lane];
      if (command.assignee.kind === 'agent') {
        if (command.assignee.role !== buildRoleFor(task.kind)) return fail('not_allowed');
        if (!settings.agentsBuild) return fail('agents_cannot_build_lane');
        if (humanBuildReason(context.config, task) !== null) return fail('needs_developer');
        if (command.openInLane >= settings.wip) return fail('wip_limit');
      } else {
        const assigneeId = command.assignee.memberId;
        const assignee = context.members.find((member) => member.id === assigneeId);
        if (assignee === undefined || !can(assignee, 'build')) {
          return fail('not_allowed');
        }
      }
      const [moved, stageEvent] = moveTo(task, 'building', { assignee: command.assignee });
      return ok(moved, [stageEvent, { type: 'assigned', assignee: command.assignee }]);
    }

    case 'claim': {
      const builder = memberFor(actor, context);
      // Nobody builds what they may not read.
      if (
        actor.kind !== 'member' ||
        !builder ||
        !can(builder, 'build') ||
        !readsTask(builder, task)
      )
        return fail('not_allowed');
      const assignee: Assignee = { kind: 'member', memberId: actor.memberId };
      if (task.stage === 'ready') {
        const [moved, stageEvent] = moveTo(task, 'building', { assignee });
        return ok(moved, [stageEvent, { type: 'assigned', assignee }]);
      }
      // Taking a build over from the agent is anyone's who may build; from another person, only
      // someone who may steer the work.
      if (task.stage === 'building') {
        if (task.assignee?.kind === 'member' && !memberCan(actor, context, 'steer'))
          return fail('not_allowed');
        return ok({ ...task, assignee }, [{ type: 'assigned', assignee }]);
      }
      return fail('wrong_stage');
    }

    case 'release': {
      if (task.stage !== 'building') return fail('wrong_stage');
      const isAssignee =
        actor.kind === 'member' &&
        task.assignee?.kind === 'member' &&
        task.assignee.memberId === actor.memberId;
      if (!isAssignee && !memberCan(actor, context, 'steer')) return fail('not_allowed');
      const [moved, stageEvent] = moveTo(task, 'ready', { assignee: null });
      return ok(moved, [stageEvent, { type: 'assigned', assignee: null }]);
    }

    case 'push': {
      if (task.stage !== 'building') return fail('wrong_stage');
      const assignee = task.assignee;
      if (assignee === null || !isAssignee(assignee, actor)) return fail('not_allowed');

      return landPush(task, command, context, pushedEvent(command));
    }

    case 'unchanged': {
      // Only a fix round has a head to keep; a first round that changes nothing has built nothing.
      if (task.stage !== 'building' || task.headSha === null) return fail('wrong_stage');
      if (task.assignee === null || !isAssignee(task.assignee, actor)) return fail('not_allowed');
      const [moved, stageEvent] = moveTo(task, 'reviewing', { reviews: {} });
      return ok(moved, [
        { type: 'build_unchanged', headSha: task.headSha, note: command.note },
        stageEvent
      ]);
    }

    case 'review': {
      if (task.stage !== 'reviewing') return fail('wrong_stage');
      let reviewer: ReviewerRole | 'member';
      if (actor.kind === 'agent' && (REVIEWER_ROLES as readonly string[]).includes(actor.role)) {
        reviewer = actor.role as ReviewerRole;
      } else if (memberCan(actor, context, 'steer')) {
        reviewer = 'member';
      } else {
        return fail('not_allowed');
      }
      const recorded: DomainEvent = {
        type: 'review_recorded',
        reviewer,
        verdict: command.verdict,
        notes: command.notes
      };
      if (command.verdict === 'changes') return backToBuilding(task, context, recorded);

      // A maintainer's own review stands in for the agent reviewers.
      const reviews =
        reviewer === 'member' ? task.reviews : { ...task.reviews, [reviewer]: 'approve' as const };
      const complete =
        reviewer === 'member' || REVIEWER_ROLES.every((role) => reviews[role] === 'approve');
      if (!complete) return ok({ ...task, reviews }, [recorded]);
      const [moved, stageEvent] = moveTo(task, 'choosing', { reviews });
      return ok(moved, [recorded, stageEvent]);
    }

    case 'choose': {
      if (task.stage !== 'choosing') return fail('wrong_stage');
      const isMaintainer = memberCan(actor, context, 'steer');
      const allowed =
        (actor.kind === 'agent' && actor.role === 'chooser') ||
        actor.kind === 'engine' ||
        isMaintainer;
      if (!allowed) return fail('not_allowed');
      // Only a maintainer may mark a change as not user-visible, since that can drop a required approval.
      const userVisible = isMaintainer
        ? command.userVisible
        : task.userVisible || command.userVisible;
      const subject = gateSubject(task, 'verifying');
      if (subject === null) return fail('no_head');
      const [planned, planEvent] = withPlan(task, 'verifying', subject, command.plan, context);
      const events: DomainEvent[] =
        userVisible !== task.userVisible ? [{ type: 'user_visible_changed', userVisible }] : [];
      if (canAutoVerify(context.config, { ...task, ...planned })) {
        const [moved, stageEvent] = moveTo(task, 'merging', { userVisible, ...planned });
        return ok(moved, [...events, planEvent, { type: 'auto_verified', subject }, stageEvent]);
      }
      const [moved, stageEvent] = moveTo(task, 'verifying', { userVisible, ...planned });
      return ok(moved, [...events, planEvent, stageEvent]);
    }

    case 'plan_approval': {
      if (task.stage !== 'spec_review') return fail('wrong_stage');
      const allowed =
        (actor.kind === 'agent' && actor.role === 'chooser') || actor.kind === 'engine';
      if (!allowed) return fail('not_allowed');
      const subject = gateSubject(task, 'spec_review');
      if (subject === null) return fail('no_head');
      const userVisible = task.userVisible || command.userVisible;
      const [planned, planEvent] = withPlan(task, 'spec_review', subject, command.plan, context);
      const events: DomainEvent[] =
        userVisible !== task.userVisible ? [{ type: 'user_visible_changed', userVisible }] : [];
      return ok({ ...task, ...planned, userVisible }, [...events, planEvent]);
    }

    case 'merged': {
      if (task.stage !== 'merging') return fail('wrong_stage');
      if (actor.kind !== 'engine') return fail('not_allowed');
      const [moved, event] = moveTo(task, 'done');
      return ok(moved, [event]);
    }

    case 'ci_failed': {
      // Before merging too: nobody should review, plan or verify a head whose checks are red.
      if (!GITHUB_REVIEWABLE.has(task.stage)) return fail('wrong_stage');
      if (actor.kind !== 'engine') return fail('not_allowed');
      if (command.headSha !== task.headSha) return fail('stale_head');
      return backToBuilding(task, context, {
        type: 'ci_failed',
        headSha: command.headSha,
        details: command.details
      });
    }

    case 'pull_request_closed': {
      if (actor.kind !== 'engine') return fail('not_allowed');
      if (task.headSha === null || !WITH_PULL_REQUEST.has(task.stage)) return fail('wrong_stage');
      // The work on GitHub is gone, so the task cannot wait for it: it goes back to the start of
      // the build, held for a person, who rebuilds it (a new pull request opens on the next push)
      // or cancels it. An onboarding task left here would otherwise hold the project forever.
      const blocked: Blocked = {
        question: `Pull request #${command.pullRequest} was closed without being merged. Answer to build the change again on a new pull request, or cancel the task.`,
        askedOf: { role: 'maintainer' }
      };
      const [moved, stageEvent] = moveTo(task, 'ready', {
        assignee: null,
        headSha: null,
        fixRounds: 0,
        reviews: {},
        blocked
      });
      return ok(moved, [
        { type: 'pull_request_closed', pullRequest: command.pullRequest },
        stageEvent,
        { type: 'assigned', assignee: null },
        { type: 'blocked', blocked }
      ]);
    }

    case 'github_review': {
      if (!GITHUB_REVIEWABLE.has(task.stage)) return fail('wrong_stage');
      if (actor.kind !== 'engine') return fail('not_allowed');
      // A review of an earlier head was about code that is no longer there.
      if (command.headSha !== task.headSha) return fail('stale_head');
      return backToBuilding(task, context, {
        type: 'review_recorded',
        reviewer: 'github',
        verdict: 'changes',
        notes: command.notes,
        by: command.by,
        ...('reviewId' in command.source
          ? { githubReviewId: command.source.reviewId }
          : { githubCommentId: command.source.commentId }),
        overviewOnly: command.overviewOnly
      });
    }

    case 'outside_push': {
      if (!GITHUB_REVIEWABLE.has(task.stage)) return fail('wrong_stage');
      if (actor.kind !== 'engine') return fail('not_allowed');
      if (command.headSha === task.headSha) return fail('stale_head');
      // Back to the build stage first, so the new head goes through the same checks as the
      // builder's own push; reviews, plans and approvals of the old head no longer stand for it.
      const [building, stageEvent] = moveTo(task, 'building');
      return landPush(building, command, context, stageEvent, {
        ...pushedEvent(command),
        outside: true
      });
    }

    case 'block': {
      if (task.blocked) return fail('already_blocked');
      const allowed = actor.kind !== 'member' || memberCan(actor, context, 'comment');
      if (!allowed) return fail('not_allowed');
      // A handoff is engine-routed from agent output; a person's own question is a plain one.
      const handoff = actor.kind === 'member' ? undefined : command.handoff;
      const blocked: Blocked = {
        question: command.question,
        askedOf: command.askedOf,
        ...(handoff ? { handoff } : {}),
        ...(command.options?.length ? { options: command.options } : {})
      };
      // Needing a secret, access or publishing guards the task as asking for it would.
      const [guards, guardEvents] = withAdded(task, guardsForHandoff(handoff?.needs ?? []));
      return ok({ ...task, blocked, guards }, [...guardEvents, { type: 'blocked', blocked }]);
    }

    case 'answer': {
      if (!task.blocked) return fail('not_blocked');
      const member = memberFor(actor, context);
      if (member === undefined || !canAnswer(member, task.blocked.askedOf))
        return fail('not_allowed');
      // An answer is written in the thread, and nobody writes where they may not read.
      if (!readsTask(member, task)) return fail('not_allowed');
      const [answered, guardEvents] = guardedByWords(
        { ...task, blocked: null },
        context,
        member,
        command.text
      );
      return ok(answered, [{ type: 'unblocked', answer: command.text }, ...guardEvents]);
    }

    case 'guard_words': {
      const member = memberFor(actor, context);
      if (member === undefined || !can(member, 'comment') || !readsTask(member, task))
        return fail('not_allowed');
      const [guarded, events] = guardedByWords(task, context, member, command.text);
      return ok(guarded, events);
    }

    case 'pause': {
      if (!memberCan(actor, context, 'steer')) return fail('not_allowed');
      if (task.paused) return fail('already_paused');
      return ok({ ...task, paused: true }, [{ type: 'paused' }]);
    }

    case 'resume': {
      if (!memberCan(actor, context, 'steer')) return fail('not_allowed');
      if (!task.paused) return fail('not_paused');
      return ok({ ...task, paused: false }, [{ type: 'resumed' }]);
    }

    case 'cancel': {
      const member = memberFor(actor, context);
      // The engine closes an onboarding task itself once every page it would write is on the
      // default branch; every other cancellation is a person's decision.
      const allowed =
        (actor.kind === 'engine' && task.kind === 'onboarding') ||
        (member !== undefined &&
          (can(member, 'steer') || (member.id === task.requesterId && can(member, 'request'))));
      if (!allowed) return fail('not_allowed');
      const [moved, event] = moveTo(task, 'cancelled', { assignee: null, blocked: null });
      return ok(moved, [event, { type: 'closed', stage: 'cancelled', reason: command.reason }]);
    }
  }
};
