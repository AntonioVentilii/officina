import {
  APPROVAL_FLOOR,
  CHECK_CHANNEL_LABELS,
  GATE_ACTIONS,
  GUARD_LABELS,
  HANDOFF_NEEDS,
  REVIEWER_ROLES,
  TERMINAL_STAGES,
  applicableRequirements,
  branchForTask,
  buildsTask,
  can,
  canAnswer,
  canRequestChanges,
  canSubmitRequest,
  clip,
  connectionRef,
  effectivePolicy,
  eligibleMembers,
  evaluatePolicy,
  gateSubject,
  humanBuildReason,
  isGate,
  openProposals,
  optionKey,
  outranks,
  parseProjectConfig,
  policyContext,
  readsTask,
  sameRequirement,
  seesQuestion,
  type Actor,
  type ConnectedApp,
  type AgentRole,
  type Approval,
  type ApprovalPlan,
  type Blocked,
  type Gate,
  type Eligibility,
  type Member,
  type Policy,
  type ProjectConfig,
  type Requirement,
  type Role,
  type Task
} from '@officina/core';
import {
  domainEventOf,
  latestChooserResult,
  listApprovedSubjects,
  listProposalHistory,
  listBoardTasks,
  listLearnings,
  listProjectMembers,
  listProjectRuns,
  listRunEvents,
  listSpecVersions,
  listTaskComments,
  listTaskEvents,
  listTaskRuns,
  loadBoardTask,
  loadTaskContext,
  openOnboardingTask,
  memberNames,
  stillRunning,
  type BoardTaskRow,
  type LearningRow,
  type RunEventRow,
  type RunRow,
  type TaskEventRow,
  loadProjectConfig
} from '@officina/db';
import { checklistView, type ChosenChecklist } from './checklist-view';
import type { Pool } from 'pg';

/** Who or what the task waits on right now, from the viewer's point of view. */
export interface WaitingOn {
  readonly kind: 'agent' | 'people' | 'github' | 'nobody';
  readonly label: string;
  /** The viewer can move the task on. */
  readonly me: boolean;
}

export type BoardAction =
  | 'submit'
  | 'accept'
  | 'decline'
  | 'claim'
  | 'hand_in'
  | 'hand_back'
  | 'approve'
  | 'changes'
  | 'answer'
  | 'cancel'
  | 'comment';

export interface BoardViewer {
  readonly memberId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly role: Role;
  readonly domains: readonly string[];
}

const ROLE_LABELS: Record<AgentRole, string> = {
  interviewer: 'Interviewer',
  spec: 'Spec writer',
  builder: 'Builder',
  reviewer_spec: 'Spec reviewer',
  reviewer_correctness: 'Code reviewer',
  chooser: 'Approval chooser',
  learner: 'Learner',
  onboarder: 'Onboarder'
};

export const roleLabel = (role: string) => ROLE_LABELS[role as AgentRole] ?? role;

/** Every agent role's name, for the board surfaces that show a role without a run. */
export const roleLabels = (): Readonly<Record<AgentRole, string>> => ROLE_LABELS;

/** The roles the Agents page lists, in its order, with what each one does. */
const AGENTS_PAGE: readonly { readonly role: AgentRole; readonly does: string }[] = [
  { role: 'spec', does: 'Reads the repo and writes a spec in its template' },
  { role: 'builder', does: 'Implements the approved spec on the task branch' },
  { role: 'reviewer_spec', does: 'Checks the diff does what the spec says, no more' },
  { role: 'reviewer_correctness', does: 'Checks correctness and project conventions' },
  { role: 'chooser', does: 'Decides who approves and how closely; can only raise the bar' },
  { role: 'onboarder', does: "Writes a new project's agent docs before anything else is built" }
];

const costOf = (runs: readonly RunView[]) =>
  runs.reduce((sum, run) => sum + (run.costCents ?? 0), 0);

/** The share of a role's finished runs that succeeded, in percent; none before one finishes. */
const successRate = (runs: readonly RunView[]) => {
  const finished = runs.filter((run) => run.status === 'succeeded' || run.status === 'failed');
  const succeeded = finished.filter((run) => run.status === 'succeeded').length;
  return finished.length ? Math.round((succeeded / finished.length) * 100) : null;
};

/** The Agents page: each role it lists with its numbers over the runs the page shows, and their cost. */
export const agentsView = (runs: readonly RunView[]) => ({
  agents: AGENTS_PAGE.map(({ role, does }) => {
    const own = runs.filter((run) => run.role === role);
    return {
      role,
      label: roleLabel(role),
      does,
      running: own.some(stillRunning),
      runs: own.length,
      success: successRate(own),
      costCents: costOf(own)
    };
  }),
  costCents: costOf(runs)
});

const article = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

/**
 * A requirement adds nothing to read when one it is outranked by is pending too, since that
 * approval meets both: the maintainer floor folds into an owner requirement.
 */
const readable = (pending: readonly Requirement[]) =>
  pending.filter((requirement) => !pending.some((other) => outranks(other, requirement)));

export const describeRequirement = (requirement: Requirement): string =>
  'role' in requirement
    ? article(requirement.role)
    : 'domain' in requirement
      ? article(`${requirement.domain} approver`)
      : 'the requester';

export const actorLabel = (actor: Actor, names: ReadonlyMap<string, string>): string =>
  actor.kind === 'member'
    ? (names.get(actor.memberId) ?? 'a former member')
    : actor.kind === 'agent'
      ? roleLabel(actor.role)
      : 'Officina';

