import { describe, expect, test } from 'bun:test';
import { linkSentence } from '../src/lib/links';

describe('linkSentence', () => {
  test("says a task's links, their removal, and its sub-tasks merging", () => {
    expect(linkSentence({ type: 'links_changed', payload: { parent: 2, after: [3, 5] } })).toBe(
      'linked it: parent task 2, waits for tasks 3, 5'
    );
    expect(linkSentence({ type: 'links_changed', payload: { parent: null, after: [] } })).toBe(
      'removed its links'
    );
    expect(linkSentence({ type: 'subtasks_merged', payload: { subtasks: [3, 4] } })).toBe(
      'closed it: every sub-task merged (tasks 3, 4)'
    );
    expect(linkSentence({ type: 'paused', payload: {} })).toBeNull();
  });
});
