// The board's own types are the browser's; its tests run under Bun.
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { Learning } from '../src/lib/learning-types';
import { learningWork, taskWork } from '../src/lib/working';

const learning = (overrides: Partial<Learning> = {}): Learning => ({
  id: 'l1',
  title: 'Say what the deck is',
  lesson: 'The deck is the room.',
  evidence: 'Asked twice.',
  target: 'project',
  file: 'docs/SPEC.md',
  find: null,
  text: 'The room is the deck.',
  status: 'proposed',
  taskNumber: 2,
  taskTitle: 'Deck',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  rewrite: null,
  rewrittenAt: null,
  createdAt: '2026-11-17T10:00:00Z',
  canDecide: true,
  deciding: null,
  ...overrides
});

const SINCE = '2026-11-20T09:00:00Z';

describe('the work under way on a learning', () => {
  test('nothing is under way until someone decides it', () => {
    expect(learningWork(learning(), null)).toBeNull();
  });

  test('a decision the API reports is shown with who made it, on every board', () => {
    const deciding = { decision: 'accept' as const, by: 'Marco', you: false, since: SINCE };
    expect(learningWork(learning({ deciding }), null)).toEqual({
      label: 'Accepting',
      detail: 'opening its pull request on GitHub',
      who: 'Marco',
      since: SINCE
    });
    expect(learningWork(learning({ deciding: { ...deciding, you: true } }), null)?.who).toBe('You');
  });

  test('the API wins over the decision this board sent, which shows only until the API reports', () => {
    const sent = { decision: 'reject' as const, since: '2026-11-20T09:00:05Z' };
    expect(learningWork(learning(), sent)).toMatchObject({ label: 'Rejecting', who: 'You' });
    const deciding = { decision: 'accept' as const, by: 'Marco', you: false, since: SINCE };
    expect(learningWork(learning({ deciding }), sent)).toMatchObject({
      label: 'Accepting',
      who: 'Marco'
    });
  });

  test('an agent learning opens no pull request, and an unnamed claim still reads as work', () => {
    expect(
      learningWork(learning({ target: 'agent' }), { decision: 'accept', since: SINCE })?.detail
    ).toBe('recording it for the Officina prompts');
    expect(
      learningWork(
        learning({ deciding: { decision: null, by: null, you: false, since: SINCE } }),
        null
      )
    ).toEqual({ label: 'Deciding', detail: '', who: null, since: SINCE });
  });
});

describe('the work under way on a task', () => {
  test('nothing is under way until an action is sent or a build is handed in', () => {
    expect(taskWork({ handingIn: null }, null)).toBeNull();
  });

  test('a hand-in the API reports is shown with who makes it, on every board', () => {
    expect(
      taskWork({ handingIn: { by: 'Giulia Conti', you: false, since: SINCE } }, null)
    ).toMatchObject({ label: 'Handing in', who: 'Giulia Conti', since: SINCE });
  });

  test('an action this board sent is shown as its own until the reload lands', () => {
    expect(taskWork({ handingIn: null }, { action: 'claim', since: SINCE })).toMatchObject({
      label: 'Claiming',
      who: 'You',
      since: SINCE
    });
  });

  test('a hand-in under way wins over the action this board sent', () => {
    expect(
      taskWork(
        { handingIn: { by: 'Giulia Conti', you: true, since: SINCE } },
        { action: 'hand_in', since: '2026-11-20T09:00:05Z' }
      )
    ).toMatchObject({ label: 'Handing in', who: 'You', since: SINCE });
  });
});
