import { describe, expect, test } from 'bun:test';
import type { BetaManagedAgentsStreamSessionEvents } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import { portEvents } from '../src/sdk';

const RUNNING = {
  type: 'session.status_running',
  id: 'sevt_1',
  processed_at: '2026-11-13T10:00:00Z'
} satisfies BetaManagedAgentsStreamSessionEvents;
const PREVIEW = {
  type: 'event_delta',
  event_id: 'sevt_2',
  delta: { type: 'content_delta', content: { type: 'text', text: 'Hel' } }
} satisfies BetaManagedAgentsStreamSessionEvents;
const TOOL_USE = {
  type: 'agent.custom_tool_use',
  id: 'sevt_2',
  name: 'submit_result',
  input: { result: { summary: 'done' } },
  processed_at: '2026-11-13T10:00:01Z'
} satisfies BetaManagedAgentsStreamSessionEvents;

/** The SDK's stream as `openStream` receives it, with the events above. */
async function* stream(): AsyncGenerator<BetaManagedAgentsStreamSessionEvents> {
  yield* [RUNNING, PREVIEW, TOOL_USE];
}

describe('the SDK port', () => {
  test('streams each session event with every field, and no previews', async () => {
    const events = [];
    for await (const event of portEvents(stream())) events.push(event);
    expect(events).toEqual([RUNNING, TOOL_USE]);
  });
});
