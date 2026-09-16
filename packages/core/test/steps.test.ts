import { describe, expect, test } from 'bun:test';
import { branchForTask, newTask, nextAgentRoles, type Task } from '../src';

const at = (changes: Partial<Task>): Task => ({ ...newTask('t1', 'antonio'), ...changes });

describe('next agent roles', () => {
  test('follow the stage', () => {
    expect(nextAgentRoles(at({ stage: 'speccing' }))).toEqual(['spec']);
    expect(nextAgentRoles(at({ stage: 'choosing' }))).toEqual(['chooser']);
    expect(nextAgentRoles(at({ stage: 'verifying' }))).toEqual([]);
  });

  test('building needs the builder only when an agent holds the task', () => {
    expect(
      nextAgentRoles(at({ stage: 'building', assignee: { kind: 'agent', role: 'builder' } }))
    ).toEqual(['builder']);
    expect(
      nextAgentRoles(at({ stage: 'building', assignee: { kind: 'member', memberId: 'antonio' } }))
    ).toEqual([]);
  });

  test('reviewing asks only the reviewers that have not approved yet', () => {
    expect(nextAgentRoles(at({ stage: 'reviewing' }))).toEqual([
      'reviewer_spec',
      'reviewer_correctness'
    ]);
    expect(
      nextAgentRoles(at({ stage: 'reviewing', reviews: { reviewer_spec: 'approve' } }))
    ).toEqual(['reviewer_correctness']);
  });

  test('blocked, paused and closed tasks wait on people', () => {
    const blocked = { question: 'which?', askedOf: { role: 'maintainer' as const } };
    expect(nextAgentRoles(at({ stage: 'speccing', blocked }))).toEqual([]);
    expect(nextAgentRoles(at({ stage: 'speccing', paused: true }))).toEqual([]);
    expect(nextAgentRoles(at({ stage: 'done' }))).toEqual([]);
  });

  test('task branches live under officina/', () => {
    expect(branchForTask(12)).toBe('officina/task-12');
  });
});
