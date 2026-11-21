/**
 * The agent runs of a project as the API sends them (`runsView` and the task views in
 * `apps/api/src/board.ts`), each role's numbers on the Agents page and a run log's entries.
 * `types.ts` re-exports them.
 */

/** What a run's session read and wrote, in tokens; cache writes of every lifetime are one count. */
export interface RunTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
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
  readonly tokens: RunTokens;
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
  /** The model the session ran at, its effort and why; null for runs from before the choice. */
  readonly model: { readonly id: string; readonly effort: string; readonly reason: string } | null;
  readonly costCents: number | null;
  /** None while the run is going, or when its session's usage could not be read. */
  readonly tokens: RunTokens | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly eventCount: number;
  readonly consoleUrl: string | null;
  readonly result: unknown;
}

export type LogEntry = { readonly id: string; readonly at: string } & (
  | { readonly kind: 'message' | 'brief'; readonly text: string }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'tool'; readonly name: string; readonly summary: string }
  | { readonly kind: 'tool_result'; readonly text: string; readonly isError: boolean }
  | { readonly kind: 'submitted'; readonly outcome: string }
  | { readonly kind: 'feedback' | 'error'; readonly text: string }
  | { readonly kind: 'status'; readonly status: string }
  | {
      readonly kind: 'thread';
      readonly direction: 'question' | 'answer';
      readonly thread: string;
      readonly agent: string | null;
      readonly text: string;
    }
  | { readonly kind: 'officina'; readonly type: string; readonly payload: unknown }
);