/**
 * The connected app a member acted through, by the name it registered under (unverified) and its
 * connection as `/connect` lists it, so the trail tells an action from Claude from a click on the
 * board, and one app from another; null for everything else.
 */
const appView = (via: ConnectedApp) => ({
  id: via.grantId,
  label: CHECK_CHANNEL_LABELS.claude,
  client: via.name,
  connection: connectionRef(via.grantId)
});

const viaView = (actor: Actor) =>
  actor.kind === 'member' && actor.via ? appView(actor.via) : null;

const viewerMember = (viewer: BoardViewer): Member => ({
  id: viewer.memberId,
  role: viewer.role,
  domains: viewer.domains
});

/**
 * Who sees how the work is done: agent runs and their logs (which quote the code), costs and
 * learnings. Maintainers and owners look after the work; contributors and watchers may not have
 * access to the repository at all, so they get the decisions and the trail, not the code or money.
 */
export const seesTechnical = (viewer: BoardViewer): boolean => can(viewer, 'see_runs');

/**
 * What contributors and watchers read of each event's payload: what the timeline says about the
 * decision, never the technical detail around it (reviewer notes quoting the code, changed paths,
 * check output, GitHub error text). An event type missing here shows no payload at all.
 */
const PUBLIC_FIELDS: Readonly<Record<string, readonly string[]>> = {
  created: ['title'],
  stage_changed: ['from', 'to'],
  lane_changed: ['from', 'to'],
  spec_versioned: ['version'],
  user_visible_changed: ['userVisible'],
  guards_changed: ['guards'],
  approval_recorded: ['gate', 'satisfied', 'memberId'],
  approval_proposed: ['gate'],
  approval_proposal_discarded: ['gate'],
  approval_planned: ['gate'],
  changes_requested: ['stage', 'note'],
  pushed: ['headSha', 'diffLines'],
  build_unchanged: ['headSha'],
  review_recorded: ['reviewer', 'verdict', 'by'],
  guardrail_tripped: ['guardrail'],
  blocked: ['blocked'],
  unblocked: ['answer'],
  diff_allowed: ['lines', 'lane', 'memberId'],
  closed: ['stage', 'reason'],
  pull_request_closed: ['pullRequest'],
  spec_status_set: ['status'],
  github_approved: ['login', 'merge'],
  github_auto_merge: ['merge'],
  github_auto_merge_failed: [],
  github_auto_merge_cancelled: [],
  github_approval_failed: ['login'],
  github_copilot_review_requested: ['pullRequest', 'login', 'outcome'],
  github_copilot_review_failed: ['pullRequest', 'login'],
  awaiting_merge: ['pullRequest'],
  merge_held: ['pullRequest'],
  head_carried: ['headSha'],
  checklist_posted: ['pullRequest'],
  checklist_checked: ['item', 'outcome', 'channel']
};

const HIDDEN_QUESTION =
  'A question for someone else to answer; maintainers and owners can read it.';

/** The question as this member may read it: people who may not get only that one is open. */
export const questionFor = (member: Member, blocked: Blocked): string =>
  seesQuestion(member, blocked.askedOf) ? blocked.question : HIDDEN_QUESTION;

/** Who a question is asked of, in words: the member by name, or a role. */
export const askedOfLabel = (
  askedOf: Blocked['askedOf'],
  names: ReadonlyMap<string, string>
): string =>
  'memberId' in askedOf ? (names.get(askedOf.memberId) ?? 'a member') : article(askedOf.role);

/** The options a question offers, by letter, to whoever may read the question itself. */
export const optionsFor = (member: Member, blocked: Blocked) =>
  seesQuestion(member, blocked.askedOf)
    ? (blocked.options ?? []).map((option, index) => ({ key: optionKey(index), ...option }))
    : [];

/** An option as plain text writes it, for the CLI and the Claude connector. */
export const optionText = (option: ReturnType<typeof optionsFor>[number]): string =>
  `(${option.key}) ${option.label}${option.detail ? `: ${option.detail}` : ''}`;

export const CONFIDENTIAL =
  "Confidential: only members who may see the project's confidential content can read this.";

/** Why a person must build the task, if one must, in words only a viewer who reads the task sees. */
const buildReasonFor = (
  config: ProjectConfig | null,
  row: BoardTaskRow,
  viewer: Pick<BoardViewer, 'role' | 'domains'>
): string | null => {
  const reason = config && humanBuildReason(config, row);
  return reason && !readsTask(viewer, row) ? CONFIDENTIAL : reason;
};

/** Free text a timeline event may carry, dropped for viewers who may not read the task. */
const EVENT_TEXT = ['note', 'answer', 'reason', 'blocked'];

const payloadFor = (
  viewer: BoardViewer,
  type: string,
  payload: Record<string, unknown>
): Record<string, unknown> => {
  if (seesTechnical(viewer)) return payload;
  const visible = Object.fromEntries(
    (PUBLIC_FIELDS[type] ?? [])
      .filter((field) => field in payload)
      .map((field) => [field, payload[field]])
  );
  if (type === 'blocked' && visible.blocked) {
    const blocked = visible.blocked as Blocked;
    visible.blocked = {
      askedOf: blocked.askedOf,
      question: questionFor(viewerMember(viewer), blocked)
    };
  }
  return visible;
};

