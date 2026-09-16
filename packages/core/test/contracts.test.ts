import { describe, expect, test } from 'bun:test';
import { commandForOutput, newTask, parseAgentOutput } from '../src';

const task = newTask('t1', 'gio');

describe('agent output contracts', () => {
  test('spec output maps to post_spec, or to a question for the requester', () => {
    const specced = parseAgentOutput('spec', {
      outcome: 'specced',
      spec: '# Spec',
      predictedPaths: ['src/a.ts'],
      userVisible: true
    });
    expect(specced.ok).toBe(true);
    if (!specced.ok) return;
    expect(commandForOutput(task, { role: 'spec', output: specced.output })).toEqual({
      ok: true,
      command: { type: 'post_spec', predictedPaths: ['src/a.ts'], userVisible: true }
    });

    const blocked = parseAgentOutput('spec', {
      outcome: 'blocked',
      question: 'Which screen?',
      askedOf: 'requester'
    });
    if (!blocked.ok) throw new Error(blocked.errors.join());
    expect(commandForOutput(task, { role: 'spec', output: blocked.output })).toMatchObject({
      command: { type: 'block', askedOf: { memberId: 'gio' } }
    });
  });

  test('extra keys, empty strings and missing fields are rejected', () => {
    expect(
      parseAgentOutput('reviewer_spec', { outcome: 'approve', summary: 'ok', score: 9 }).ok
    ).toBe(false);
    expect(parseAgentOutput('reviewer_spec', { outcome: 'approve', summary: '  ' }).ok).toBe(false);
    expect(parseAgentOutput('reviewer_correctness', { outcome: 'changes', items: [] }).ok).toBe(
      false
    );
    expect(
      parseAgentOutput('learner', {
        learnings: Array(4).fill({ text: 'a', proposedChange: 'b', evidence: 'c' })
      }).ok
    ).toBe(false);
  });

  test('a builder push needs facts established by the engine, never the agent', () => {
    const pushed = parseAgentOutput('builder', {
      outcome: 'pushed',
      branch: 'officina/t1-copy',
      verified: ['npm run check'],
      notVerified: []
    });
    if (!pushed.ok) throw new Error(pushed.errors.join());
    expect(commandForOutput(task, { role: 'builder', output: pushed.output })).toEqual({
      ok: false,
      error: 'missing_push_facts'
    });
    const facts = { headSha: 'abc', changedPaths: ['src/a.ts'], diffLines: 3 };
    expect(commandForOutput(task, { role: 'builder', output: pushed.output, facts })).toEqual({
      ok: true,
      command: { type: 'push', ...facts }
    });
    expect(parseAgentOutput('builder', { ...pushed.output, branch: 'main' }).ok).toBe(false);
  });

  test('a failed build becomes a question for a maintainer', () => {
    const failed = parseAgentOutput('builder', { outcome: 'failed', why: 'svelte-check errors' });
    if (!failed.ok) throw new Error(failed.errors.join());
    expect(commandForOutput(task, { role: 'builder', output: failed.output })).toMatchObject({
      command: { type: 'block', askedOf: { role: 'maintainer' } }
    });
  });

  test('reviewer changes become numbered notes with file and line', () => {
    const changes = parseAgentOutput('reviewer_correctness', {
      outcome: 'changes',
      items: [
        { file: 'src/a.ts', line: 4, issue: 'off by one' },
        { file: 'src/b.ts', issue: 'missing test' }
      ]
    });
    if (!changes.ok) throw new Error(changes.errors.join());
    expect(
      commandForOutput(task, { role: 'reviewer_correctness', output: changes.output })
    ).toEqual({
      ok: true,
      command: {
        type: 'review',
        verdict: 'changes',
        notes: '1. src/a.ts:4 off by one\n2. src/b.ts missing test'
      }
    });
  });

  test('chooser defaults optional lists', () => {
    const chosen = parseAgentOutput('chooser', {
      userVisible: false,
      checklist: ['Read the diff']
    });
    expect(chosen.ok && chosen.output).toEqual({
      userVisible: false,
      checklist: ['Read the diff'],
      suggestedDomains: [],
      beforeAfter: []
    });
  });
});
