import type { ChecklistView } from './checklist';
import type { LearningPullRequest } from './learning-types';

export type * from './learning-types';

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
  | 'build'
  | 'steer'
  | 'see_runs'
  | 'decide_learnings'
  | 'merge'
  | 'see_confidential'
  | 'publish'
  | 'manage_members'
  | 'see_access_log';

/** One line of the owners' access log: when, whose access, and what happened in words. */
export interface AccessEvent {
  readonly id: string;
  readonly at: string;
  readonly member: string;
  readonly text: string;
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
  | 'keep_whole'
  | 'answer'
  | 'cancel'
  | 'comment';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly role: Role;
  readonly domains: readonly string[];
  readonly look: Look;
  readonly can: readonly Permission[];
}

export type Look = 'fucina' | 'modernista' | 'tecnica';

export interface Me {
  readonly member: { readonly id: string; readonly name: string; readonly email: string };
  readonly projects: readonly Project[];
  readonly github: { readonly login: string } | null;
  readonly githubAvailable: boolean;
  /** The connector's address, to add Officina to Claude. */
  readonly connectorUrl: string;
  readonly limits: InputLimits;
}

/** How long what a person types may be, the ceilings the API checks (`INPUT_LIMITS`). */
export type InputLimits = Readonly<
  Record<'title' | 'prTitle', { readonly min: number; readonly max: number }>
> & { readonly prBody: number; readonly memberName: number };

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
  readonly blocked: {
    readonly question: string;
    readonly askedOf?: string;
    /** What agents need from a person to go on; empty for an ordinary question. */
    readonly needs: readonly string[];
  } | null;
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
  /** Pull requests opened for the task's learnings; empty for those who do not see learnings. */
  readonly learningPullRequests: readonly LearningPullRequest[];
  /** A hand-in of the build under way, on any board or from the CLI, while its claim holds. */
  readonly handingIn: {
    /** Who is handing it in; null for a claim that names nobody. */
    readonly by: string | null;
    readonly you: boolean;
    readonly since: string;
  } | null;
  readonly waitingOn: WaitingOn;
  /** What the task touches that only the owner may let through, in words. */
  readonly guards: readonly string[];
}

/** A role on the Agents page, with its numbers over the runs the page lists. */
export interface AgentRoleInfo {
  readonly role: string;
  readonly label: string;
  readonly does: string;
  readonly running: boolean;
  readonly runs: number;
  /** The share of its finished runs that succeeded, in percent; null before one finishes. */
  readonly success: number | null;
  readonly costCents: number;
}

export interface Run {
  readonly id: string;
  readonly taskNumber: number;
  readonly taskTitle: string;
  readonly role: string;
  readonly label: string;
  readonly agentVersion: number;
  readonly stage: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
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
  /** The connected app a member acted through, by the name it gave itself; null on the board. */
  readonly via: Via | null;
  readonly payload: Record<string, unknown>;
  readonly at: string;
}

export interface Comment {
  readonly id: string;
  readonly author: string;
  readonly authorKind: 'member' | 'agent' | 'engine';
  readonly via: Via | null;
  readonly body: string;
  readonly at: string;
}

export interface BeforeAfter {
  readonly key: string;
  readonly locale: string;
  readonly before: string;
  readonly after: string;
}

/** What choosing an option would look like; agent-written, so only ever rendered sanitized. */
export type OptionPreview =
  | { readonly kind: 'text'; readonly before: string; readonly after: string }
  | { readonly kind: 'markdown' | 'html'; readonly body: string }
  | { readonly kind: 'link'; readonly url: string; readonly label?: string };

export interface QuestionOption {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly preview?: OptionPreview;
}

export interface TaskDetail extends Card {
  readonly blocked:
    | (NonNullable<Card['blocked']> & {
        readonly options: readonly QuestionOption[];
        /** The task version the question was read at; a picked option sends it back. */
        readonly version: number;
      })
    | null;
  readonly repo: string | null;
  /** The task branch a person who claimed the build pushes to. */
  readonly branch: string;
  readonly pullRequestUrl: string | null;
  readonly headSha: string | null;
  /** More lines than its lane allows, granted for this task alone; `null` when none was. */
  readonly allowance: Readonly<{ lines: number; lane: Lane; by: string; at: string | null }> | null;
  readonly request: Pick<Comment, 'author' | 'via' | 'body' | 'at'> | null;
  readonly comments: readonly Comment[];
  readonly specs: readonly (Pick<Comment, 'author' | 'body' | 'at'> & {
    readonly version: number;
    /** The version proposes a split into sub-tasks instead of one spec. */
    readonly split: boolean;
  })[];
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
      /** Why nobody had to approve this gate, when the lifecycle skipped it; otherwise `null`. */
      readonly skipped: string | null;
      readonly requirements: readonly {
        readonly label: string;
        readonly who: readonly { readonly name: string; readonly approved: boolean }[];
        readonly waived: boolean;
      }[];
      readonly asked: readonly string[];
    }[];
    /** Who builds it: the agent, or a developer who claims it, and why. */
    readonly build: {
      readonly by: 'agent' | 'person';
      readonly reason: string | null;
      readonly who: readonly string[];
    };
    readonly merge: { readonly by: 'person' | 'auto'; readonly who: readonly string[] };
  };
  readonly approval: {
    readonly gate: 'spec_review' | 'verifying';
    readonly planned: boolean;
    readonly pending: readonly string[];
    readonly waived: readonly string[];
    readonly approvedBy: readonly string[];
  } | null;
  readonly checklist: ChecklistView | null;
  readonly actions: readonly BoardAction[];
  /** Your approval Claude proposed, by the app's own name: it counts once you approve here. */
  readonly proposal: { readonly gate: 'spec_review' | 'verifying'; readonly via: Via } | null;
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

export interface MemberActivity {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly domains: readonly string[];
  readonly firstSignedInAt: string | null;
  readonly link: {
    readonly state: 'pending' | 'used' | 'expired';
    readonly createdAt: string;
    readonly usedAt: string | null;
    readonly expiresAt: string;
  } | null;
  readonly lastSeenAt: string | null;
  readonly claudeConnected: boolean;
  /** Whether you may send them a fresh invite link. */
  readonly invitable: boolean;
  /** Whether you may change their name: your own, or one you manage in every project. */
  readonly renamable: boolean;
}

export interface Notice {
  readonly id: string;
  readonly kind: 'invite_accepted';
  readonly text: string;
  readonly createdAt: string;
}

/** An app the member allowed to act as them through the connector, until they revoke it. */
export interface ConnectedApp {
  readonly id: string;
  /** How it is told apart from another app with the same name, here and in the history. */
  readonly connection: string;
  /** The name the app gave itself when it registered; Officina has not verified it. */
  readonly client: string;
  readonly returnsTo: readonly string[];
  readonly renewedAt: string;
}

/** The app a member acted through, as the history shows it: "via Claude", its name, its connection. */
export type Via = Pick<ConnectedApp, 'id' | 'client' | 'connection'> & { readonly label: string };

/** Why a GitHub sign-in did not complete, as the API puts it in `/signin?error=`. */
export type GitHubSignInProblem =
  'github_mismatch' | 'github_expired' | 'github_not_linked' | 'github_linked_elsewhere';

/** Why the connector's consent page cannot show a request, as the API sends it. */
export type AuthorizationProblem =
  | 'unknown_client'
  | 'unregistered_redirect'
  | 'unsupported_response_type'
  | 'pkce_required'
  | 'unknown_resource'
  | 'unknown_scope';

/** Why a connected app could not be revoked, as the API sends it. */
export type ConnectedAppProblem = 'unknown_grant';