export interface ApprovalState {
  readonly gate: Gate;
  readonly planned: boolean;
  readonly pending: readonly Requirement[];
  readonly waived: readonly Requirement[];
  readonly approvedBy: readonly string[];
  /** The members whose approval would meet a pending requirement. */
  readonly canApprove: readonly string[];
}

interface ProjectFacts {
  readonly members: Awaited<ReturnType<typeof listProjectMembers>>;
  readonly names: ReadonlyMap<string, string>;
  readonly rawConfig: unknown;
  /** The project's config, parsed once; `null` when it is invalid. */
  readonly config: ProjectConfig | null;
  /** The open onboarding task's number: until it is done, no other task is built. */
  readonly onboarding: number | null;
}

/**
 * Where the task's gate stands: whether the approval chooser has planned its subject, who must
 * still approve, and who has. `null` when the task is not at a gate. The board and `describeTask`
 * both read it.
 */
export const approvalState = async (
  pool: Pool,
  task: Pick<
    BoardTaskRow,
    | 'id'
    | 'stage'
    | 'lane'
    | 'approvalPlans'
    | 'requesterId'
    | 'userVisible'
    | 'specVersion'
    | 'headSha'
    | 'guards'
  >,
  facts: Pick<ProjectFacts, 'members' | 'names' | 'rawConfig'>
): Promise<ApprovalState | null> => {
  if (!isGate(task.stage) || !task.lane) return null;
  const config = parseProjectConfig(facts.rawConfig);
  if (!config.ok) return null;
  const gate = task.stage;
  const subject = gateSubject(task, gate);
  // Until the approval chooser has planned this subject, nobody can approve it yet.
  if (!subject || task.approvalPlans[gate]?.subject !== subject)
    return { gate, planned: false, pending: [], waived: [], approvedBy: [], canApprove: [] };
  const approvals = await listApprovedSubjects(pool, task.id);
  const context = policyContext(config.config, task, gate, { members: facts.members, subject });
  const policy = effectivePolicy(config.config, task, gate);
  const result = evaluatePolicy(policy, approvals, context);
  // Only approvals that count are shown as approvals: someone the policy does not name (or who may
  // not see a confidential task) can record one, but it meets nothing.
  const counting = new Set(
    applicableRequirements(policy, task.userVisible).flatMap((requirement) =>
      eligibleMembers(requirement, context).map((member) => member.id)
    )
  );
  return {
    gate,
    planned: true,
    pending: result.pending,
    waived: result.waived,
    approvedBy: approvals
      .filter((approval) => approval.subject === subject && counting.has(approval.memberId))
      .map((approval) => facts.names.get(approval.memberId) ?? 'a former member'),
    canApprove: [
      ...new Set(
        result.pending.flatMap((requirement) =>
          eligibleMembers(requirement, context).map((member) => member.id)
        )
      )
    ]
  };
};

/** What a handoff to a person needs, in words. */
const handoffNeeds = (blocked: Blocked): string[] =>
  (blocked.handoff?.needs ?? []).map((need) => HANDOFF_NEEDS[need].label);

/**
 * The pull requests of the task's learnings, for those who see learnings (`see_runs`) and read the
 * task; everyone else sees none, as they see no learnings.
 */
const learningPullRequestsFor = (row: BoardTaskRow, viewer: BoardViewer) =>
  seesTechnical(viewer) && readsTask(viewer, row) ? row.learningPullRequests : [];

/**
 * A finished task waits on nobody, unless a learning pull request it gave is still open: then it
 * waits on whoever merges in the project, as a result ready to merge does. Its stage stays as it is.
 */
const afterTheTask = (row: BoardTaskRow, viewer: BoardViewer): WaitingOn => {
  const open = learningPullRequestsFor(row, viewer).filter((pr) => pr.state === 'open');
  if (!open.length) return { kind: 'nobody', label: row.stage, me: false };
  const numbers = open.map((pr) => `#${pr.number}`).join(', ');
  return {
    kind: 'github',
    label: `Merge the learning pull request${open.length > 1 ? 's' : ''} ${numbers} on GitHub`,
    me: can(viewerMember(viewer), 'merge')
  };
};

/** What a task waits on while its build is being handed in: nobody, it is at work. */
const handingInWait = (row: BoardTaskRow, names: ReadonlyMap<string, string>): WaitingOn => ({
  kind: 'people',
  label: `${row.handingInBy ? (names.get(row.handingInBy) ?? 'A former member') : 'Someone'} is handing the build in`,
  me: false
});

