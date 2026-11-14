import { describe, expect, test } from 'bun:test';
import { commandForOutput, newTask, parseAgentOutput, type ContractRole } from '../src';

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

  test('every field of a result has a ceiling, and a result at the ceiling still parses', () => {
    const chars = (count: number) => 'x'.repeat(count);
    const many = <T>(count: number, item: T) => Array.from({ length: count }, () => item);
    /** A result accepted at each field's ceiling, refused one past it. */
    const edges: [ContractRole, (over: number) => unknown][] = [
      [
        'spec',
        (over) => ({
          outcome: 'specced',
          spec: chars(40_000 + over),
          predictedPaths: many(200, chars(300)),
          userVisible: false
        })
      ],
      [
        'spec',
        (over) => ({
          outcome: 'specced',
          spec: '# Spec',
          predictedPaths: many(200 + over, 'src/a.ts'),
          userVisible: false
        })
      ],
      ['spec', (over) => ({ outcome: 'blocked', question: chars(1500 + over) })],
      [
        'builder',
        (over) => ({
          outcome: 'pushed',
          branch: 'officina/task-1',
          prTitle: 'fix: a',
          verified: many(30 + over, chars(500)),
          notVerified: many(30, chars(500))
        })
      ],
      [
        'builder',
        (over) => ({
          outcome: 'pushed',
          branch: 'officina/task-1',
          prTitle: 'fix: a',
          verified: [],
          notVerified: [chars(500 + over)]
        })
      ],
      ['builder', (over) => ({ outcome: 'unchanged', why: chars(4000 + over) })],
      ['builder', (over) => ({ outcome: 'failed', why: chars(2000 + over) })],
      ['reviewer_spec', (over) => ({ outcome: 'approve', summary: chars(4000 + over) })],
      [
        'reviewer_correctness',
        (over) => ({
          outcome: 'changes',
          items: many(30 + over, { file: chars(300), issue: chars(2000) })
        })
      ],
      [
        'reviewer_correctness',
        (over) => ({ outcome: 'changes', items: [{ file: 'a.ts', issue: chars(2000 + over) }] })
      ],
      [
        'chooser',
        (over) => ({
          userVisible: true,
          approval: {
            depth: 'test',
            rationale: 'Copy.',
            extraApprovals: [{ domain: 'legal', reason: chars(300 + over) }]
          },
          checklist: many(30, chars(300)),
          beforeAfter: many(30, {
            key: chars(120),
            locale: chars(35),
            before: chars(350),
            after: chars(350)
          })
        })
      ],
      [
        'chooser',
        (over) => ({
          userVisible: true,
          approval: { depth: 'test', rationale: 'Copy.' },
          checklist: many(30 + over, 'Open settings.')
        })
      ],
      [
        'chooser',
        (over) => ({
          userVisible: true,
          approval: { depth: 'test', rationale: 'Copy.' },
          checklist: ['Open settings.'],
          beforeAfter: [{ key: 'a', locale: 'en', before: '', after: chars(350 + over) }]
        })
      ]
    ];
    for (const [role, result] of edges) {
      expect(parseAgentOutput(role, result(0)).ok).toBe(true);
      expect(parseAgentOutput(role, result(1)).ok).toBe(false);
    }
  });

  test('a builder push needs facts established by the engine, never the agent', () => {
    const pushed = parseAgentOutput('builder', {
      outcome: 'pushed',
      branch: 'officina/t1-copy',
      prTitle: 'fix(copy): update the settings title',
      verified: ['npm run check'],
      notVerified: []
    });
    if (!pushed.ok) throw new Error(pushed.errors.join());
    expect(commandForOutput(task, { role: 'builder', output: pushed.output })).toEqual({
      ok: false,
      error: 'missing_push_facts'
    });
    const facts = {
      headSha: 'abc',
      changedPaths: ['src/a.ts'],
      addedPaths: [],
      catalogPages: {},
      diffLines: 3
    };
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

  test('chooser defaults optional lists and maps to a plan for the gate the task is at', () => {
    const chosen = parseAgentOutput('chooser', {
      userVisible: false,
      approval: { depth: 'glance', rationale: 'Copy only.' }
    });
    if (!chosen.ok) throw new Error(chosen.errors.join());
    expect(chosen.output).toEqual({
      userVisible: false,
      approval: {
        depth: 'glance',
        rationale: 'Copy only.',
        extraApprovals: [],
        verifiers: [],
        merge: 'person',
        build: 'agent'
      },
      checklist: [],
      beforeAfter: []
    });
    const withLegal = parseAgentOutput('chooser', {
      userVisible: true,
      approval: {
        depth: 'test',
        rationale: 'Changes terms.',
        extraApprovals: [{ domain: 'legal', reason: 'Terms text.' }]
      }
    });
    if (!withLegal.ok) throw new Error(withLegal.errors.join());
    expect(
      commandForOutput(
        { ...task, stage: 'spec_review' },
        { role: 'chooser', output: withLegal.output }
      )
    ).toEqual({
      ok: true,
      command: {
        type: 'plan_approval',
        userVisible: true,
        plan: {
          depth: 'test',
          rationale: 'Changes terms.',
          extra: [{ requirement: { domain: 'legal' }, reason: 'Terms text.' }],
          verifiers: [],
          merge: 'person'
        }
      }
    });
  });

  test('the chooser cannot invent requirements outside additions', () => {
    for (const extra of [
      { requester: true, reason: 'x' },
      { role: 'watcher', reason: 'x' }
    ]) {
      expect(
        parseAgentOutput('chooser', {
          userVisible: false,
          approval: { depth: 'glance', rationale: 'x', extraApprovals: [extra] }
        }).ok
      ).toBe(false);
    }
  });

  test('a handoff to a person goes to the role its needs call for, decided by the engine', () => {
    const needs = parseAgentOutput('interviewer', {
      outcome: 'needs_person',
      needs: ['dns', 'publishing'],
      why: 'There is no deck.example.app domain, and showing room content anywhere new is an owner decision.',
      asks: ['Create deck.example.app', 'Decide who may see the deck']
    });
    if (!needs.ok) throw new Error(needs.errors.join());
    expect(commandForOutput(task, { role: 'interviewer', output: needs.output })).toEqual({
      ok: true,
      command: {
        type: 'block',
        question:
          'There is no deck.example.app domain, and showing room content anywhere new is an owner decision.\n\nNeeded:\n- Create deck.example.app\n- Decide who may see the deck',
        askedOf: { role: 'owner' },
        handoff: { needs: ['dns', 'publishing'] }
      }
    });

    const tooling = parseAgentOutput('builder', {
      outcome: 'needs_person',
      needs: ['infrastructure'],
      why: 'The spec needs a queue the project does not run.',
      asks: ['Set up the queue']
    });
    if (!tooling.ok) throw new Error(tooling.errors.join());
    expect(commandForOutput(task, { role: 'builder', output: tooling.output })).toMatchObject({
      command: { askedOf: { role: 'maintainer' } }
    });

    // The agent names needs from the list; it cannot send them to the requester or invent one.
    expect(
      parseAgentOutput('spec', {
        outcome: 'needs_person',
        needs: ['magic'],
        why: 'x',
        asks: ['y'],
        askedOf: 'requester'
      }).ok
    ).toBe(false);
  });

  test('the chooser can ask for a human developer at spec review only', () => {
    const chosen = parseAgentOutput('chooser', {
      userVisible: true,
      approval: {
        depth: 'test',
        rationale: 'A large port.',
        build: 'person',
        buildReason: 'Porting the whole static design needs judgement on the spot.'
      }
    });
    if (!chosen.ok) throw new Error(chosen.errors.join());
    const atSpec = { ...task, stage: 'spec_review' as const };
    expect(commandForOutput(atSpec, { role: 'chooser', output: chosen.output })).toMatchObject({
      command: {
        type: 'plan_approval',
        plan: {
          build: 'person',
          buildReason: 'Porting the whole static design needs judgement on the spot.'
        }
      }
    });
    // A plan that asks for a developer must say why.
    const unexplained = parseAgentOutput('chooser', {
      userVisible: true,
      approval: { depth: 'test', rationale: 'A large port.', build: 'person' }
    });
    expect(unexplained.ok).toBe(false);
    if (!unexplained.ok)
      expect(unexplained.errors).toContain(
        'approval.buildReason: buildReason is required when build is person'
      );

    const atResult = { ...task, stage: 'choosing' as const, headSha: 'abc' };
    const result = commandForOutput(atResult, { role: 'chooser', output: chosen.output });
    expect(result.ok && result.command.type === 'choose' && result.command.plan).not.toHaveProperty(
      'build'
    );
  });
});
