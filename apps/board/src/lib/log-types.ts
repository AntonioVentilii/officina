/**
 * A run's log as the API sends it (`logEntries` in `apps/api/src/board.ts`): one entry per session
 * event people read. `types.ts` re-exports it.
 */

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
