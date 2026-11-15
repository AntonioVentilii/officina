import { describe, expect, test } from 'bun:test';
import { CHECKLIST_LIMITS, INPUT_LIMITS, parseAgentOutput } from '@officina/core';
import { checklistMarkdown } from '../src/github-sync';

/** GitHub refuses a comment longer than this. */
const GITHUB_COMMENT_LIMIT = 65_536;

describe('checklist comment', () => {
  test('the largest checklist the chooser may return still fits in one GitHub comment', () => {
    // Pipes are escaped in the table, so a cell of pipes is the longest it can render.
    const pipes = (count: number) => '|'.repeat(count);
    const largest = parseAgentOutput('chooser', {
      userVisible: true,
      approval: { depth: 'test', rationale: 'Copy.' },
      checklist: Array.from({ length: CHECKLIST_LIMITS.items }, () =>
        'x'.repeat(CHECKLIST_LIMITS.item)
      ),
      beforeAfter: Array.from({ length: CHECKLIST_LIMITS.rows }, () => ({
        key: pipes(CHECKLIST_LIMITS.row.key),
        locale: pipes(CHECKLIST_LIMITS.row.locale),
        before: pipes(CHECKLIST_LIMITS.row.before),
        after: pipes(CHECKLIST_LIMITS.row.after)
      }))
    });
    if (!largest.ok) throw new Error(largest.errors.join());
    const title = 'x'.repeat(INPUT_LIMITS.title.max);
    const body = checklistMarkdown(largest.output, `task 1 (${title})`)!;
    expect(body.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
  });
});