const waitingOn = (
  row: BoardTaskRow,
  viewer: BoardViewer,
  approval: ApprovalState | null,
  facts: Pick<ProjectFacts, 'config' | 'onboarding' | 'names'>
): WaitingOn => {
  const member = viewerMember(viewer);
  if (TERMINAL_STAGES.has(row.stage)) return afterTheTask(row, viewer);
  if (row.blocked) {
    const who = askedOfLabel(row.blocked.askedOf, facts.names);
    const needs = handoffNeeds(row.blocked);
    return {
      kind: 'people',
      label: needs.length
        ? `Agents cannot go on: needs ${who} for ${needs.join(', ')}`
        : `A question for ${who}`,
      me: readsTask(viewer, row) && canAnswer(member, row.blocked.askedOf)
    };
  }
  if (row.paused) return { kind: 'people', label: 'Paused', me: can(member, 'steer') };
  // A hand-in under way waits on nobody, from its first GitHub read to the pull request it opens
  // once the task has moved on to review: it is at work, on every board.
  if (row.handingInSince) return handingInWait(row, facts.names);
  const running = row.runningRoles.map(roleLabel);
  switch (row.stage) {
    case 'request':
      return {
        kind: 'agent',
        label: running.length ? 'An agent is reading the request' : 'An agent reads it next',
        me: false
      };
    case 'triage':
      return {
        kind: 'people',
        label: 'A maintainer accepts or declines it',
        me: can(member, 'triage')
      };
    case 'speccing':
      return {
        kind: 'agent',
        label: running.length ? 'An agent is writing the plan' : 'An agent writes the plan next',
        me: false
      };
    case 'spec_review':
    case 'verifying': {
      if (approval && !approval.planned)
        return { kind: 'agent', label: 'Deciding who approves', me: false };
      const pending = approval?.pending ?? [];
      const plan = row.approvalPlans[row.stage];
      const asked = plan?.verifiers.some((verifier) => verifier.memberId === viewer.memberId);
      const noun = row.stage === 'spec_review' ? 'Plan approval' : 'A check of the result';
      return {
        kind: 'people',
        label: pending.length
          ? `${noun} by ${[...new Set(readable(pending).map(describeRequirement))].join(' and ')}`
          : noun,
        me:
          Boolean(approval?.canApprove.includes(viewer.memberId)) ||
          (Boolean(asked) && pending.length > 0 && can(member, GATE_ACTIONS[row.stage]))
      };
    }
    case 'ready': {
      const byPerson = buildReasonFor(facts.config, row, viewer);
      if (byPerson)
        return {
          kind: 'people',
          label: `Needs a developer: a developer claims the build. ${byPerson}`,
          me: can(member, 'build')
        };
      return row.kind === 'request' && facts.onboarding !== null
        ? {
            kind: 'agent',
            label: `Builds once the agent docs of task ${facts.onboarding} are merged`,
            me: false
          }
        : { kind: 'agent', label: 'Waiting for a build slot', me: false };
    }
    case 'building':
      return row.assignee?.kind === 'member'
        ? {
            kind: 'people',
            label: `${facts.names.get(row.assignee.memberId) ?? 'A person'} is building it, then hands it in`,
            me: row.assignee.memberId === viewer.memberId
          }
        : {
            kind: 'agent',
            label: running.length ? 'An agent is building it' : 'An agent builds it next',
            me: false
          };
    case 'reviewing':
      return {
        kind: 'agent',
        label: running.length ? 'Agents are reviewing it' : 'Agents review it next',
        me: false
      };
    case 'choosing':
      return { kind: 'agent', label: 'Preparing what to check', me: false };
    case 'merging':
      return row.autoMergeOn
        ? { kind: 'github', label: 'Merging once GitHub checks pass', me: false }
        : { kind: 'github', label: 'Merge on GitHub', me: can(member, 'merge') };
    default:
      return { kind: 'nobody', label: row.stage, me: false };
  }
};

/**
 * A developer claims a build when it waits or the agent has it, and hands in what they pushed once
 * it is theirs: built by hand or with their own agents, it goes to the same review. They may hand
 * it back instead, and so may whoever may steer the work, for another person's build.
 */
const buildActions = (row: BoardTaskRow, viewer: BoardViewer): BoardAction[] => {
  if (!buildsTask(viewer, row)) return [];
  if (row.stage === 'ready' || (row.stage === 'building' && row.assignee?.kind === 'agent'))
    return ['claim'];
  return row.stage === 'building' && row.assignee?.kind === 'member'
    ? heldBuildActions(row.assignee.memberId, viewer)
    : [];
};

/** What may be done with a build a member holds: theirs, or another's for whoever may steer. */
const heldBuildActions = (holderId: string, viewer: BoardViewer): BoardAction[] => {
  if (holderId === viewer.memberId) return ['hand_in', 'hand_back'];
  return can(viewer, 'steer') ? ['hand_back'] : [];
};

/**
 * Approving and sending back the work at the gate the task is at, once the approval chooser has
 * planned it. Sending it back is for whoever the gate's policy names, as the lifecycle decides.
 */
const gateActions = (
  row: BoardTaskRow,
  viewer: BoardViewer,
  facts: Pick<ProjectFacts, 'config' | 'members'>
): BoardAction[] => {
  if (!isGate(row.stage) || row.approvalPlans[row.stage]?.subject !== gateSubject(row, row.stage))
    return [];
  const member = viewerMember(viewer);
  const approves = can(member, GATE_ACTIONS[row.stage]);
  // Nobody writes on a task they may not read, so they cannot send it back either.
  const sendsBack =
    readsTask(viewer, row) &&
    facts.config !== null &&
    canRequestChanges(row, { config: facts.config, members: facts.members }, member);
  return [
    ...(approves ? (['approve'] as const) : []),
    ...(sendsBack ? (['changes'] as const) : [])
  ];
};

const actionsFor = (
  row: BoardTaskRow,
  viewer: BoardViewer,
  facts: Pick<ProjectFacts, 'config' | 'members'>
): BoardAction[] => {
  const member = viewerMember(viewer);
  // Nobody writes on a task they may not read: no comment or answer.
  const writes = readsTask(viewer, row);
  // A finished task, or one whose build is being handed in, takes nothing but comments.
  if (TERMINAL_STAGES.has(row.stage) || row.handingInSince)
    return writes && can(member, 'comment') ? ['comment'] : [];
  const actions: BoardAction[] = [];
  const requester = row.requesterId === viewer.memberId;
  if (canSubmitRequest(row, member)) actions.push('submit');
  if (row.blocked) {
    if (writes && canAnswer(member, row.blocked.askedOf)) actions.push('answer');
  } else if (!row.paused) {
    if (row.stage === 'triage' && can(member, 'triage')) actions.push('accept', 'decline');
    actions.push(...buildActions(row, viewer), ...gateActions(row, viewer, facts));
  }
  if (can(member, 'steer') || (requester && can(member, 'request'))) actions.push('cancel');
  if (writes && can(member, 'comment')) actions.push('comment');
  return actions;
};

