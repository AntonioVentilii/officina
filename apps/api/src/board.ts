import {
  REVIEWER_ROLES,
  TERMINAL_STAGES,
  effectivePolicy,
  evaluatePolicy,
  gateSubject,
  hasRole,
  isEligible,
  parseProjectConfig,
  type Actor,
  type AgentRole,
  type Blocked,
  type Gate,
  type Member,
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
  type RunRow
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
  'submit' | 'accept' | 'decline' | 'approve' | 'changes' | 'answer' | 'cancel' | 'comment';

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

const describeRequirement = (requirement: Requirement): string =>
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
export const seesTechnical = (viewer: BoardViewer): boolean =>
  hasRole(viewerMember(viewer), 'maintainer');

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
const questionFor = (viewer: BoardViewer, blocked: Blocked): string =>
  seesTechnical(viewer) ||
  ('memberId' in blocked.askedOf
    ? blocked.askedOf.memberId === viewer.memberId
    : hasRole(viewerMember(viewer), blocked.askedOf.role))
    ? blocked.question
    : HIDDEN_QUESTION;

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
}

interface ProjectFacts {
  readonly members: Awaited<ReturnType<typeof listProjectMembers>>;
  readonly names: ReadonlyMap<string, string>;
  readonly rawConfig: unknown;
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
    return { gate, planned: false, pending: [], waived: [], approvedBy: [] };
  const approvals = await listApprovedSubjects(pool, row.id);
  const result = evaluatePolicy(effectivePolicy(config.config, row, gate), approvals, {
    members: facts.members,
    requesterId: row.requesterId,
    userVisible: row.userVisible,
    subject
  });
  return {
    gate,
    planned: true,
    pending: result.pending,
    waived: result.waived,
    approvedBy: approvals
      .filter((approval) => approval.subject === subject)
      .map((approval) => facts.names.get(approval.memberId) ?? 'a former member')
  };
};

const canAnswer = (row: BoardTaskRow, viewer: BoardViewer) => {
  if (!row.blocked) return false;
  const askedOf = row.blocked.askedOf;
  return (
    viewer.role === 'owner' ||
    ('memberId' in askedOf
      ? askedOf.memberId === viewer.memberId
      : hasRole(viewerMember(viewer), askedOf.role))
  );
};

const waitingOn = (
  row: BoardTaskRow,
  viewer: BoardViewer,
  approval: ApprovalState | null,
  onboarding: number | null
): WaitingOn => {
  const member = viewerMember(viewer);
  if (TERMINAL_STAGES.has(row.stage)) return { kind: 'nobody', label: row.stage, me: false };
  if (row.blocked) {
    const askedOf = row.blocked.askedOf;
    return {
      kind: 'people',
      label: `A question for ${'memberId' in askedOf ? 'a member' : article(askedOf.role)}`,
      me: canAnswer(row, viewer)
    };
  }
  if (row.paused) return { kind: 'people', label: 'Paused', me: hasRole(member, 'maintainer') };
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
        me: hasRole(member, 'maintainer')
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
          pending.some((requirement) => isEligible(member, requirement, row.requesterId)) ||
          (Boolean(asked) && pending.length > 0 && hasRole(member, 'contributor'))
      };
    }
    case 'ready':
      return row.kind === 'request' && onboarding !== null
        ? {
            kind: 'agent',
            label: `Builds once the agent docs of task ${onboarding} are merged`,
            me: false
          }
        : { kind: 'agent', label: 'Waiting for a build slot', me: false };
    case 'building':
      return row.assignee?.kind === 'member'
        ? {
            kind: 'people',
            label: 'A person is building it',
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
        : { kind: 'github', label: 'Merge on GitHub', me: hasRole(member, 'maintainer') };
    default:
      return { kind: 'nobody', label: row.stage, me: false };
  }
};

const actionsFor = (row: BoardTaskRow, viewer: BoardViewer): BoardAction[] => {
  const member = viewerMember(viewer);
  if (TERMINAL_STAGES.has(row.stage)) return hasRole(member, 'contributor') ? ['comment'] : [];
  const actions: BoardAction[] = [];
  if (
    row.stage === 'request' &&
    hasRole(member, 'contributor') &&
    (row.requesterId === viewer.memberId || hasRole(member, 'maintainer'))
  )
    actions.push('submit');
  if (row.blocked) {
    if (canAnswer(row, viewer)) actions.push('answer');
  } else if (!row.paused) {
    if (row.stage === 'triage' && hasRole(member, 'maintainer')) actions.push('accept', 'decline');
    if (
      (row.stage === 'spec_review' || row.stage === 'verifying') &&
      hasRole(member, 'contributor') &&
      row.approvalPlans[row.stage]?.subject === gateSubject(row, row.stage)
    )
      actions.push('approve', 'changes');
  }
  if (
    hasRole(member, 'maintainer') ||
    (row.requesterId === viewer.memberId && hasRole(member, 'contributor'))
  )
    actions.push('cancel');
  if (hasRole(member, 'contributor')) actions.push('comment');
  return actions;
};

const projectFacts = async (pool: Pool, viewer: BoardViewer): Promise<ProjectFacts> => {
  const [members, names, config, onboarding] = await Promise.all([
    listProjectMembers(pool, viewer.projectId),
    memberNames(pool, viewer.workspaceId),
    pool.query<{ config: unknown }>('select config from projects where id = $1', [
      viewer.projectId
    ]),
    openOnboardingTask(pool, viewer.projectId)
  ]);
  return {
    members,
    names,
    rawConfig: config.rows[0]?.config,
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
  blocked: row.blocked ? { question: questionFor(viewer, row.blocked) } : null,
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
  waitingOn: waitingOn(row, viewer, approval, facts.onboarding)
});

const DEPTH_LABELS = {
  glance: 'A careful read is enough',
  test: 'Try it by hand',
  device: 'Test it on a real device'
} as const;

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
    // Who will merge the result: the chooser's choice, which the project may not allow.
    merge:
      gate === 'verifying'
        ? plan.merge === 'auto' && config.ok && config.config.pullRequest.autoMerge
          ? ('auto' as const)
          : ('person' as const)
        : null,
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

export const boardView = async (pool: Pool, viewer: BoardViewer) => {
  const facts = await projectFacts(pool, viewer);
  const rows = await listBoardTasks(pool, viewer.projectId);
  return Promise.all(
    rows.map(async (row) => cardView(row, viewer, await approvalState(pool, row, facts), facts))
  );
};

const consoleUrl = (workspace: string | undefined, sessionId: string | null) =>
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
  const [approval, context, specs, comments, events, runs, chooser] = await Promise.all([
    approvalState(pool, row, facts),
    loadTaskContext(pool, row.id),
    listSpecVersions(pool, row.id),
    listTaskComments(pool, row.id),
    listTaskEvents(pool, row.id),
    listTaskRuns(pool, row.id),
    latestChooserResult(pool, row.id)
  ]);
  const label = (actor: Actor) => actorLabel(actor, facts.names);
  const [request, ...thread] = comments;
  return {
    ...cardView(row, viewer, approval, facts),
    blocked: row.blocked
      ? {
          question: questionFor(viewer, row.blocked),
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
  const canDecide = hasRole(
    { id: viewer.memberId, role: viewer.role, domains: viewer.domains },
    'maintainer'
  );
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
