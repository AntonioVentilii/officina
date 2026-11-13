import {
  APPROVAL_FLOOR,
  GATE_ACTIONS,
  HANDOFF_NEEDS,
  REVIEWER_ROLES,
  TERMINAL_STAGES,
  applicableRequirements,
  can,
  effectivePolicy,
  eligibleMembers,
  evaluatePolicy,
  gateSubject,
  hasRole,
  humanBuildReason,
  optionKey,
  parseProjectConfig,
  policyContext,
  type Actor,
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
  type Role
} from '@officina/core';
import {
  latestChooserResult,
  listApprovedSubjects,
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
  type BoardTaskRow,
  type RunEventRow,
  type RunRow,
  loadProjectConfig
} from '@officina/db';
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

export const agentsView = () =>
  AGENTS_PAGE.map(({ role, does }) => ({ role, label: roleLabel(role), does }));

const article = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

/**
 * The maintainer floor adds nothing to read when an owner or maintainer is already required, since
 * that approval meets both.
 */
const readable = (pending: readonly Requirement[]) =>
  pending.filter(
    (requirement) =>
      !(
        'role' in requirement &&
        requirement.role === 'maintainer' &&
        pending.some((other) => other !== requirement && 'role' in other && other.role === 'owner')
      )
  );

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
  approval_recorded: ['gate', 'satisfied', 'memberId'],
  approval_planned: ['gate'],
  changes_requested: ['stage', 'note'],
  pushed: ['headSha', 'diffLines'],
  build_unchanged: ['headSha'],
  review_recorded: ['reviewer', 'verdict', 'by'],
  guardrail_tripped: ['guardrail'],
  blocked: ['blocked'],
  unblocked: ['answer'],
  closed: ['stage', 'reason'],
  pull_request_closed: ['pullRequest'],
  spec_status_set: ['status'],
  github_approved: ['login', 'merge'],
  github_auto_merge: ['merge'],
  github_auto_merge_failed: [],
  github_auto_merge_cancelled: [],
  github_approval_failed: ['login'],
  github_copilot_review_requested: ['pullRequest', 'login'],
  github_copilot_review_failed: ['pullRequest', 'login'],
  awaiting_merge: ['pullRequest'],
  merge_held: ['pullRequest'],
  checklist_posted: ['pullRequest']
};

const HIDDEN_QUESTION =
  'A question for someone else to answer; maintainers and owners can read it.';

/**
 * Questions are often an agent's or Officina's own failure, quoting an error; people who can
 * neither answer them nor see the runs get only that one is open.
 */
const seesQuestion = (viewer: BoardViewer, blocked: Blocked): boolean =>
  seesTechnical(viewer) ||
  ('memberId' in blocked.askedOf
    ? blocked.askedOf.memberId === viewer.memberId
    : hasRole(viewerMember(viewer), blocked.askedOf.role));

const questionFor = (viewer: BoardViewer, blocked: Blocked): string =>
  seesQuestion(viewer, blocked) ? blocked.question : HIDDEN_QUESTION;

/** The options a question offers, by letter, to whoever may read the question itself. */
const optionsFor = (viewer: BoardViewer, blocked: Blocked) =>
  seesQuestion(viewer, blocked)
    ? (blocked.options ?? []).map((option, index) => ({ key: optionKey(index), ...option }))
    : [];

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
    visible.blocked = { askedOf: blocked.askedOf, question: questionFor(viewer, blocked) };
  }
  return visible;
};

