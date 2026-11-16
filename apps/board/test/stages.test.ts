/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { isOpen, STAGE_LABELS } from '../src/lib/stages';
import type { Stage } from '../src/lib/types';

// Every stage the board knows, so a stage added later is checked too.
const STAGES = Object.keys(STAGE_LABELS) as Stage[];
const TERMINAL: readonly Stage[] = ['done', 'declined', 'cancelled'];

describe('isOpen', () => {
  test('a task is open until it is shipped, declined or cancelled', () => {
    for (const stage of STAGES)
      expect([stage, isOpen(stage)]).toEqual([stage, !TERMINAL.includes(stage)]);
  });
});
