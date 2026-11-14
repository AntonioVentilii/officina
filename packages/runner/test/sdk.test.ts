import { describe, expect, test } from 'bun:test';
import { createSdkPort } from '../src';

const RUNNING = {
  type: 'session.status_running',
  id: 'sevt_1',
  processed_at: '2026-11-13T10:00:00Z'
};
const PREVIEW = {
  type: 'event_delta',
  event_id: 'sevt_2',
  delta: { type: 'content_delta', text: 'Hel' }
};
const TOOL_USE = {
  type: 'agent.custom_tool_use',
  id: 'sevt_2',
  name: 'submit_result',
  input: { result: { summary: 'done' } },
  processed_at: '2026-11-13T10:00:01Z'
};

/** Only the call `openStream` makes, answering with the events above. */
const client = {
  beta: {
    sessions: {
      events: {
        stream: async () =>
          (async function* () {
            yield* [RUNNING, PREVIEW, TOOL_USE];
          })()
      }
    }
  }
} as unknown as Parameters<typeof createSdkPort>[0];

describe('the SDK port', () => {
  test('streams each session event with every field, and no previews', async () => {
    const events = [];
    for await (const event of await createSdkPort(client).openStream('sesn_1')) events.push(event);
    expect(events).toEqual([RUNNING, TOOL_USE]);
  });
});
