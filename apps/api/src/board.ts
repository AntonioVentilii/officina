import {
  REVIEWER_ROLES,
  TERMINAL_STAGES,
  evaluatePolicy,
  hasRole,
  isEligible,
  parseProjectConfig,
  type Actor,
  type Gate,
  type Member,
  type Requirement,
  type Role
} from '@officina/core';
import {
  latestChooserResult,
  listApprovedSubjects,
  listBoardTasks,
  listProjectMembers,
  listProjectRuns,
  listRunEvents,
  listSpecVersions,
  listTaskComments,
  listTaskEvents,
  listTaskRuns,
  loadBoardTask,
  loadTaskContext,
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
  'accept' | 'decline' | 'approve' | 'changes' | 'answer' | 'cancel' | 'comment';

export interface BoardViewer {
  readonly memberId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly role: Role;
  readonly domains: readonly string[];
}

const ROLE_LABELS: Record<string, string> = {
  interviewer: 'Interviewer',
  spec: 'Spec writer',
  builder: 'Builder',
  reviewer_spec: 'Spec reviewer',
  reviewer_correctness: 'Code reviewer',
  chooser: 'Verification guide',
  learner: 'Learner'
};

export const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;

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

interface ApprovalState {
  readonly gate: Gate;
  readonly pending: readonly Requirement[];
  readonly waived: readonly Requirement[];
  readonly approvedBy: readonly string[];
}

interface ProjectFacts {
  readonly members: Awaited<ReturnType<typeof listProjectMembers>>;
  readonly names: ReadonlyMap<string, string>;
  readonly rawConfig: unknown;
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
  const subject = gate === 'spec_review' ? `spec:${row.specVersion}` : `sha:${row.headSha}`;
  const approvals = await listApprovedSubjects(pool, row.id);
  const result = evaluatePolicy(config.config.lanes[row.lane].approvals[gate], approvals, {
    members: facts.members,
    requesterId: row.requesterId,
    userVisible: row.userVisible,
    subject
  });
  return {
    gate,
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
  approval: ApprovalState | null
): WaitingOn => {
  const member = viewerMember(viewer);
  if (TERMINAL_STAGES.has(row.stage)) return { kind: 'nobody', label: row.stage, me: false };
  if (row.blocked) {
    const askedOf = row.blocked.askedOf;
    return {
      kind: 'people',
      label: `Question for ${'memberId' in askedOf ? 'a member' : article(askedOf.role)}`,
      me: canAnswer(row, viewer)
    };
  }
  if (row.paused) return { kind: 'people', label: 'Paused', me: hasRole(member, 'maintainer') };
  const running = row.runningRoles.map(roleLabel);
  switch (row.stage) {
    case 'request':
      return { kind: 'people', label: 'Draft request', me: row.requesterId === viewer.memberId };
    case 'triage':
      return { kind: 'people', label: 'Triage by a maintainer', me: hasRole(member, 'maintainer') };
    case 'speccing':
      return {
        kind: 'agent',
        label: running.length ? 'Spec writer at work' : 'Spec writer up next',
        me: false
      };
    case 'spec_review':
    case 'verifying': {
      const pending = approval?.pending ?? [];
      const noun = row.stage === 'spec_review' ? 'Spec approval' : 'Verification';
      return {
        kind: 'people',
        label: pending.length
          ? `${noun} by ${readable(pending).map(describeRequirement).join(' and ')}`
          : noun,
        me: pending.some((requirement) => isEligible(member, requirement, row.requesterId))
      };
    }
    case 'ready':
      return { kind: 'agent', label: 'Waiting for a build slot', me: false };
    case 'building':
      return row.assignee?.kind === 'member'
        ? {
            kind: 'people',
            label: 'A person is building it',
            me: row.assignee.memberId === viewer.memberId
          }
        : {
            kind: 'agent',
            label: running.length ? 'Builder at work' : 'Builder up next',
            me: false
          };
    case 'reviewing':
      return {
        kind: 'agent',
        label: running.length ? `${running.join(' and ')} at work` : 'Reviews up next',
        me: false
      };
    case 'choosing':
      return { kind: 'agent', label: 'Preparing the verification checklist', me: false };
    case 'merging':
      return { kind: 'github', label: 'Merge on GitHub', me: hasRole(member, 'maintainer') };
    default:
      return { kind: 'nobody', label: row.stage, me: false };
  }
};

const actionsFor = (row: BoardTaskRow, viewer: BoardViewer): BoardAction[] => {
  const member = viewerMember(viewer);
  if (TERMINAL_STAGES.has(row.stage)) return hasRole(member, 'contributor') ? ['comment'] : [];
  const actions: BoardAction[] = [];
  if (row.blocked) {
    if (canAnswer(row, viewer)) actions.push('answer');
  } else if (!row.paused) {
    if (row.stage === 'triage' && hasRole(member, 'maintainer')) actions.push('accept', 'decline');
    if (
      (row.stage === 'spec_review' || row.stage === 'verifying') &&
      hasRole(member, 'contributor')
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
  const [members, names, config] = await Promise.all([
    listProjectMembers(pool, viewer.projectId),
    memberNames(pool, viewer.workspaceId),
    pool.query<{ config: unknown }>('select config from projects where id = $1', [viewer.projectId])
  ]);
  return { members, names, rawConfig: config.rows[0]?.config };
};

const cardView = (row: BoardTaskRow, viewer: BoardViewer, approval: ApprovalState | null) => ({
  number: row.number,
  title: row.title,
  stage: row.stage,
  lane: row.lane,
  blocked: row.blocked ? { question: row.blocked.question } : null,
  paused: row.paused,
  userVisible: row.userVisible,
  requester: row.requesterName,
  pullRequest: row.pullRequest,
  costCents: row.costCents,
  running: row.runningRoles.map((role) => ({ role, label: roleLabel(role) })),
  fixRounds: row.fixRounds,
  specVersion: row.specVersion,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  stageSince: row.stageSince,
  waitingOn: waitingOn(row, viewer, approval)
});

export type CardView = ReturnType<typeof cardView>;

export const boardView = async (pool: Pool, viewer: BoardViewer) => {
  const facts = await projectFacts(pool, viewer);
  const rows = await listBoardTasks(pool, viewer.projectId);
  return Promise.all(
    rows.map(async (row) => cardView(row, viewer, await approvalState(pool, row, facts)))
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
    ...cardView(row, viewer, approval),
    blocked: row.blocked
      ? {
          question: row.blocked.question,
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
      payload: event.payload,
      at: event.createdAt
    })),
    runs: runs.map((run) => runView(run, consoleWorkspace)),
    approval: approval && {
      gate: approval.gate,
      pending: readable(approval.pending).map(describeRequirement),
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
