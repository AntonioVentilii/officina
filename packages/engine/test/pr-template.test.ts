import { describe, expect, test } from 'bun:test';
import { INPUT_LIMITS, parseAgentOutput } from '@officina/core';
import { bodyProblems, headingsOf } from '../src/pr-template';

const TEMPLATE = { path: '.github/pull_request_template.md', headings: ['Motivation', 'Tests'] };

const pushed = (prBody?: string) => {
  const parsed = parseAgentOutput('builder', {
    outcome: 'pushed',
    branch: 'officina/task-1',
    prTitle: 'fix(settings): rename the settings title',
    ...(prBody === undefined ? {} : { prBody }),
    verified: [],
    notVerified: []
  });
  if (!parsed.ok) throw new Error(parsed.errors.join());
  return parsed.output;
};

describe("a pull request template's headings", () => {
  test('counts ATX and setext headings, not those in comments or fenced code', () => {
    const template = [
      '<!-- # Not a heading -->',
      '# Motivation',
      'Changes',
      '=======',
      '```md',
      '# Not a heading either',
      '```',
      'Tests',
      '-----',
      '',
      '---',
      '- a list item',
      '---'
    ].join('\n');
    expect(headingsOf(template)).toEqual(['Motivation', 'Changes', 'Tests']);
  });
});

describe('the pull request body check', () => {
  test('a body that keeps every heading of the template passes, at any level and case', () => {
    expect(
      bodyProblems(TEMPLATE)(pushed('## motivation\n\nWhy.\n\nTests\n---\n\n- bun test'))
    ).toEqual([]);
  });

  test('a body that leaves out a heading, or no body, goes back', () => {
    expect(bodyProblems(TEMPLATE)(pushed('# Motivation\n\nWhy.'))).toEqual([
      `prBody misses the heading "Tests" of ${TEMPLATE.path}`
    ]);
    expect(bodyProblems(TEMPLATE)(pushed())).toEqual([
      `prBody is required: write it in the pull request template at ${TEMPLATE.path}`
    ]);
  });

  test('without a template there is no body to give, so Officina keeps its own', () => {
    expect(bodyProblems(null)(pushed())).toEqual([]);
    expect(bodyProblems(null)(pushed('# Anything'))).toEqual([
      'prBody is only for a project whose pull request template can be read: leave it out'
    ]);
  });

  test("the longest body leaves room under GitHub's limit for what Officina adds", () => {
    const followUps = 15 * (500 + '- \n'.length);
    expect(INPUT_LIMITS.prBody + followUps + 1_000).toBeLessThan(65_536);
  });
});
