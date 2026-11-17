import { describe, expect, test } from 'bun:test';
import { latestChecks, stillOpen, type ChecklistView } from '../src/lib/checklist';

const view = (checks: ChecklistView['checks']): ChecklistView => ({
  checklist: ['Read the title', 'Open the page', 'Run curl'],
  userVisible: true,
  headSha: 'abc',
  checks,
  outcomes: [],
  canCheck: true
});

const check = (item: number, outcome: string, outcomeLabel = outcome) => ({
  item,
  outcome,
  outcomeLabel,
  by: 'Antonio via Claude',
  evidence: '',
  at: '2026-11-16T10:00:00Z'
});

describe('checklist', () => {
  test("an item's latest check is where it stands, after a problem was fixed", () => {
    const latest = latestChecks(view([check(1, 'problem'), check(1, 'ok')]));
    expect(latest.map((entry) => entry?.outcome ?? null)).toEqual([null, 'ok', null]);
  });

  test('what is still open is counted by outcome before a result is approved', () => {
    expect(stillOpen(view([check(0, 'ok'), check(2, 'partial', 'partly checked')]))).toBe(
      '1 not checked, 1 partly checked'
    );
    expect(stillOpen(view([check(0, 'ok'), check(1, 'ok'), check(2, 'ok')]))).toBe('');
  });
});
