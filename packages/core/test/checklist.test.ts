import { describe, expect, test } from 'bun:test';
import { checkCounts, checklistHead, evidenceSchema, latestChecks } from '../src';

describe('checklist checks', () => {
  test("an item's latest check is where it stands; an item past the list is ignored", () => {
    const latest = latestChecks(
      [
        { item: 0, outcome: 'problem' as const },
        { item: 0, outcome: 'ok' as const },
        { item: 5, outcome: 'ok' as const }
      ],
      2
    );
    expect(latest).toEqual([{ item: 0, outcome: 'ok' }, null]);
    expect(checkCounts(latest)).toEqual({ ok: 1, problem: 0, partial: 0, unchecked: 1 });
  });

  test('evidence is kept on one line and loses anything shaped like a secret', () => {
    expect(evidenceSchema.parse('  curl\n answers 200  ')).toBe('curl answers 200');
    expect(evidenceSchema.parse('ran with API_TOKEN=abcdef123456')).not.toContain('abcdef123456');
    expect(evidenceSchema.safeParse('x'.repeat(301)).success).toBe(false);
  });

  test('the checklist belongs to the head the verification plan was made for', () => {
    const plan = { depth: 'test' as const, rationale: '', extra: [], verifiers: [] };
    expect(checklistHead({ approvalPlans: {} })).toBeNull();
    expect(checklistHead({ approvalPlans: { verifying: { ...plan, subject: 'sha:abc' } } })).toBe(
      'abc'
    );
  });
});