const projectFacts = async (pool: Pool, viewer: BoardViewer): Promise<ProjectFacts> => {
  const [members, names, config, onboarding] = await Promise.all([
    listProjectMembers(pool, viewer.projectId),
    memberNames(pool, viewer.workspaceId),
    loadProjectConfig(pool, viewer.projectId),
    openOnboardingTask(pool, viewer.projectId)
  ]);
  const parsed = parseProjectConfig(config);
  return {
    members,
    names,
    rawConfig: config,
    config: parsed.ok ? parsed.config : null,
    onboarding: onboarding?.number ?? null
  };
};

/**
 * The hand-in under way on a task's build, while its claim is live: who is handing it in, whether it
 * is the viewer, and since when. Every board that shows the task shows it at work, so nobody hands
 * the build in twice.
 */
const handingInView = (
  row: BoardTaskRow,
  viewer: BoardViewer,
  names: ReadonlyMap<string, string>
) =>
  row.handingInSince
    ? {
        by: row.handingInBy ? (names.get(row.handingInBy) ?? 'a former member') : null,
        you: row.handingInBy === viewer.memberId,
        since: row.handingInSince
      }
    : null;

const cardView = (
  row: BoardTaskRow,
  viewer: BoardViewer,
  approval: ApprovalState | null,
  facts: ProjectFacts
) => ({
  number: row.number,
  title: row.title,
  stage: row.stage,
  lane: row.lane,
  blocked: row.blocked
    ? {
        question: readsTask(viewer, row)
          ? questionFor(viewerMember(viewer), row.blocked)
          : CONFIDENTIAL,
        needs: handoffNeeds(row.blocked)
      }
    : null,
  guards: row.guards.map((guard) => GUARD_LABELS[guard]),
  paused: row.paused,
  userVisible: row.userVisible,
  requester: row.requesterName,
  // Its pull request shows the confidential change itself.
  pullRequest: readsTask(viewer, row) ? row.pullRequest : null,
  costCents: seesTechnical(viewer) ? row.costCents : null,
  running: row.runningRoles.map((role) => ({ role, label: roleLabel(role) })),
  fixRounds: row.fixRounds,
  specVersion: row.specVersion,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  stageSince: row.stageSince,
  autoVerified: row.autoVerified,
  autoMergeOn: row.autoMergeOn,
  learningPullRequests: learningPullRequestsFor(row, viewer),
  handingIn: handingInView(row, viewer, facts.names),
  waitingOn: waitingOn(row, viewer, approval, facts)
});

const DEPTH_LABELS = {
  glance: 'A careful read is enough',
  test: 'Try it by hand',
  device: 'Test it on a real device'
} as const;

/** Who will merge the result: the chooser's choice, which the project may not allow. */
const mergedBy = (plan: ApprovalPlan | undefined, config: ProjectConfig | null) =>
  plan?.merge === 'auto' && config?.pullRequest.autoMerge ? ('auto' as const) : ('person' as const);

/** The approval chooser's plan for the gate the task is at (or the latest one), for people. */
const planView = (row: BoardTaskRow, facts: ProjectFacts) => {
  const gate: Gate | null =
    row.stage === 'spec_review' ? 'spec_review' : row.approvalPlans.verifying ? 'verifying' : null;
  const plan = gate ? row.approvalPlans[gate] : undefined;
  if (!gate || !plan) return null;
  const config = parseProjectConfig(facts.rawConfig);
  return {
    gate,
    current: plan.subject === gateSubject(row, gate),
    merge: gate === 'verifying' ? mergedBy(plan, config.ok ? config.config : null) : null,
    depth: plan.depth,
    depthLabel: DEPTH_LABELS[plan.depth],
    rationale: plan.rationale,
    extra: plan.extra.map((item) => ({
      label: describeRequirement(item.requirement),
      reason: item.reason
    })),
    verifiers: plan.verifiers.map((verifier) => ({
      name: facts.names.get(verifier.memberId) ?? 'a former member',
      reason: verifier.reason
    }))
  };
};

export type CardView = ReturnType<typeof cardView>;

/**
 * The requirements a gate shows people. The floor folds into an owner requirement only when someone
 * can meet that one: an owner requirement waived for want of an owner leaves the floor to read.
 */
const shownRequirements = (policy: Policy, userVisible: boolean, context: Eligibility) => {
  const applicable = applicableRequirements(policy, userVisible);
  const meetable = applicable.filter(
    (requirement) =>
      requirement === APPROVAL_FLOOR || eligibleMembers(requirement, context).length > 0
  );
  const collapsed = readable(meetable);
  return applicable.filter(
    (requirement) => !meetable.includes(requirement) || collapsed.includes(requirement)
  );
};

/** Each human gate, in order, with what the people it names do there. */
const GATE_PEOPLE = [
  { gate: 'spec_review', does: 'Approve the plan' },
  { gate: 'verifying', does: 'Check the result' }
] as const satisfies readonly { gate: Gate; does: string }[];

