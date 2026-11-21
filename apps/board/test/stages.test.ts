/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { isOpen, STAGE_LABELS, stageHue, stampFor } from '../src/lib/stages';
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

describe('stageHue', () => {
  test('every open stage and done has its column hue, a closed task has none', () => {
    for (const stage of STAGES) {
      const closed = stage === 'declined' || stage === 'cancelled';
      expect([stage, stageHue(stage) === undefined]).toEqual([stage, closed]);
    }
    expect(stageHue('building')).toBe(stageHue('reviewing'));
    expect(stageHue('building')).not.toBe(stageHue('speccing'));
  });
});

describe('stampFor', () => {
  test('an approved plan, an accepted result and a shipped task are stamped', () => {
    expect(stampFor('spec_review', 'ready')).toBe('approved');
    expect(stampFor('spec_review', 'building')).toBe('approved');
    expect(stampFor('verifying', 'merging')).toBe('accepted');
    expect(stampFor('merging', 'done')).toBe('shipped');
  });

  test('a plan or a result sent back, and every other move, stamps nothing', () => {
    expect(stampFor('spec_review', 'speccing')).toBeNull();
    expect(stampFor('verifying', 'building')).toBeNull();
    expect(stampFor('building', 'reviewing')).toBeNull();
    expect(stampFor('triage', 'declined')).toBeNull();
    for (const stage of STAGES) expect(stampFor(stage, stage)).toBeNull();
  });
});