interface ApprovalState {
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

const approvalState = async (
  pool: Pool,
  row: BoardTaskRow,
  facts: ProjectFacts
): Promise<ApprovalState | null> => {
  if ((row.stage !== 'spec_review' && row.stage !== 'verifying') || !row.lane) return null;
  const config = parseProjectConfig(facts.rawConfig);
  if (!config.ok) return null;
  const gate: Gate = row.stage;
  const subject = gateSubject(row, gate) ?? '';
  const plan = row.approvalPlans[gate];
  // Until the approval chooser has planned this subject, nobody can approve it yet.
  if (plan?.subject !== subject)
    return { gate, planned: false, pending: [], waived: [], approvedBy: [], canApprove: [] };
  const approvals = await listApprovedSubjects(pool, row.id);
  const context = policyContext(config.config, row, gate, { members: facts.members, subject });
  const result = evaluatePolicy(effectivePolicy(config.config, row, gate), approvals, context);
  return {
    gate,
    planned: true,
    pending: result.pending,
    waived: result.waived,
    approvedBy: approvals
      .filter((approval) => approval.subject === subject)
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

const canAnswer = (row: BoardTaskRow, viewer: BoardViewer) => {
  if (!row.blocked) return false;
  const askedOf = row.blocked.askedOf;
  return (
    can(viewer, 'answer') &&
    (viewer.role === 'owner' ||
      ('memberId' in askedOf
        ? askedOf.memberId === viewer.memberId
        : hasRole(viewerMember(viewer), askedOf.role)))
  );
};

/** What a handoff to a person needs, in words. */
const handoffNeeds = (blocked: Blocked): string[] =>
  (blocked.handoff?.needs ?? []).map((need) => HANDOFF_NEEDS[need].label);

const waitingOn = (
  row: BoardTaskRow,
  viewer: BoardViewer,
  approval: ApprovalState | null,
  facts: Pick<ProjectFacts, 'config' | 'onboarding' | 'names'>
): WaitingOn => {
  const member = viewerMember(viewer);
  if (TERMINAL_STAGES.has(row.stage)) return { kind: 'nobody', label: row.stage, me: false };
  if (row.blocked) {
    const askedOf = row.blocked.askedOf;
    const who = 'memberId' in askedOf ? 'a member' : article(askedOf.role);
    const needs = handoffNeeds(row.blocked);
    return {
      kind: 'people',
      label: needs.length
        ? `Agents cannot go on: needs ${who} for ${needs.join(', ')}`
        : `A question for ${who}`,
      me: canAnswer(row, viewer)
    };
  }
  if (row.paused) return { kind: 'people', label: 'Paused', me: can(member, 'steer') };
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
      const byPerson = facts.config && humanBuildReason(facts.config, row);
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
 * it is theirs: built by hand or with their own agents, it goes to the same review.
 */
const buildActions = (row: BoardTaskRow, viewer: BoardViewer): BoardAction[] => {
  if (!can(viewer, 'build')) return [];
  if (row.stage === 'ready' || (row.stage === 'building' && row.assignee?.kind === 'agent'))
    return ['claim'];
  return row.stage === 'building' &&
    row.assignee?.kind === 'member' &&
    row.assignee.memberId === viewer.memberId
    ? ['hand_in']
    : [];
};

const actionsFor = (row: BoardTaskRow, viewer: BoardViewer): BoardAction[] => {
  const member = viewerMember(viewer);
  if (TERMINAL_STAGES.has(row.stage)) return can(member, 'comment') ? ['comment'] : [];
  const actions: BoardAction[] = [];
  const requester = row.requesterId === viewer.memberId;
  if (row.stage === 'request' && can(member, 'request') && (requester || can(member, 'triage')))
    actions.push('submit');
  if (row.blocked) {
    if (canAnswer(row, viewer)) actions.push('answer');
  } else if (!row.paused) {
    if (row.stage === 'triage' && can(member, 'triage')) actions.push('accept', 'decline');
    actions.push(...buildActions(row, viewer));
    if (
      (row.stage === 'spec_review' || row.stage === 'verifying') &&
      can(member, GATE_ACTIONS[row.stage]) &&
      row.approvalPlans[row.stage]?.subject === gateSubject(row, row.stage)
    )
      actions.push('approve', 'changes');
  }
  if (can(member, 'steer') || (requester && can(member, 'request'))) actions.push('cancel');
  if (can(member, 'comment')) actions.push('comment');
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
    ? { question: questionFor(viewer, row.blocked), needs: handoffNeeds(row.blocked) }
    : null,
  paused: row.paused,
  userVisible: row.userVisible,
  requester: row.requesterName,
  pullRequest: row.pullRequest,
  costCents: seesTechnical(viewer) ? row.costCents : null,
  running: row.runningRoles.map((role) => ({ role, label: roleLabel(role) })),
  fixRounds: row.fixRounds,
  specVersion: row.specVersion,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  stageSince: row.stageSince,
  autoVerified: row.autoVerified,
  autoMergeOn: row.autoMergeOn,
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

/**
 * The people of a task: who asked for it, who the approval policy expects at each gate (the
 * lane's policy plus what the chooser added, and the maintainer floor) with who already approved,
 * whom the chooser asked to check, and who merges. The requester approves only where a
 * requirement names them, or where the project lets them meet their own gates.
 */
const peopleView = (row: BoardTaskRow, facts: ProjectFacts, approvals: readonly Approval[]) => {
  const config = parseProjectConfig(facts.rawConfig);
  const name = (id: string) => facts.names.get(id) ?? 'a former member';
  const gates = config.ok
    ? GATE_PEOPLE.map(({ gate, does }) => {
        const subject = gateSubject(row, gate);
        const approved = new Set(
          approvals
            .filter((approval) => subject !== null && approval.subject === subject)
            .map((approval) => approval.memberId)
        );
        const context = policyContext(config.config, row, gate, {
          members: facts.members,
          subject: subject ?? ''
        });
        const policy = effectivePolicy(config.config, row, gate);
        return {
          gate,
          does,
          current: row.stage === gate,
          requirements: shownRequirements(policy, row.userVisible, context).map((requirement) => {
            const eligible = eligibleMembers(requirement, context);
            return {
              label: describeRequirement(requirement),
              who: eligible.map((member) => name(member.id)),
              waived: eligible.length === 0 && requirement !== APPROVAL_FLOOR,
              approvedBy: eligible
                .filter((member) => approved.has(member.id))
                .map((member) => name(member.id))
            };
          }),
          asked: (row.approvalPlans[gate]?.verifiers ?? []).map((verifier) =>
            name(verifier.memberId)
          )
        };
      })
    : [];
  const byPerson = facts.config && humanBuildReason(facts.config, row);
  const developers = facts.members
    .filter((member) => can(member, 'build'))
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

export const taskView = async (
  pool: Pool,
  viewer: BoardViewer,
  number: number,
  consoleWorkspace?: string
) => {
  const row = await loadBoardTask(pool, viewer.projectId, number);
  if (!row) return null;
  const facts = await projectFacts(pool, viewer);
  const [approval, context, specs, comments, events, runs, chooser, approvals] = await Promise.all([
    approvalState(pool, row, facts),
    loadTaskContext(pool, row.id),
    listSpecVersions(pool, row.id),
    listTaskComments(pool, row.id),
    listTaskEvents(pool, row.id),
    listTaskRuns(pool, row.id),
    latestChooserResult(pool, row.id),
    listApprovedSubjects(pool, row.id)
  ]);
  const label = (actor: Actor) => actorLabel(actor, facts.names);
  const [request, ...thread] = comments;
  return {
    ...cardView(row, viewer, approval, facts),
    blocked: row.blocked
      ? {
          question: questionFor(viewer, row.blocked),
          needs: handoffNeeds(row.blocked),
          options: optionsFor(viewer, row.blocked),
          askedOf:
            'memberId' in row.blocked.askedOf
              ? (facts.names.get(row.blocked.askedOf.memberId) ?? 'a member')
              : article(row.blocked.askedOf.role)
        }
      : null,
    repo: context?.repo ?? null,
    pullRequestUrl:
      context?.repo && row.pullRequest
        ? `https://github.com/${context.repo}/pull/${row.pullRequest}`
        : null,
    headSha: row.headSha,
    request: request
      ? { author: label(request.author), body: request.body, at: request.createdAt }
      : null,
    comments: thread.map((comment) => ({
      id: comment.id,
      author: label(comment.author),
      authorKind: comment.author.kind,
      body: comment.body,
      at: comment.createdAt
    })),
    specs: specs.map((spec) => ({
      version: spec.version,
      body: spec.body,
      author: label(spec.createdBy),
      at: spec.createdAt
    })),
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      actor: label(event.actor),
      actorKind: event.actor.kind,
      actorRole: event.actor.kind === 'agent' ? event.actor.role : null,
      payload: payloadFor(viewer, event.type, event.payload),
      at: event.createdAt
    })),
    runs: seesTechnical(viewer) ? runs.map((run) => runView(run, consoleWorkspace)) : [],
    plan: planView(row, facts),
    people: peopleView(row, facts, approvals),
    approval: approval && {
      gate: approval.gate,
      planned: approval.planned,
      pending: [...new Set(readable(approval.pending).map(describeRequirement))],
      waived: approval.waived.map(describeRequirement),
      approvedBy: approval.approvedBy
    },
    checklist: chooser as {
      checklist: string[];
      beforeAfter?: { key: string; locale: string; before: string; after: string }[];
      userVisible: boolean;
    } | null,
    reviewers: REVIEWER_ROLES.map((role) => ({ role, label: roleLabel(role) })),
    actions: actionsFor(row, viewer)
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
  return raw.length > max ? `${raw.slice(0, max)}\n… (${raw.length - max} more characters)` : raw;
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

export const runLog = async (pool: Pool, runId: string, afterId: number) => {
  const events = await listRunEvents(pool, runId, afterId, 500);
  return { entries: logEntries(events), cursor: events.at(-1)?.id ?? String(afterId) };
};

/** Learnings of the project, newest first, with who decided them. */
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
    createdAt: row.createdAt,
    canDecide: canDecide && row.status === 'proposed'
  }));
};