/** What a result's gate says when the lifecycle let it skip people's check (`canAutoVerify`). */
const AUTO_VERIFIED_GATE = "skipped: a low-risk change the agents and GitHub's checks reviewed";

/**
 * What was waived when a gate passed for its current subject, or `null` while it has not passed. A
 * gate already passed reads as it was decided then, not with the members who joined since.
 */
const waivedWhenPassed = (
  events: readonly TaskEventRow[],
  gate: Gate,
  subject: string | null
): readonly Requirement[] | null => {
  const passed = events
    .map(domainEventOf)
    .filter(
      (event) =>
        event.type === 'approval_recorded' &&
        event.gate === gate &&
        event.subject === subject &&
        event.satisfied
    )
    .at(-1);
  return passed?.type === 'approval_recorded' ? passed.waived : null;
};

/**
 * The people of a task: who asked for it, who the approval policy expects at each gate (the
 * lane's policy plus what the chooser added, and the maintainer floor) with who already approved,
 * whom the chooser asked to check, and who merges. A gate already passed shows what it waived then.
 * The requester approves only where a requirement names them, or where the project lets them meet
 * their own gates.
 */
const peopleView = (
  row: BoardTaskRow,
  viewer: BoardViewer,
  facts: ProjectFacts,
  recorded: { readonly approvals: readonly Approval[]; readonly events: readonly TaskEventRow[] }
) => {
  const config = parseProjectConfig(facts.rawConfig);
  const name = (id: string) => facts.names.get(id) ?? 'a former member';
  const gates = config.ok
    ? GATE_PEOPLE.map(({ gate, does }) => {
        const subject = gateSubject(row, gate);
        const approved = new Set(
          recorded.approvals
            .filter((approval) => subject !== null && approval.subject === subject)
            .map((approval) => approval.memberId)
        );
        const context = policyContext(config.config, row, gate, {
          members: facts.members,
          subject: subject ?? ''
        });
        const policy = effectivePolicy(config.config, row, gate);
        const waivedThen = waivedWhenPassed(recorded.events, gate, subject);
        const skipped = gate === 'verifying' && row.autoVerified ? AUTO_VERIFIED_GATE : null;
        // Nobody was asked to check a skipped result, so it names no approvers.
        const shown = skipped ? [] : shownRequirements(policy, row.userVisible, context);
        return {
          gate,
          does,
          current: row.stage === gate,
          skipped,
          requirements: shown.map((requirement) => {
            const waived = waivedThen
              ? waivedThen.some((other) => sameRequirement(other, requirement))
              : eligibleMembers(requirement, context).length === 0 &&
                requirement !== APPROVAL_FLOOR;
            const eligible = waived ? [] : eligibleMembers(requirement, context);
            return {
              label: describeRequirement(requirement),
              // Each person says whether they approved: a name alone could be two members.
              who: eligible.map((member) => ({
                name: name(member.id),
                approved: approved.has(member.id)
              })),
              waived
            };
          }),
          asked: (row.approvalPlans[gate]?.verifiers ?? []).map((verifier) =>
            name(verifier.memberId)
          )
        };
      })
    : [];
  const byPerson = buildReasonFor(facts.config, row, viewer);
  const developers = facts.members
    .filter((member) => buildsTask(member, row))
    .map((member) => name(member.id));
  return {
    requester: row.requesterName,
    gates,
    build: byPerson
      ? { by: 'person' as const, reason: byPerson, who: developers }
      : { by: 'agent' as const, reason: null, who: [] },
    merge: {
      by: mergedBy(row.approvalPlans.verifying, config.ok ? config.config : null),
      who: facts.members.filter((member) => can(member, 'merge')).map((member) => name(member.id))
    }
  };
};

export const boardView = async (pool: Pool, viewer: BoardViewer) => {
  const facts = await projectFacts(pool, viewer);
  const rows = await listBoardTasks(pool, viewer.projectId);
  return Promise.all(
    rows.map(async (row) => cardView(row, viewer, await approvalState(pool, row, facts), facts))
  );
};

export const consoleUrl = (workspace: string | undefined, sessionId: string | null) =>
  workspace && sessionId
    ? `https://platform.claude.com/workspaces/${workspace}/sessions/${sessionId}`
    : null;

type RunView = ReturnType<typeof runView>;

const runView = (run: RunRow, consoleWorkspace: string | undefined) => ({
  id: run.id,
  taskNumber: run.taskNumber,
  taskTitle: run.taskTitle,
  role: run.role,
  label: roleLabel(run.role),
  agentVersion: run.agentVersion,
  stage: run.stage,
  status: run.status,
  costCents: run.costCents,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  eventCount: run.eventCount,
  consoleUrl: consoleUrl(consoleWorkspace, run.sessionId),
  result: run.result
});

export const runsView = async (pool: Pool, viewer: BoardViewer, consoleWorkspace?: string) =>
  (await listProjectRuns(pool, viewer.projectId, 60)).map((run) => runView(run, consoleWorkspace));

/**
 * What a viewer reads of a confidential task they may not see: their own words, and that the
 * rest is confidential. Everyone else reads everything.
 */
