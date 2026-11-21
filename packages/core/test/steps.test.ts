import { describe, expect, test } from 'bun:test';
import { branchForTask, nextAgentRoles, type Task } from '../src';
import { newTask } from './fixtures';

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

  test('reviewing asks the spec reviewer first, and the correctness reviewer once it approved', () => {
    expect(nextAgentRoles(at({ stage: 'reviewing' }))).toEqual(['reviewer_spec']);
    expect(
      nextAgentRoles(at({ stage: 'reviewing', reviews: { reviewer_spec: 'approve' } }))
    ).toEqual(['reviewer_correctness']);
    expect(
      nextAgentRoles(at({ stage: 'reviewing', reviews: { reviewer_spec: 'changes' } }))
    ).toEqual([]);
  });

  test('spec review waits on the chooser once per version, and never for a proposed split', () => {
    expect(nextAgentRoles(at({ stage: 'spec_review', specVersion: 1 }))).toEqual(['chooser']);
    expect(
      nextAgentRoles(at({ stage: 'spec_review', specVersion: 1, splitProposed: true }))
    ).toEqual([]);
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
