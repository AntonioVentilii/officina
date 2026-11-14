import { describe, expect, test } from 'bun:test';
import { parseAgentOutput } from '@officina/core';
import { planProblems } from '../src/validators';

const plan = (checklist: string[]) => {
  const parsed = parseAgentOutput('chooser', {
    userVisible: true,
    approval: { depth: 'test', rationale: 'Copy people read on the settings page.' },
    checklist
  });
  if (!parsed.ok) throw new Error(parsed.errors.join());
  return parsed.output;
};

describe('the approval plan check', () => {
  const members = new Set<string>();

  test('at verification a plan with an empty checklist goes back to the chooser', () => {
    expect(planProblems('verifying', members)(plan([]))).toEqual([
      'checklist: at verification the checklist must have at least one step'
    ]);
    expect(planProblems('verifying', members)(plan(['Open settings and read the title.']))).toEqual(
      []
    );
  });

  test('at spec review a plan needs no checklist', () => {
    expect(planProblems('spec_review', members)(plan([]))).toEqual([]);
  });
});
