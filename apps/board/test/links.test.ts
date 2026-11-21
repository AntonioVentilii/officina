/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { LINK_SENTENCES } from '../src/lib/links';

describe('LINK_SENTENCES', () => {
  test('a change of links names the parent and the tasks waited for, or says they were removed', () => {
    const linked = LINK_SENTENCES.links_changed!;
    expect(linked({ parent: 2, after: [3, 5] })).toBe(
      'linked it: parent task 2, waits for tasks 3, 5'
    );
    expect(linked({ parent: null, after: [3] })).toBe('linked it: waits for task 3');
    expect(linked({ parent: null, after: [] })).toBe('removed its links');
  });

  test('a parent closed by its sub-tasks names the ones that merged', () => {
    expect(LINK_SENTENCES.subtasks_merged!({ subtasks: [3, 4] })).toBe(
      'closed it: no sub-task left open, tasks 3, 4 merged'
    );
  });
});
