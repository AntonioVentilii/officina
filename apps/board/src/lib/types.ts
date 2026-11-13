export type Stage =
  | 'request'
  | 'triage'
  | 'speccing'
  | 'spec_review'
  | 'ready'
  | 'building'
  | 'reviewing'
  | 'choosing'
  | 'verifying'
  | 'merging'
  | 'done'
  | 'declined'
  | 'cancelled';

export type Lane = 'green' | 'standard' | 'red';
export type Role = 'watcher' | 'contributor' | 'maintainer' | 'owner';
/** What a member may do in a project: the permission matrix's actions, as the API sends them. */
export type Permission =
  | 'see'
  | 'request'
  | 'comment'
  | 'answer'
  | 'approve_spec'
  | 'verify_result'
  | 'triage'
  | 'steer'
  | 'see_runs'
  | 'decide_learnings'
  | 'merge'
  | 'manage_members';
export type BoardAction =
  'submit' | 'accept' | 'decline' | 'approve' | 'changes' | 'answer' | 'cancel' | 'comment';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly role: Role;
  readonly domains: readonly string[];
  readonly look: Look;
  readonly can: readonly Permission[];
}

export type Look = 'modernista' | 'tecnica';

export interface Me {
  readonly member: { readonly id: string; readonly name: string; readonly email: string };
  readonly projects: readonly Project[];
  readonly github: { readonly login: string } | null;
  readonly githubAvailable: boolean;
}

export interface WaitingOn {
  readonly kind: 'agent' | 'people' | 'github' | 'nobody';
  readonly label: string;
  readonly me: boolean;
}

export interface RunningAgent {
  readonly role: string;
  readonly label: string;
}

export interface Card {
  readonly number: number;
  readonly title: string;
  readonly stage: Stage;
  readonly lane: Lane | null;
  readonly blocked: { readonly question: string; readonly askedOf?: string } | null;
  readonly paused: boolean;
  readonly userVisible: boolean;
  readonly requester: string;
  readonly pullRequest: number | null;
  /** Only for maintainers and owners; `null` for everyone else. */
  readonly costCents: number | null;
  readonly running: readonly RunningAgent[];
  readonly fixRounds: number;
  readonly specVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stageSince: string;
  /** The result skipped people's check (a low-risk change); GitHub's rules merge it. */
  readonly autoVerified: boolean;
  /** GitHub's auto-merge is on: it merges once checks pass, no person needs to press merge. */
  readonly autoMergeOn: boolean;
  readonly waitingOn: WaitingOn;
  /** What the task touches that only the owner may let through, in words. */
  readonly guards: readonly string[];
}

/** A role on the Agents page, named and described by the API. */
export interface AgentRoleInfo {
  readonly role: string;
  readonly label: string;
  readonly does: string;
}

export interface Run {
  readonly id: string;
  readonly taskNumber: number;
  readonly taskTitle: string;
  readonly role: string;
  readonly label: string;
  readonly agentVersion: number;
  readonly stage: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly costCents: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly eventCount: number;
  readonly consoleUrl: string | null;
  readonly result: unknown;
}

export interface TaskEvent {
  readonly id: string;
  readonly type: string;
  readonly actor: string;
  readonly actorKind: 'member' | 'agent' | 'engine';
  readonly actorRole: string | null;
  readonly payload: Record<string, unknown>;
  readonly at: string;
}

export interface Comment {
  readonly id: string;
  readonly author: string;
  readonly authorKind: 'member' | 'agent' | 'engine';
  readonly body: string;
  readonly at: string;
}

export interface BeforeAfter {
  readonly key: string;
  readonly locale: string;
  readonly before: string;
  readonly after: string;
}

export interface TaskDetail extends Card {
  readonly repo: string | null;
  readonly pullRequestUrl: string | null;
  readonly headSha: string | null;
  readonly request: { readonly author: string; readonly body: string; readonly at: string } | null;
  readonly comments: readonly Comment[];
  readonly specs: readonly {
    readonly version: number;
    readonly body: string;
    readonly author: string;
    readonly at: string;
  }[];
  readonly events: readonly TaskEvent[];
  readonly runs: readonly Run[];
  readonly plan: {
    readonly gate: 'spec_review' | 'verifying';
    readonly current: boolean;
    readonly depth: 'glance' | 'test' | 'device';
    readonly depthLabel: string;
    /** At the result: whether a person merges or GitHub does once its checks pass. */
    readonly merge: 'person' | 'auto' | null;
    readonly rationale: string;
    readonly extra: readonly { readonly label: string; readonly reason: string }[];
    readonly verifiers: readonly { readonly name: string; readonly reason: string }[];
  } | null;
  /** Who asked, who the approval policy expects at each gate, and who merges. */
  readonly people: {
    readonly requester: string;
    readonly gates: readonly {
      readonly gate: 'spec_review' | 'verifying';
      readonly does: string;
      readonly current: boolean;
      readonly requirements: readonly {
        readonly label: string;
        readonly who: readonly string[];
        readonly waived: boolean;
        readonly approvedBy: readonly string[];
      }[];
      readonly asked: readonly string[];
    }[];
    readonly merge: { readonly by: 'person' | 'auto'; readonly who: readonly string[] };
  };
  readonly approval: {
    readonly gate: 'spec_review' | 'verifying';
    readonly planned: boolean;
    readonly pending: readonly string[];
    readonly waived: readonly string[];
    readonly approvedBy: readonly string[];
  } | null;
  readonly checklist: {
    readonly checklist: readonly string[];
    readonly beforeAfter?: readonly BeforeAfter[];
    readonly userVisible: boolean;
  } | null;
  readonly actions: readonly BoardAction[];
}

export type LogEntry = { readonly id: string; readonly at: string } & (
  | { readonly kind: 'message' | 'brief'; readonly text: string }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'tool'; readonly name: string; readonly summary: string }
  | { readonly kind: 'tool_result'; readonly text: string; readonly isError: boolean }
  | { readonly kind: 'submitted'; readonly outcome: string }
  | { readonly kind: 'feedback' | 'error'; readonly text: string }
  | { readonly kind: 'status'; readonly status: string }
  | { readonly kind: 'officina'; readonly type: string; readonly payload: unknown }
);

export interface Learning {
  readonly id: string;
  readonly title: string;
  readonly lesson: string;
  readonly evidence: string;
  readonly target: 'docs' | 'project' | 'agent';
  readonly file: string;
  readonly find: string | null;
  readonly text: string;
  readonly status: 'proposed' | 'accepted' | 'rejected' | 'applied';
  readonly taskNumber: number | null;
  readonly taskTitle: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly createdAt: string;
  readonly canDecide: boolean;
}
