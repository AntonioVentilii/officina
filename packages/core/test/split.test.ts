import { describe, expect, test } from 'bun:test';
import { commandForOutput, parseAgentOutput, splitMarkdown, splitPaths } from '../src';
import { newTask } from './fixtures';

const subtask = (title: string, paths: string[], after: number[] = []) => ({
  title,
  scope: `Covers ${title.toLowerCase()} only.`,
  paths,
  after
});

const proposal = {
  outcome: 'split',
  why: 'Two purposes, about 1900 lines against the standard limit of 800.',
  subtasks: [
    subtask('Store the sub-tasks', ['packages/db/src/a.ts', 'packages/db/test/a.test.ts']),
    subtask('Show them on the board', ['apps/board/src/b.svelte', 'packages/db/src/a.ts'], [1])
  ],
  userVisible: true
};

describe('a proposed split', () => {
  test('maps to post_spec marked as a split, with every file its sub-tasks touch once', () => {
    const parsed = parseAgentOutput('spec', proposal);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    expect(commandForOutput(newTask('t1', 'gio'), { role: 'spec', output: parsed.output })).toEqual(
      {
        ok: true,
        command: {
          type: 'post_spec',
          predictedPaths: [
            'apps/board/src/b.svelte',
            'packages/db/src/a.ts',
            'packages/db/test/a.test.ts'
          ],
          userVisible: true,
          split: true
        }
      }
    );
  });

  test('may only wait for sub-tasks listed before it, so it is in order and has no cycle', () => {
    const waitsForLater = {
      ...proposal,
      subtasks: [subtask('First', ['a.ts'], [2]), subtask('Second', ['b.ts'])]
    };
    const waitsForItself = {
      ...proposal,
      subtasks: [subtask('First', ['a.ts']), subtask('Second', ['b.ts'], [2])]
    };
    for (const output of [waitsForLater, waitsForItself]) {
      const parsed = parseAgentOutput('spec', output);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errors).toEqual([
        'subtasks: a sub-task may only wait for sub-tasks listed before it'
      ]);
    }
  });

  test('holds at least two sub-tasks, and each one names its files', () => {
    expect(parseAgentOutput('spec', { ...proposal, subtasks: [subtask('One', ['a.ts'])] }).ok).toBe(
      false
    );
    expect(
      parseAgentOutput('spec', {
        ...proposal,
        subtasks: [subtask('One', []), subtask('Two', ['b.ts'])]
      }).ok
    ).toBe(false);
  });

  test('reads as a numbered list with each sub-task scope, files and what it waits for', () => {
    const parsed = parseAgentOutput('spec', proposal);
    if (!parsed.ok || parsed.output.outcome !== 'split') throw new Error('not a split');
    expect(splitMarkdown(parsed.output)).toBe(
      [
        '**Proposed split into 2 sub-tasks.** Two purposes, about 1900 lines against the standard limit of 800.',
        '',
        '1. **Store the sub-tasks**: Covers store the sub-tasks only.',
        '    - Files: `packages/db/src/a.ts`, `packages/db/test/a.test.ts`',
        '2. **Show them on the board**: Covers show them on the board only.',
        '    - Files: `apps/board/src/b.svelte`, `packages/db/src/a.ts`',
        '    - After: 1'
      ].join('\n')
    );
    expect(splitPaths(parsed.output)).toHaveLength(3);
  });
});
