/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { isOpen } from '../src/lib/stages';
import type { Stage } from '../src/lib/types';

describe('isOpen', () => {
  test('a task is open until it is shipped, declined or cancelled', () => {
    const open: Stage[] = ['request', 'triage', 'speccing', 'building', 'verifying', 'merging'];
    for (const stage of open) expect(isOpen(stage)).toBe(true);
    for (const stage of ['done', 'declined', 'cancelled'] as const)
      expect(isOpen(stage)).toBe(false);
  });
});