const confidentialView = (row: BoardTaskRow, viewer: BoardViewer) => {
  const reads = readsTask(viewer, row);
  const own = (author: Actor | undefined) =>
    author?.kind === 'member' && author.memberId === viewer.memberId;
  return {
    text: (body: string, author?: Actor) => (reads || own(author) ? body : CONFIDENTIAL),
    value: <T>(value: T): T | null => (reads ? value : null),
    payload: (payload: Record<string, unknown>) =>
      reads
        ? payload
        : Object.fromEntries(Object.entries(payload).filter(([key]) => !EVENT_TEXT.includes(key)))
  };
};

/**
 * The size allowed for this task over its lane's limit, who allowed it and when, while it is in force:
 * only in the lane it was granted in, as the size check reads it. It says how much the task may
 * change, not what, so everyone who sees the task sees it.
 */
export const allowanceView = (
  task: Pick<Task, 'diffAllowance' | 'lane'>,
  events: readonly TaskEventRow[],
  names: ReadonlyMap<string, string>
) => {
  const allowance = task.diffAllowance;
  if (!allowance || allowance.lane !== task.lane) return null;
  const granted = events.filter((event) => event.type === 'diff_allowed').at(-1);
  return {
    lines: allowance.lines,
    lane: allowance.lane,
    by: names.get(allowance.memberId) ?? 'a former member',
    at: granted?.createdAt ?? null
  };
};

/** The allowance in force, in the words the CLI and the Claude connector write it. */
export const allowanceText = (allowance: NonNullable<ReturnType<typeof allowanceView>>): string =>
  `Size allowed for this task: up to ${allowance.lines} lines in the ${allowance.lane} lane, by ${allowance.by}${allowance.at ? ` on ${allowance.at.toISOString().slice(0, 10)}` : ''}. Every other task keeps the lane's limit.`;

export const taskView = async (
  pool: Pool,
  viewer: BoardViewer,
  number: number,
  consoleWorkspace?: string
) => {
  const row = await loadBoardTask(pool, viewer.projectId, number);
  if (!row) return null;
  const facts = await projectFacts(pool, viewer);
  const [approval, context, specs, comments, events, runs, chooser, approvals, proposals] =
    await Promise.all([
      approvalState(pool, row, facts),
      loadTaskContext(pool, row.id),
      listSpecVersions(pool, row.id),
      listTaskComments(pool, row.id),
      listTaskEvents(pool, row.id),
      listTaskRuns(pool, row.id),
      latestChooserResult(pool, row.id),
      listApprovedSubjects(pool, row.id),
      listProposalHistory(pool, row.id)
    ]);
  const label = (actor: Actor) => actorLabel(actor, facts.names);
  // The viewer's own approval that Claude proposed, waiting for them to confirm or discard it.
  const proposal = openProposals(row, proposals, approvals).find(
    (open) => open.memberId === viewer.memberId
  );
  const [request, ...thread] = comments;
  const shown = confidentialView(row, viewer);
  return {
    ...cardView(row, viewer, approval, facts),
    blocked: row.blocked
      ? {
          question: shown.text(questionFor(viewerMember(viewer), row.blocked)),
          needs: handoffNeeds(row.blocked),
          options: shown.value(optionsFor(viewerMember(viewer), row.blocked)) ?? [],
          // An option picked from this question holds only for the version it was read at.
          version: row.version,
          askedOf: askedOfLabel(row.blocked.askedOf, facts.names)
        }
      : null,
    repo: context?.repo ?? null,
    branch: branchForTask(row.number),
    pullRequestUrl: shown.value(
      context?.repo && row.pullRequest
        ? `https://github.com/${context.repo}/pull/${row.pullRequest}`
        : null
    ),
    headSha: shown.value(row.headSha),
    allowance: allowanceView(row, events, facts.names),
    request: request
      ? {
          author: label(request.author),
          via: viaView(request.author),
          body: shown.text(request.body, request.author),
          at: request.createdAt
        }
      : null,
    comments: thread.map((comment) => ({
      id: comment.id,
      author: label(comment.author),
      authorKind: comment.author.kind,
      via: viaView(comment.author),
      body: shown.text(comment.body, comment.author),
      at: comment.createdAt
    })),
    specs: specs.map((spec) => ({
      version: spec.version,
      body: shown.text(spec.body),
      author: label(spec.createdBy),
      at: spec.createdAt
    })),
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      actor: label(event.actor),
      actorKind: event.actor.kind,
      actorRole: event.actor.kind === 'agent' ? event.actor.role : null,
      via: viaView(event.actor),
      payload: shown.payload(payloadFor(viewer, event.type, event.payload)),
      at: event.createdAt
    })),
    runs: seesTechnical(viewer) ? runs.map((run) => runView(run, consoleWorkspace)) : [],
    plan: shown.value(planView(row, facts)),
    people: peopleView(row, viewer, facts, { approvals, events }),
    approval: approval && {
      gate: approval.gate,
      planned: approval.planned,
      pending: [...new Set(readable(approval.pending).map(describeRequirement))],
      waived: approval.waived.map(describeRequirement),
      approvedBy: approval.approvedBy
    },
    checklist: shown.value(
      await checklistView(pool, {
        taskId: row.id,
        task: row,
        viewer: viewerMember(viewer),
        chosen: chooser as ChosenChecklist | null
      })
    ),
    reviewers: REVIEWER_ROLES.map((role) => ({ role, label: roleLabel(role) })),
    actions: actionsFor(row, viewer, facts),
    proposal: proposal ? { gate: proposal.gate, via: appView(proposal.via) } : null
  };
};

export type TaskView = NonNullable<Awaited<ReturnType<typeof taskView>>>;

