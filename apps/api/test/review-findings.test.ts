import { describe, expect, test } from 'bun:test';
import { reviewLines, reviewRounds, SENT_BACK } from '../src/review-findings';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 19, 9, minute));

const pushed = (minute: number) => ({ type: 'pushed', createdAt: at(minute) });

const changes = (minute: number) => ({
  role: 'reviewer_correctness',
  status: 'succeeded',
  createdAt: at(minute),
  result: {
    outcome: 'changes',
    items: [
      { file: 'src/lib/copy.ts', line: 12, rule: 'rule 5', issue: 'The button still says Wager.' },
      { file: 'src/routes/+page.svelte', issue: 'The label is written twice.' }
    ]
  }
});

const approved = (minute: number) => ({
  role: 'reviewer_spec',
  status: 'succeeded',
  createdAt: at(minute),
  result: { outcome: 'approve', summary: 'Matches the plan.' }
});

const quote = (text: string) => `> ${text}`;

describe('reviewer findings', () => {
  test('the latest build reviewed is shown in full, the most recent review first', () => {
    const findings = reviewRounds([approved(2), changes(3)], [pushed(1)], 'building');
    expect(findings.sentBack).toBe(true);
    expect(reviewLines(findings, quote)).toEqual([
      'Reviews of build 1, the most recent first:',
      '- Code reviewer asked for changes (2 findings):',
      '> 1. src/lib/copy.ts:12 [rule 5] The button still says Wager.\n2. src/routes/+page.svelte The label is written twice.',
      '- Spec reviewer approved:',
      '> Matches the plan.'
    ]);
    expect(SENT_BACK).toContain('Reviews');
  });

  test('a build is sent back only while the task builds and nothing was built since', () => {
    const runs = [approved(2), changes(3)];
    expect(reviewRounds(runs, [pushed(1)], 'reviewing').sentBack).toBe(false);
    expect(reviewRounds(runs, [pushed(1), pushed(5)], 'building').sentBack).toBe(false);
    expect(reviewRounds([approved(2)], [pushed(1)], 'building').sentBack).toBe(false);
    // A changes result the task had already moved past did not send this build back.
    const discarded = {
      ...changes(3),
      status: 'failed',
      result: { discarded: 'stale', output: changes(3).result }
    };
    expect(reviewRounds([approved(2), discarded], [pushed(1)], 'building').sentBack).toBe(false);
    expect(reviewRounds([], [pushed(1)], 'building')).toEqual({
      latest: null,
      earlier: [],
      sentBack: false
    });
  });

  test('a result the task had moved past, a failure and a review in progress still say what happened', () => {
    const findings = reviewRounds(
      [
        {
          ...changes(2),
          status: 'failed',
          result: { discarded: 'stale', output: changes(2).result }
        },
        {
          role: 'reviewer_spec',
          status: 'failed',
          createdAt: at(3),
          result: { error: 'timed out' }
        },
        { role: 'reviewer_spec', status: 'running', createdAt: at(4), result: null },
        { role: 'builder', status: 'succeeded', createdAt: at(5), result: {} }
      ],
      [pushed(1)],
      'reviewing'
    );
    expect(reviewLines(findings, quote)).toEqual([
      'Reviews of build 1, the most recent first:',
      '- Spec reviewer is still reviewing:',
      '- Spec reviewer failed:',
      '> timed out',
      '- Code reviewer asked for changes (2 findings), not applied: the task had moved on (stale):',
      '> 1. src/lib/copy.ts:12 [rule 5] The button still says Wager.\n2. src/routes/+page.svelte The label is written twice.'
    ]);
  });

  test('a failed run says why, in each shape the engine records it', () => {
    const failed = (minute: number, result: unknown) => ({
      role: 'reviewer_correctness',
      status: 'failed',
      createdAt: at(minute),
      result
    });
    const findings = reviewRounds(
      [
        failed(2, { kind: 'no_result' }),
        failed(3, { kind: 'invalid_result', errors: ['items: too short'] }),
        failed(4, { outcome: { kind: 'budget_reached' } }),
        failed(5, { error: 'the engine restarted while this run was in progress' })
      ],
      [pushed(1)],
      'reviewing'
    );
    expect(reviewLines(findings, quote).filter((line) => line.startsWith('>'))).toEqual([
      '> the engine restarted while this run was in progress',
      '> it reached the spending limit for this step',
      '> its result did not match the contract: items: too short',
      '> it finished without submitting a result'
    ]);
  });

  test('earlier builds are one line each, and past five only counted', () => {
    const builds = [1, 3, 5, 7, 9, 11, 13];
    const runs = builds.map((minute) => changes(minute + 1));
    const lines = reviewLines(reviewRounds(runs, builds.map(pushed), 'building'), quote);
    expect(lines[0]).toBe('Reviews of build 7, the most recent first:');
    expect(lines.slice(3)).toEqual([
      'Earlier builds:',
      '- Build 6: Code reviewer asked for changes (2 findings).',
      '- Build 5: Code reviewer asked for changes (2 findings).',
      '- Build 4: Code reviewer asked for changes (2 findings).',
      '- Build 3: Code reviewer asked for changes (2 findings).',
      '- Build 2: Code reviewer asked for changes (2 findings).',
      '(1 earlier build not shown.)'
    ]);
  });

  test('a long result is cut, saying how much was left out', () => {
    const issue = 'x'.repeat(2_000);
    const long = {
      ...changes(2),
      result: { outcome: 'changes', items: Array(5).fill({ file: 'a.ts', issue }) }
    };
    const [, , findings] = reviewLines(reviewRounds([long], [pushed(1)], 'building'), quote);
    expect(findings!.length).toBeLessThan(6_100);
    expect(findings).toEndWith('more characters)');
  });
});
