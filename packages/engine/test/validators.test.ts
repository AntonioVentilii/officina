import { describe, expect, test } from 'bun:test';
import { parseAgentOutput } from '@officina/core';
import { planProblems, splitProblems } from '../src/validators';

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

describe('the split check', () => {
  const spec = (outcome: 'specced' | 'split') => {
    const parsed = parseAgentOutput(
      'spec',
      outcome === 'specced'
        ? { outcome, spec: '# Spec', predictedPaths: ['a.ts'], userVisible: false }
        : {
            outcome,
            why: 'Too large.',
            userVisible: false,
            subtasks: [
              { title: 'One', scope: 'First.', paths: ['a.ts'] },
              { title: 'Two', scope: 'Second.', paths: ['b.ts'], after: [1] }
            ]
          }
    );
    if (!parsed.ok) throw new Error(parsed.errors.join());
    return parsed.output;
  };

  test('after people picked Split, one spec goes back to the spec agent and a split passes', () => {
    expect(splitProblems(true)(spec('specced'))).toEqual([
      'a maintainer picked Split when the size check held the build: submit `split`, not one spec'
    ]);
    expect(splitProblems(true)(spec('split'))).toEqual([]);
    expect(splitProblems(false)(spec('specced'))).toEqual([]);
  });
});