const text = (value: unknown, max: number): string => {
  const raw =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value
            .map((part) =>
              part && typeof part === 'object' && 'text' in part ? String(part.text) : ''
            )
            .join('')
        : '';
  return clip(raw, max);
};

const toolSummary = (name: string, input: Record<string, unknown>): string => {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query']) {
    if (typeof input[key] === 'string') return String(input[key]);
  }
  return JSON.stringify(input).slice(0, 400);
};

type LogBase = { readonly id: string; readonly at: Date };

export type LogEntry = LogBase &
  (
    | { readonly kind: 'message' | 'brief'; readonly text: string }
    | { readonly kind: 'thinking' }
    | { readonly kind: 'tool'; readonly name: string; readonly summary: string }
    | { readonly kind: 'tool_result'; readonly text: string; readonly isError: boolean }
    | { readonly kind: 'submitted'; readonly outcome: string }
    | { readonly kind: 'feedback' | 'error'; readonly text: string }
    | { readonly kind: 'status'; readonly status: string }
    | { readonly kind: 'officina'; readonly type: string; readonly payload: unknown }
  );

/**
 * A run's session events as a readable log. Model spans and usage are dropped; tool output is
 * truncated, since the full session stays one click away in the Console.
 */
export const logEntries = (events: readonly RunEventRow[]): LogEntry[] =>
  events.flatMap((event): LogEntry[] => {
    const payload = event.payload;
    const base = { id: event.id, at: event.createdAt };
    switch (event.type) {
      case 'agent.message':
        return [{ ...base, kind: 'message' as const, text: text(payload.content, 20_000) }];
      case 'agent.thinking':
        return [{ ...base, kind: 'thinking' as const }];
      case 'agent.tool_use':
      case 'agent.mcp_tool_use': {
        const name = String(payload.name ?? 'tool');
        const input = (payload.input ?? {}) as Record<string, unknown>;
        return [{ ...base, kind: 'tool' as const, name, summary: toolSummary(name, input) }];
      }
      case 'agent.tool_result':
      case 'agent.mcp_tool_result':
        return [
          {
            ...base,
            kind: 'tool_result' as const,
            text: text(payload.content, 4_000),
            isError: payload.is_error === true
          }
        ];
      case 'agent.custom_tool_use':
        return [
          {
            ...base,
            kind: 'submitted' as const,
            outcome: String(
              (payload.input as { result?: { outcome?: string } } | undefined)?.result?.outcome ??
                'result'
            )
          }
        ];
      case 'user.message':
        return [{ ...base, kind: 'brief' as const, text: text(payload.content, 20_000) }];
      case 'user.custom_tool_result':
        return [{ ...base, kind: 'feedback' as const, text: text(payload.content, 4_000) }];
      case 'session.status_running':
      case 'session.status_idle':
      case 'session.status_terminated':
        return [
          { ...base, kind: 'status' as const, status: event.type.slice('session.status_'.length) }
        ];
      case 'session.error':
        return [
          {
            ...base,
            kind: 'error' as const,
            text: JSON.stringify(payload.error ?? payload).slice(0, 2_000)
          }
        ];
      default:
        return event.type.startsWith('officina.')
          ? [
              {
                ...base,
                kind: 'officina' as const,
                type: event.type.slice('officina.'.length),
                payload
              }
            ]
          : [];
    }
  });

/** How many run events one page of a run log reads. */
export const RUN_LOG_PAGE = 500;

/**
 * One page of a run's log. `more` says whether events are left past `cursor`: a page can hold
 * fewer entries than events read, since the log drops some, so its length tells the board nothing.
 */
export const runLog = async (pool: Pool, runId: string, afterId: number) => {
  const events = await listRunEvents(pool, runId, afterId, RUN_LOG_PAGE);
  return {
    entries: logEntries(events),
    cursor: events.at(-1)?.id ?? String(afterId),
    more: events.length === RUN_LOG_PAGE
  };
};

/** Learnings of the project, newest first, with who decided them. */
/**
 * The decision under way on a learning, while its claim is live: which one, who made it (null for a
 * claim from before claims named anyone), whether it is the viewer, and since when. Every board that
 * shows the learning shows it at work, so nobody decides it twice.
 */
const decidingView = (row: LearningRow, viewer: BoardViewer, names: ReadonlyMap<string, string>) =>
  row.decidingSince
    ? {
        decision: row.decidingFor,
        by: row.decidingBy ? (names.get(row.decidingBy) ?? 'a former member') : null,
        you: row.decidingBy === viewer.memberId,
        since: row.decidingSince
      }
    : null;

export const learningsView = async (pool: Pool, viewer: BoardViewer) => {
  const [rows, names] = await Promise.all([
    listLearnings(pool, viewer.projectId),
    memberNames(pool, viewer.workspaceId)
  ]);
  const canDecide = can(viewer, 'decide_learnings');
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    lesson: row.lesson,
    evidence: row.evidence,
    target: row.target,
    file: row.file,
    find: row.find,
    text: row.text,
    status: row.status,
    taskNumber: row.taskNumber,
    taskTitle: row.taskTitle,
    decidedBy: row.decidedBy ? (names.get(row.decidedBy) ?? 'a former member') : null,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    prState: row.prState,
    rewrite: row.rewrite,
    rewrittenAt: row.rewrittenAt,
    duplicateOf: row.duplicateOf,
    createdAt: row.createdAt,
    canDecide: canDecide && row.status === 'proposed',
    deciding: decidingView(row, viewer, names)
  }));
};
