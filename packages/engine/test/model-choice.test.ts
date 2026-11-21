import { describe, expect, test } from 'bun:test';
import type { ModelTier } from '@officina/core';
import { RUNNER_ROLES, type AgentEffort } from '@officina/runner';
import { areaOf, chooseModel, type StepSignals } from '../src/model-choice';

/** A first build of a two-file change in one package, in the standard lane, nothing gone wrong. */
const step = (overrides: Partial<StepSignals>): StepSignals => ({
  role: 'builder',
  lane: 'standard',
  guards: [],
  paths: ['packages/board/src/Card.svelte', 'packages/board/test/card.test.ts'],
  diffLines: null,
  strongPaths: [],
  fixRounds: 0,
  failedAttempts: 0,
  forcedTier: null,
  ...overrides
});

const FIVE_PACKAGES = ['core', 'db', 'engine', 'api', 'board'].map(
  (name) => `packages/${name}/src/index.ts`
);
const SMALL_PUSH = { paths: ['src/a.ts', 'src/b.ts'], diffLines: 40 };

describe('chooseModel', () => {
  // [case, signals, tier, effort, reason]
  const table: [string, Partial<StepSignals>, ModelTier, AgentEffort, string][] = [
    ['an interviewer', { role: 'interviewer', paths: [] }, 'haiku', 'low', 'role default'],
    ['a chooser', { role: 'chooser' }, 'haiku', 'low', 'role default'],
    ['a learner', { role: 'learner' }, 'haiku', 'low', 'role default'],
    ['a first spec', { role: 'spec', paths: [] }, 'sonnet', 'medium', 'role default'],
    ['a first build', {}, 'sonnet', 'medium', 'role default'],
    ['a fix round', { fixRounds: 1, diffLines: 120 }, 'sonnet', 'medium', 'role default'],
    [
      'a correctness review',
      { role: 'reviewer_correctness', diffLines: 80 },
      'sonnet',
      'medium',
      'role default'
    ],
    [
      'the spec review of a small change',
      { role: 'reviewer_spec', ...SMALL_PUSH },
      'haiku',
      'low',
      'small change'
    ],
    [
      'the spec review of a docs-only change',
      { role: 'reviewer_spec', paths: ['docs/a.md'], diffLines: 900 },
      'haiku',
      'low',
      'small change'
    ],
    [
      'the spec review of a medium change',
      { role: 'reviewer_spec', diffLines: 300 },
      'sonnet',
      'medium',
      'role default'
    ],
    ['a build in the red lane', { lane: 'red' }, 'opus', 'high', 'red lane'],
    [
      'a spec of a guarded request',
      { role: 'spec', paths: [], guards: ['secrets'] },
      'opus',
      'high',
      'guarded (secrets)'
    ],
    [
      'a correctness review of a strong path',
      {
        role: 'reviewer_correctness',
        paths: ['src/lifecycle.ts'],
        diffLines: 20,
        strongPaths: ['src/lifecycle.ts']
      },
      'opus',
      'high',
      'strong path'
    ],
    ['a build of a large change', { diffLines: 501 }, 'opus', 'high', 'large change'],
    [
      'a build over many files',
      { paths: Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`) },
      'opus',
      'high',
      'large change'
    ],
    ['a build across packages', { paths: FIVE_PACKAGES }, 'opus', 'high', 'cross-package change'],
    [
      'the spec review of a small change in the red lane',
      { role: 'reviewer_spec', lane: 'red', ...SMALL_PUSH },
      'opus',
      'high',
      'red lane'
    ],
    [
      'a chooser on a guarded task',
      { role: 'chooser', guards: ['access'] },
      'haiku',
      'low',
      'role default'
    ],
    [
      'a build after a failed attempt',
      { failedAttempts: 1 },
      'opus',
      'medium',
      'role default, after a failed attempt'
    ],
    [
      'a build after three failed attempts',
      { failedAttempts: 3 },
      'opus',
      'medium',
      'role default, after a failed attempt'
    ],
    [
      'a build sent back twice',
      { fixRounds: 2 },
      'opus',
      'medium',
      'role default, after 2 rounds sent back'
    ],
    [
      'an interviewer after a failed attempt',
      { role: 'interviewer', failedAttempts: 1 },
      'sonnet',
      'medium',
      'role default, after a failed attempt'
    ],
    [
      'a small spec review after a failed attempt',
      { role: 'reviewer_spec', ...SMALL_PUSH, failedAttempts: 1 },
      'sonnet',
      'medium',
      'small change, after a failed attempt'
    ],
    [
      'a red-lane spec after a failed attempt',
      { role: 'spec', lane: 'red', failedAttempts: 1 },
      'opus',
      'high',
      'red lane, after a failed attempt'
    ],
    [
      'a first build forced onto opus',
      { forcedTier: 'opus' },
      'opus',
      'medium',
      'forced by a maintainer'
    ],
    [
      'a red-lane build forced onto haiku',
      { lane: 'red', forcedTier: 'haiku' },
      'haiku',
      'high',
      'forced by a maintainer'
    ],
    [
      'a build after a failed attempt forced onto sonnet',
      { failedAttempts: 1, forcedTier: 'sonnet' },
      'sonnet',
      'medium',
      'forced by a maintainer'
    ],
    [
      'an interviewer forced onto opus',
      { role: 'interviewer', paths: [], forcedTier: 'opus' },
      'opus',
      'low',
      'forced by a maintainer'
    ],
    [
      'a correctness review forced onto haiku',
      { role: 'reviewer_correctness', forcedTier: 'haiku' },
      'sonnet',
      'medium',
      'forced by a maintainer'
    ]
  ];

  for (const [name, signals, tier, effort, reason] of table) {
    test(`${name} runs on ${tier} at ${effort}`, () => {
      expect(chooseModel(step(signals))).toEqual({ tier, effort, reason });
    });
  }

  test('a correctness review never runs on haiku, whatever the change or its history', () => {
    const variants: Partial<StepSignals>[] = [
      SMALL_PUSH,
      { paths: ['README.md'], diffLines: 2 },
      { paths: [], diffLines: null },
      { failedAttempts: 2 },
      { fixRounds: 5 }
    ];
    for (const variant of variants) {
      expect(chooseModel(step({ role: 'reviewer_correctness', ...variant })).tier).not.toBe(
        'haiku'
      );
    }
  });

  test('every role has a model, and only the spec review of a small change drops to haiku', () => {
    for (const role of RUNNER_ROLES) {
      const choice = chooseModel(step({ role, ...SMALL_PUSH }));
      const cheap = ['interviewer', 'chooser', 'learner', 'reviewer_spec'].includes(role);
      expect(choice.tier === 'haiku').toBe(cheap);
    }
  });
});

describe('areaOf', () => {
  test('is the first two folders of a path, its only folder, or the root', () => {
    expect(areaOf('packages/core/src/lifecycle.ts')).toBe('packages/core');
    expect(areaOf('packages/core/package.json')).toBe('packages/core');
    expect(areaOf('src/main.ts')).toBe('src');
    expect(areaOf('package.json')).toBe('.');
  });

  test('a change across two packages and its docs is not cross-package', () => {
    const paths = [
      'packages/core/src/a.ts',
      'packages/engine/src/b.ts',
      'docs/ai/patterns.md',
      'docs/architecture.md'
    ];
    expect(chooseModel(step({ paths })).tier).toBe('sonnet');
  });
});
