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
export type BoardAction =
  'accept' | 'decline' | 'approve' | 'changes' | 'answer' | 'cancel' | 'comment';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly role: Role;
  readonly domains: readonly string[];
}

export interface Me {
  readonly member: { readonly id: string; readonly name: string; readonly email: string };
  readonly projects: readonly Project[];
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
  readonly costCents: number;
  readonly running: readonly RunningAgent[];
  readonly fixRounds: number;
  readonly specVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stageSince: string;
  readonly waitingOn: WaitingOn;
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
  readonly approval: {
    readonly gate: 'spec_review' | 'verifying';
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
