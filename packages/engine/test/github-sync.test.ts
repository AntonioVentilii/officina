import { describe, expect, test } from 'bun:test';
import { parseAgentOutput } from '@officina/core';
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
      checklist: Array.from({ length: 30 }, () => 'x'.repeat(300)),
      beforeAfter: Array.from({ length: 30 }, () => ({
        key: pipes(120),
        locale: pipes(35),
        before: pipes(350),
        after: pipes(350)
      }))
    });
    if (!largest.ok) throw new Error(largest.errors.join());
    const body = checklistMarkdown(largest.output, `task 1 (${'x'.repeat(200)})`)!;
    expect(body.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
  });
});
