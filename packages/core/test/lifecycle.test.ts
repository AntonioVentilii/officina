import { describe, expect, test } from 'bun:test';
import {
  canAutoVerify,
  canSubmitRequest,
  effectivePolicy,
  evaluatePolicy,
  humanBuildReason,
  nextAgentRoles,
  ownerHold,
  type Command,
  type Member,
  type PlanInput,
  type Task
} from '../src';
import {
  CONFIG_YAML,
  PLAN,
  asAgent,
  asMember,
  createDriver,
  engine,
  loadConfig,
  newTask,
  owner,
  productContributor,
  watcher
} from './fixtures';

const COPY_PATHS = ['src/lib/constants/messages/en.ts', 'src/lib/constants/messages/it.ts'];
const PAGE_PATHS = ['src/routes/+page.svelte'];

type Driver = ReturnType<typeof createDriver>;

/** Takes a fresh task from request to `ready` with the given predicted paths. */
const toReady = (driver: Driver, paths: readonly string[], userVisible = false): Task => {
  let task = newTask('t1', owner.id);
  task = driver.step(task, { type: 'submit_request' }, asMember(owner));
  task = driver.step(task, { type: 'accept' }, asMember(owner));
  task = driver.step(
    task,
    { type: 'post_spec', predictedPaths: paths, userVisible },
    asAgent('spec')
  );
  task = driver.step(task, { type: 'plan_approval', userVisible, plan: PLAN }, asAgent('chooser'));
  return driver.step(task, { type: 'approve' }, asMember(owner));
};

const buildAndReview = (driver: Driver, task: Task, headSha: string, paths: readonly string[]) => {
  let next = driver.step(
    task,
    { type: 'push', headSha, changedPaths: paths, addedPaths: [], catalogPages: {}, diffLines: 40 },
    asAgent('builder')
  );
  next = driver.step(
    next,
    { type: 'review', verdict: 'approve', notes: '' },
    asAgent('reviewer_spec')
  );
  return driver.step(
    next,
    { type: 'review', verdict: 'approve', notes: '' },
    asAgent('reviewer_correctness')
  );
};

const dispatchAgent = (driver: Driver, task: Task, openInLane = 0): Task =>
  driver.step(
    task,
    {
      type: 'dispatch',
      assignee: { kind: 'agent', role: 'builder' },
      openInLane
    },
    engine
  );

describe('solo owner', () => {
  test('takes a copy change from request to done alone', () => {
    const driver = createDriver([owner]);
    let task = toReady(driver, COPY_PATHS, true);
    expect(task.stage).toBe('ready');
    expect(task.lane).toBe('green');

    task = dispatchAgent(driver, task);
    task = buildAndReview(driver, task, 'abc', COPY_PATHS);
    expect(task.stage).toBe('choosing');

    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('merging');

    task = driver.step(task, { type: 'merged' }, engine);
    expect(task.stage).toBe('done');
  });

  test('records which requirements were waived because nobody can meet them', () => {
    const driver = createDriver([owner]);
    toReady(driver, COPY_PATHS);
    const recorded = driver.events().find((event) => event.type === 'approval_recorded');
    expect(recorded).toMatchObject({ satisfied: true, waived: [{ domain: 'product' }] });
  });
});

describe('collaboration', () => {
  test('a user-visible change also needs the product approver once one exists', () => {
    const driver = createDriver([owner, productContributor]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = buildAndReview(driver, task, 'abc', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));

    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('verifying');
    task = driver.step(task, { type: 'approve' }, asMember(productContributor));
    expect(task.stage).toBe('merging');
  });

  test('approvals on an older commit do not carry over after a fix round', () => {
    const driver = createDriver([owner, productContributor]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    task = buildAndReview(driver, task, 'abc', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'request_changes', note: 'button too small' },
      asMember(productContributor)
    );
    expect(task.stage).toBe('building');

    task = buildAndReview(driver, task, 'def', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, { type: 'approve' }, asMember(productContributor));
    expect(task.stage).toBe('verifying');
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('merging');
  });

  test('an agent cannot mark a change as not user-visible, a maintainer can', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    task = buildAndReview(driver, task, 'abc', PAGE_PATHS);
    const byAgent = driver.attempt(
      task,
      { type: 'choose', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(byAgent.ok && byAgent.task.userVisible).toBe(true);
    const byOwner = driver.attempt(
      task,
      { type: 'choose', userVisible: false, plan: PLAN },
      asMember(owner)
    );
    expect(byOwner.ok && byOwner.task.userVisible).toBe(false);
  });

  test('a member can take a task over from the agent and hand it back', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = driver.step(task, { type: 'claim' }, asMember(owner));
    expect(task.assignee).toEqual({ kind: 'member', memberId: 'antonio' });
    expect(
      driver.attempt(
        task,
        {
          type: 'push',
          headSha: 'x',
          changedPaths: PAGE_PATHS,
          addedPaths: [],
          catalogPages: {},
          diffLines: 1
        },
        asAgent('builder')
      ).ok
    ).toBe(false);
    task = driver.step(task, { type: 'release' }, asMember(owner));
    expect(task).toMatchObject({ stage: 'ready', assignee: null });
  });
});

describe('guardrails', () => {
  test('an agent that touches red paths is stopped and the owner is asked', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: ['src/satellite/index.ts'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 10
      },
      asAgent('builder')
    );
    expect(task).toMatchObject({ stage: 'ready', lane: 'red', assignee: null });
    expect(task.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(driver.events().some((event) => event.type === 'guardrail_tripped')).toBe(true);

    expect(driver.attempt(task, { type: 'claim' }, asMember(owner))).toEqual({
      ok: false,
      error: 'blocked'
    });
    task = driver.step(task, { type: 'answer', text: 'I will do it' }, asMember(owner));
    const redispatch = driver.attempt(
      task,
      {
        type: 'dispatch',
        assignee: { kind: 'agent', role: 'builder' },
        openInLane: 0
      },
      engine
    );
    expect(redispatch).toEqual({ ok: false, error: 'agents_cannot_build_lane' });
    task = driver.step(task, { type: 'claim' }, asMember(owner));
    expect(task.stage).toBe('building');
  });

  test('a lane never goes down when the spec is revised', () => {
    const driver = createDriver([owner]);
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    task = driver.step(task, { type: 'request_changes', note: 'only copy' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: COPY_PATHS, userVisible: false },
      asAgent('spec')
    );
    expect(task).toMatchObject({ lane: 'standard', specVersion: 2 });
  });

  test('a proposed split waits at spec review: nobody plans or approves it, and one spec clears it', () => {
    const driver = createDriver([owner]);
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false, split: true },
      asAgent('spec')
    );
    expect(task).toMatchObject({ stage: 'spec_review', specVersion: 1, splitProposed: true });
    expect(nextAgentRoles(task)).toEqual([]);
    for (const actor of [asAgent('chooser'), engine]) {
      expect(
        driver.attempt(task, { type: 'plan_approval', userVisible: false, plan: PLAN }, actor)
      ).toEqual({ ok: false, error: 'split_proposed' });
    }
    expect(driver.attempt(task, { type: 'approve' }, asMember(owner))).toEqual({
      ok: false,
      error: 'not_planned'
    });

    task = driver.step(task, { type: 'request_changes', note: 'keep it whole' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    expect(task).toMatchObject({ stage: 'spec_review', specVersion: 2, splitProposed: false });
    expect(nextAgentRoles(task)).toEqual(['chooser']);
  });

  test('an oversized change is blocked for a maintainer', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 5000
      },
      asAgent('builder')
    );
    expect(task.stage).toBe('building');
    expect(task.blocked?.askedOf).toEqual({ role: 'maintainer' });
  });

  test('agent dispatch respects the lane WIP limit, a member claim does not', () => {
    const driver = createDriver([owner]);
    const task = toReady(driver, PAGE_PATHS);
    expect(
      driver.attempt(
        task,
        {
          type: 'dispatch',
          assignee: { kind: 'agent', role: 'builder' },
          openInLane: 3
        },
        engine
      )
    ).toEqual({ ok: false, error: 'wip_limit' });
    expect(driver.attempt(task, { type: 'claim' }, asMember(owner)).ok).toBe(true);
  });

  test('fix rounds are bounded, then a maintainer decides', () => {
    const driver = createDriver([owner]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    for (const sha of ['a', 'b']) {
      task = driver.step(
        task,
        {
          type: 'push',
          headSha: sha,
          changedPaths: PAGE_PATHS,
          addedPaths: [],
          catalogPages: {},
          diffLines: 5
        },
        asAgent('builder')
      );
      task = driver.step(
        task,
        { type: 'review', verdict: 'changes', notes: 'no' },
        asAgent('reviewer_correctness')
      );
      expect(task.stage).toBe('building');
    }
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'c',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 5
      },
      asAgent('builder')
    );
    task = driver.step(
      task,
      { type: 'review', verdict: 'changes', notes: 'no' },
      asAgent('reviewer_correctness')
    );
    expect(task).toMatchObject({ stage: 'ready', assignee: null, fixRounds: 0 });
    expect(task.blocked?.askedOf).toEqual({ role: 'maintainer' });
  });
});

describe('a task over its spend', () => {
  const hold = { type: 'hold_for_spend', spentCents: 2140, limitCents: 2000 } as const;

  test('the engine holds it for a maintainer, who answers to let the agents go on', () => {
    const driver = createDriver([owner]);
    const task = driver.step(dispatchAgent(driver, toReady(driver, PAGE_PATHS)), hold, engine);
    expect(task.blocked).toMatchObject({ askedOf: { role: 'maintainer' } });
    expect(task.blocked?.question).toContain('cost $21.40');
    expect(driver.events()).toContainEqual({
      type: 'guardrail_tripped',
      guardrail: 'spend_limit',
      details: '$21.40 spent, limit $20.00'
    });
    expect(nextAgentRoles(task)).toEqual([]);
    const answered = driver.step(task, { type: 'answer', text: 'Go on.' }, asMember(owner));
    expect(nextAgentRoles(answered)).toEqual(['builder']);
  });

  test('only the engine holds it, and never twice', () => {
    const driver = createDriver([owner]);
    const task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    expect(driver.attempt(task, hold, asMember(owner))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const held = driver.step(task, hold, engine);
    expect(driver.attempt(held, hold, engine)).toEqual({ ok: false, error: 'blocked' });
  });
});

describe('a size allowed for one task', () => {
  const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };
  const RED = ['src/satellite/room.ts'];

  const pushOf = (
    headSha: string,
    changedPaths: readonly string[],
    diffLines: number
  ): Command => ({
    type: 'push',
    headSha,
    changedPaths,
    addedPaths: [],
    catalogPages: {},
    diffLines
  });

  /** A task whose first head, of `lines` lines, the size check held: built by the agent, or in red by the owner. */
  const held = (driver: Driver, paths: readonly string[], lines: number): Task => {
    const ready = toReady(driver, paths);
    if (ready.lane === 'red') {
      const claimed = driver.step(ready, { type: 'claim' }, asMember(owner));
      return driver.step(claimed, pushOf('big', paths, lines), asMember(owner));
    }
    return driver.step(
      dispatchAgent(driver, ready),
      pushOf('big', paths, lines),
      asAgent('builder')
    );
  };

  const pick = (option: string): Command => ({
    type: 'answer',
    text: `Option (${option})`,
    option
  });

  test('the size check offers to allow the size for this task alongside splitting or reducing', () => {
    const driver = createDriver([owner, maintainer]);
    const task = held(driver, PAGE_PATHS, 2449);
    expect(task.stage).toBe('building');
    expect(task.blocked).toMatchObject({
      askedOf: { role: 'maintainer' },
      allowance: { lines: 2449, lane: 'standard', option: 'c' }
    });
    expect(task.blocked?.options?.map((option) => option.label)).toEqual([
      'Split the spec into smaller tasks',
      'Reduce the change',
      'Allow 2449 lines for this task'
    ]);
    expect(driver.events()).toContainEqual({
      type: 'guardrail_tripped',
      guardrail: 'diff_too_large',
      details: '2449 > 800'
    });
  });

  test('picking Split stops the build and sends the task back to the spec agent for a split', () => {
    const driver = createDriver([owner, maintainer, productContributor]);
    const task = held(driver, PAGE_PATHS, 2449);
    expect(task.blocked?.split).toEqual({ option: 'a' });
    expect(driver.attempt(task, pick('a'), asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });

    const split = driver.step(task, pick('a'), asMember(maintainer));
    expect(split).toMatchObject({
      stage: 'speccing',
      blocked: null,
      assignee: null,
      diffAllowance: null,
      specVersion: task.specVersion
    });
    expect(driver.events()).toEqual([
      { type: 'unblocked', answer: 'Option (a)' },
      { type: 'split_asked' },
      { type: 'assigned', assignee: null },
      { type: 'stage_changed', from: 'building', to: 'speccing' }
    ]);
    expect(nextAgentRoles(split)).toEqual(['spec']);
  });

  test('picking Reduce only answers the question, as before', () => {
    const driver = createDriver([owner, maintainer]);
    const task = driver.step(held(driver, PAGE_PATHS, 2449), pick('b'), asMember(maintainer));
    expect(task).toMatchObject({ stage: 'building', blocked: null, diffAllowance: null });
    expect(driver.events().map((event) => event.type)).toEqual(['unblocked']);
  });

  test('a maintainer allows it outside red, and a later head up to that size passes', () => {
    const driver = createDriver([owner, maintainer]);
    let task = driver.step(held(driver, PAGE_PATHS, 2449), pick('c'), asMember(maintainer));
    expect(task.blocked).toBeNull();
    expect(task.diffAllowance).toEqual({ lines: 2449, lane: 'standard', memberId: maintainer.id });
    expect(driver.events()).toContainEqual({
      type: 'diff_allowed',
      lines: 2449,
      lane: 'standard',
      memberId: maintainer.id
    });
    task = driver.step(task, pushOf('fits', PAGE_PATHS, 2449), asAgent('builder'));
    expect(task).toMatchObject({ stage: 'reviewing', headSha: 'fits' });
  });

  test('a head over the allowance is held again with the same question', () => {
    const driver = createDriver([owner, maintainer]);
    let task = driver.step(held(driver, PAGE_PATHS, 2449), pick('c'), asMember(maintainer));
    task = driver.step(task, pushOf('bigger', PAGE_PATHS, 2600), asAgent('builder'));
    expect(task.stage).toBe('building');
    expect(task.blocked?.question).toContain('and the 2449 lines allowed for this task');
    expect(task.blocked?.allowance).toEqual({ lines: 2600, lane: 'standard', option: 'c' });
    expect(task.diffAllowance?.lines).toBe(2449);
    task = driver.step(task, pick('c'), asMember(owner));
    expect(task.diffAllowance).toEqual({ lines: 2600, lane: 'standard', memberId: owner.id });
  });

  test('in the red lane only the owner allows more lines', () => {
    const driver = createDriver([owner, maintainer]);
    const task = held(driver, RED, 2449);
    expect(task.blocked?.options?.[2]?.detail).toContain('Only the owner may choose this.');
    expect(driver.attempt(task, pick('c'), asMember(maintainer))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    // The maintainer may still answer the question another way, which allows nothing.
    const reduced = driver.step(task, pick('b'), asMember(maintainer));
    expect(reduced).toMatchObject({ blocked: null, diffAllowance: null });
    expect(driver.events().some((event) => event.type === 'diff_allowed')).toBe(false);
    const allowed = driver.step(task, pick('c'), asMember(owner));
    expect(allowed.diffAllowance).toEqual({ lines: 2449, lane: 'red', memberId: owner.id });
    const passed = driver.step(allowed, pushOf('port', RED, 2000), asMember(owner));
    expect(passed).toMatchObject({ stage: 'reviewing', headSha: 'port' });
  });

  test('every other task keeps the lane limit', () => {
    const driver = createDriver([owner, maintainer]);
    driver.step(held(driver, PAGE_PATHS, 2449), pick('c'), asMember(maintainer));
    const other = held(driver, PAGE_PATHS, 900);
    expect(other.diffAllowance).toBeNull();
    expect(other.blocked?.allowance?.lines).toBe(900);
  });

  test('an allowance holds only in the lane it was granted in', () => {
    const driver = createDriver([owner, maintainer]);
    let task = driver.step(toReady(driver, PAGE_PATHS), { type: 'claim' }, asMember(owner));
    task = driver.step(task, pushOf('big', PAGE_PATHS, 2449), asMember(owner));
    task = driver.step(task, pick('c'), asMember(maintainer));
    task = driver.step(task, pushOf('red', [...PAGE_PATHS, ...RED], 2000), asMember(owner));
    expect(task).toMatchObject({ stage: 'building', lane: 'red' });
    expect(task.blocked?.allowance).toEqual({ lines: 2000, lane: 'red', option: 'c' });
    expect(task.blocked?.question).not.toContain('allowed for this task');
  });

  test('another question that offers options grants nothing through them', () => {
    const driver = createDriver([owner, maintainer]);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    task = driver.step(
      task,
      {
        type: 'block',
        question: 'Which layout?',
        askedOf: { role: 'maintainer' },
        options: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }]
      },
      asAgent('builder')
    );
    task = driver.step(task, pick('c'), asMember(maintainer));
    expect(task.diffAllowance).toBeNull();
  });
});

describe('permissions', () => {
  test('agents never approve, watchers cannot approve, contributors cannot triage', () => {
    const driver = createDriver([owner, productContributor, watcher]);
    let task = newTask('t1', productContributor.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(productContributor));
    expect(driver.attempt(task, { type: 'accept' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    expect(driver.attempt(task, { type: 'approve' }, asAgent('reviewer_spec'))).toEqual({
      ok: false,
      error: 'agents_cannot_approve'
    });
    expect(driver.attempt(task, { type: 'approve' }, asMember(watcher))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('only the person or role asked can answer a question, owners always can', () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', owner.id);
    task = driver.step(
      task,
      { type: 'block', question: 'Which locale?', askedOf: { role: 'maintainer' } },
      asAgent('interviewer')
    );
    expect(
      driver.attempt(task, { type: 'answer', text: 'it' }, asMember(productContributor))
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(driver.attempt(task, { type: 'approve' }, asMember(owner))).toEqual({
      ok: false,
      error: 'blocked'
    });
    task = driver.step(task, { type: 'answer', text: 'it' }, asMember(owner));
    expect(task.blocked).toBeNull();
  });

  test('a question keeps the options it offers, and an empty list is no options', () => {
    const driver = createDriver([owner]);
    const options = [{ label: 'Keep it' }, { label: 'Rename it' }];
    const asked = driver.step(
      newTask('t1', owner.id),
      { type: 'block', question: 'Which?', askedOf: { memberId: owner.id }, options },
      asAgent('interviewer')
    );
    expect(asked.blocked).toEqual({ question: 'Which?', askedOf: { memberId: owner.id }, options });
    const plain = driver.step(
      newTask('t2', owner.id),
      { type: 'block', question: 'Which?', askedOf: { memberId: owner.id }, options: [] },
      asAgent('interviewer')
    );
    expect(plain.blocked).toEqual({ question: 'Which?', askedOf: { memberId: owner.id } });
  });

  test('submitting a request as is closes an open interview question', () => {
    const driver = createDriver([owner]);
    let task = newTask('t1', owner.id);
    task = driver.step(
      task,
      { type: 'block', question: 'Which screens?', askedOf: { memberId: owner.id } },
      asAgent('interviewer')
    );
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    expect(task).toMatchObject({ stage: 'triage', blocked: null });
    expect(driver.events()).toContainEqual({ type: 'unblocked', answer: '(submitted as is)' });
  });

  test('a request is offered to send on as it is exactly when it may be', () => {
    const driver = createDriver([owner, productContributor]);
    const theirs = newTask('t1', productContributor.id);
    const askThem = { question: 'Which screens?', askedOf: { memberId: productContributor.id } };
    const askOwner = { question: 'Is this allowed?', askedOf: { role: 'owner' as const } };
    const cases: readonly [Task, boolean][] = [
      [theirs, true],
      [{ ...theirs, blocked: askThem }, true],
      [{ ...theirs, paused: true }, false],
      [{ ...theirs, blocked: askOwner }, false]
    ];
    for (const [task, offered] of cases)
      for (const member of [owner, productContributor]) {
        expect(canSubmitRequest(task, member)).toBe(offered);
        expect(driver.attempt(task, { type: 'submit_request' }, asMember(member)).ok).toBe(offered);
      }
  });

  test('the interviewer may submit a request, other agents may not', () => {
    const driver = createDriver([owner]);
    const task = newTask('t1', owner.id);
    expect(driver.step(task, { type: 'submit_request' }, asAgent('interviewer')).stage).toBe(
      'triage'
    );
    expect(driver.attempt(task, { type: 'submit_request' }, asAgent('spec'))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('the requester can cancel their own request and closed tasks accept nothing', () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', productContributor.id);
    task = driver.step(
      task,
      { type: 'cancel', reason: 'not needed' },
      asMember(productContributor)
    );
    expect(task.stage).toBe('cancelled');
    expect(driver.attempt(task, { type: 'accept' }, asMember(owner))).toEqual({
      ok: false,
      error: 'terminal'
    });
  });

  test("only a maintainer declines a request, and a contributor cannot cancel someone else's", () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    for (const type of ['decline', 'cancel'] as const)
      expect(
        driver.attempt(task, { type, reason: 'not needed' }, asMember(productContributor))
      ).toEqual({ ok: false, error: 'not_allowed' });

    const declined = driver.step(
      task,
      { type: 'decline', reason: 'out of scope' },
      asMember(owner)
    );
    expect(declined.stage).toBe('declined');
    expect(driver.events()).toContainEqual({
      type: 'closed',
      stage: 'declined',
      reason: 'out of scope'
    });

    let theirs = newTask('t2', productContributor.id);
    theirs = driver.step(theirs, { type: 'submit_request' }, asMember(productContributor));
    expect(
      driver.step(theirs, { type: 'cancel', reason: 'duplicate' }, asMember(owner)).stage
    ).toBe('cancelled');
  });

  test('a watcher cannot send a spec or a result back, a contributor only where the policy names them', () => {
    const driver = createDriver([owner, productContributor, watcher]);
    const specReview = driver.step(
      driver.step(
        driver.step(newTask('t1', owner.id), { type: 'submit_request' }, asMember(owner)),
        { type: 'accept' },
        asMember(owner)
      ),
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    let verifying = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    verifying = buildAndReview(driver, verifying, 'abc', PAGE_PATHS);
    verifying = driver.step(
      verifying,
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    expect(verifying.stage).toBe('verifying');

    for (const task of [specReview, verifying])
      expect(
        driver.attempt(task, { type: 'request_changes', note: 'no' }, asMember(watcher))
      ).toEqual({ ok: false, error: 'not_allowed' });
    // The standard lane's plan approval names only the owner; its user-visible result, product.
    expect(
      driver.attempt(
        specReview,
        { type: 'request_changes', note: 'name it Preferences' },
        asMember(productContributor)
      )
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      driver.step(
        verifying,
        { type: 'request_changes', note: 'name it Preferences' },
        asMember(productContributor)
      ).stage
    ).toBe('building');
    expect(
      driver.step(specReview, { type: 'request_changes', note: 'no' }, asMember(owner)).stage
    ).toBe('speccing');
  });

  test('only the assignee or a maintainer hands a claimed task back', () => {
    const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };
    const driver = createDriver([owner, maintainer, productContributor]);
    const claimed = driver.step(
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      { type: 'claim' },
      asMember(maintainer)
    );
    expect(driver.attempt(claimed, { type: 'release' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(claimed, { type: 'release' }, asMember(owner))).toMatchObject({
      stage: 'ready',
      assignee: null
    });

    // An assignee whose role was lowered since the claim can still hand it back.
    const lowered = createDriver([owner, { ...maintainer, role: 'contributor' }]);
    expect(lowered.step(claimed, { type: 'release' }, asMember(maintainer))).toMatchObject({
      stage: 'ready',
      assignee: null
    });
  });

  test('only a maintainer pauses or resumes a task, and a paused task takes no decision', () => {
    const driver = createDriver([owner, productContributor]);
    const ready = toReady(driver, PAGE_PATHS);
    expect(driver.attempt(ready, { type: 'pause' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const paused = driver.step(ready, { type: 'pause' }, asMember(owner));
    expect(paused.paused).toBe(true);
    expect(driver.events()).toEqual([{ type: 'paused' }]);
    expect(driver.attempt(paused, { type: 'pause' }, asMember(owner))).toEqual({
      ok: false,
      error: 'already_paused'
    });
    expect(
      driver.attempt(
        paused,
        { type: 'dispatch', assignee: { kind: 'agent', role: 'builder' }, openInLane: 0 },
        engine
      )
    ).toEqual({ ok: false, error: 'paused' });

    expect(driver.attempt(paused, { type: 'resume' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const resumed = driver.step(paused, { type: 'resume' }, asMember(owner));
    expect(resumed.paused).toBe(false);
    expect(driver.events()).toEqual([{ type: 'resumed' }]);
    expect(driver.attempt(resumed, { type: 'resume' }, asMember(owner))).toEqual({
      ok: false,
      error: 'not_paused'
    });
    expect(dispatchAgent(driver, resumed).stage).toBe('building');
  });

  test('the engine dispatches a build only to a member who can build', () => {
    const driver = createDriver([owner, productContributor]);
    const task = toReady(driver, PAGE_PATHS);
    const dispatchTo = (memberId: string) =>
      ({
        type: 'dispatch',
        assignee: { kind: 'member', memberId },
        openInLane: 0
      }) as const;
    expect(driver.attempt(task, dispatchTo(productContributor.id), engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.attempt(task, dispatchTo('nobody'), engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(task, dispatchTo(owner.id), engine)).toMatchObject({
      stage: 'building',
      assignee: { kind: 'member', memberId: owner.id }
    });
  });

  test('a review is recorded only from a reviewer agent or a member who can steer', () => {
    const driver = createDriver([owner, productContributor]);
    const task = driver.step(
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 40
      },
      asAgent('builder')
    );
    expect(task.stage).toBe('reviewing');
    const review = { type: 'review', verdict: 'changes', notes: 'Rename it.' } as const;
    expect(driver.attempt(task, review, asAgent('builder'))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.attempt(task, review, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const byOwner = driver.attempt(task, review, asMember(owner));
    expect(byOwner.ok && byOwner.events).toContainEqual({
      type: 'review_recorded',
      reviewer: 'member',
      verdict: 'changes',
      notes: 'Rename it.'
    });
  });
});

describe('approval chooser', () => {
  const toSpecReview = (driver: Driver, paths = PAGE_PATHS, userVisible = false): Task => {
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    return driver.step(
      task,
      { type: 'post_spec', predictedPaths: paths, userVisible },
      asAgent('spec')
    );
  };

  test('nobody approves a spec version before the chooser has planned it', () => {
    const driver = createDriver([owner]);
    let task = toSpecReview(driver);
    expect(nextAgentRoles(task)).toEqual(['chooser']);
    expect(driver.attempt(task, { type: 'approve' }, asMember(owner))).toEqual({
      ok: false,
      error: 'not_planned'
    });
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(nextAgentRoles(task)).toEqual([]);
    expect(driver.step(task, { type: 'approve' }, asMember(owner)).stage).toBe('ready');
  });

  test('an added domain approval must be met by someone who holds it', () => {
    const driver = createDriver([owner, productContributor]);
    let task = toSpecReview(driver);
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: false,
        plan: {
          ...PLAN,
          extra: [{ requirement: { domain: 'product' }, reason: 'Changes pricing copy.' }]
        }
      },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('spec_review');
    expect(driver.events()).toContainEqual(
      expect.objectContaining({ type: 'approval_recorded', pending: [{ domain: 'product' }] })
    );
    expect(driver.step(task, { type: 'approve' }, asMember(productContributor)).stage).toBe(
      'ready'
    );
  });

  test('a domain nobody holds is waived, never a dead end', () => {
    const driver = createDriver([owner]);
    let task = driver.step(newTask('t1', owner.id), { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: false,
        plan: { ...PLAN, extra: [{ requirement: { domain: 'legal' }, reason: 'Terms text.' }] }
      },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('ready');
    expect(driver.events()).toContainEqual(
      expect.objectContaining({ type: 'approval_recorded', waived: [{ domain: 'legal' }] })
    );
  });

  test('plans only ever add: a later plan cannot drop an earlier requirement', () => {
    const driver = createDriver([owner, productContributor]);
    let task = toSpecReview(driver);
    const legal = { requirement: { domain: 'legal' }, reason: 'Terms text.' };
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: { ...PLAN, extra: [legal] } },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'request_changes', note: 'shorter' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    expect(nextAgentRoles(task)).toEqual(['chooser']);
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: false,
        plan: {
          ...PLAN,
          verifiers: [
            { memberId: productContributor.id, reason: 'Owns pricing.' },
            { memberId: 'stranger', reason: 'Not a member.' }
          ]
        }
      },
      asAgent('chooser')
    );
    expect(task.approvalPlans.spec_review).toMatchObject({
      subject: 'spec:2',
      extra: [legal],
      verifiers: [{ memberId: productContributor.id, reason: 'Owns pricing.' }]
    });
    expect(effectivePolicy(driver.config, task, 'spec_review')).toContainEqual({ domain: 'legal' });
  });

  test('only the chooser or the engine plans approvals', () => {
    const driver = createDriver([owner]);
    const task = toSpecReview(driver);
    expect(
      driver.attempt(
        task,
        { type: 'plan_approval', userVisible: false, plan: PLAN },
        asMember(owner)
      )
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      driver.attempt(
        task,
        { type: 'plan_approval', userVisible: false, plan: PLAN },
        asAgent('spec')
      )
    ).toEqual({ ok: false, error: 'not_allowed' });
  });
});

describe('auto-verify', () => {
  const autoConfig = (onMerge: string) =>
    loadConfig(
      CONFIG_YAML.replace('version: 1', `version: 1\nrelease: { on_merge: ${onMerge} }`).replace(
        '  green:\n',
        '  green:\n    auto_verify: true\n'
      )
    );
  const GLANCE: PlanInput = { ...PLAN, depth: 'glance' };

  const toChoosing = (driver: Driver, paths = COPY_PATHS) =>
    buildAndReview(driver, dispatchAgent(driver, toReady(driver, paths, true)), 'abc', paths);

  test('a green result goes straight to merge when a merge only reaches staging', () => {
    const driver = createDriver([owner], autoConfig('staging'));
    let task = toChoosing(driver);
    task = driver.step(
      task,
      { type: 'choose', userVisible: true, plan: GLANCE },
      asAgent('chooser')
    );
    expect(task.stage).toBe('merging');
    expect(driver.events()).toContainEqual({ type: 'auto_verified', subject: 'sha:abc' });
  });

  test('people still verify when a merge deploys to production', () => {
    const driver = createDriver([owner], autoConfig('production'));
    let task = toChoosing(driver);
    task = driver.step(
      task,
      { type: 'choose', userVisible: true, plan: GLANCE },
      asAgent('chooser')
    );
    expect(task.stage).toBe('verifying');
  });

  test('the chooser keeps the human check by asking for more than a glance or an approval', () => {
    const driver = createDriver([owner], autoConfig('nothing'));
    const deeper = driver.step(
      toChoosing(driver),
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    expect(deeper.stage).toBe('verifying');

    const other = createDriver([owner], autoConfig('nothing'));
    const added = other.step(
      toChoosing(other),
      {
        type: 'choose',
        userVisible: true,
        plan: { ...GLANCE, extra: [{ requirement: { role: 'owner' }, reason: 'Pricing copy.' }] }
      },
      asAgent('chooser')
    );
    expect(added.stage).toBe('verifying');
  });

  test('a standard change is always verified by people', () => {
    const driver = createDriver([owner], autoConfig('nothing'));
    const task = driver.step(
      toChoosing(driver, PAGE_PATHS),
      { type: 'choose', userVisible: true, plan: GLANCE },
      asAgent('chooser')
    );
    expect(task.stage).toBe('verifying');
  });
});

describe('who merges', () => {
  test('the chooser decides per result, and a later plan cannot hand the merge back', () => {
    const driver = createDriver([owner]);
    let task = driver.step(newTask('t1', owner.id), { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: { ...PLAN, merge: 'auto' } },
      asAgent('chooser')
    );
    // The spec gate has nothing to merge.
    expect(task.approvalPlans.spec_review?.merge).toBe('person');

    const choosing = () =>
      buildAndReview(driver, dispatchAgent(driver, toReady(driver, PAGE_PATHS)), 'abc', PAGE_PATHS);
    const auto = driver.step(
      choosing(),
      { type: 'choose', userVisible: true, plan: { ...PLAN, merge: 'auto' } },
      asAgent('chooser')
    );
    expect(auto.approvalPlans.verifying?.merge).toBe('auto');

    task = driver.step(
      choosing(),
      { type: 'choose', userVisible: true, plan: { ...PLAN, merge: 'person' } },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'request_changes', note: 'wrong colour' }, asMember(owner));
    task = buildAndReview(driver, task, 'def', PAGE_PATHS);
    task = driver.step(
      task,
      { type: 'choose', userVisible: true, plan: { ...PLAN, merge: 'auto' } },
      asAgent('chooser')
    );
    expect(task.approvalPlans.verifying).toMatchObject({ subject: 'sha:def', merge: 'person' });
    // A plan recorded before the choice existed has no `merge`, which counts as a person.
    const legacy = driver.step(
      choosing(),
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    const { merge: _dropped, ...older } = legacy.approvalPlans.verifying!;
    let migrated: Task = {
      ...legacy,
      approvalPlans: { ...legacy.approvalPlans, verifying: older }
    };
    migrated = driver.step(migrated, { type: 'request_changes', note: 'again' }, asMember(owner));
    migrated = buildAndReview(driver, migrated, 'ghi', PAGE_PATHS);
    migrated = driver.step(
      migrated,
      { type: 'choose', userVisible: true, plan: { ...PLAN, merge: 'auto' } },
      asAgent('chooser')
    );
    expect(migrated.approvalPlans.verifying?.merge).toBe('person');
  });
});

describe('reviews on GitHub', () => {
  const review = (headSha: string) =>
    ({
      type: 'github_review',
      headSha,
      by: 'copilot-pull-request-reviewer[bot]',
      source: { reviewId: 7 },
      notes: 'Rename the key.',
      overviewOnly: false
    }) as const;

  test('a review of the current head sends the work back to the builder', () => {
    const driver = createDriver([owner]);
    let task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, review('abc'), engine);
    expect(task).toMatchObject({ stage: 'building', fixRounds: 1 });
    expect(driver.events()[0]).toMatchObject({
      type: 'review_recorded',
      reviewer: 'github',
      verdict: 'changes',
      githubReviewId: 7
    });
  });

  test('a review of an earlier head, or from anyone but the engine, changes nothing', () => {
    const driver = createDriver([owner]);
    const task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    expect(driver.attempt(task, review('old'), engine)).toEqual({ ok: false, error: 'stale_head' });
    expect(driver.attempt(task, review('abc'), asMember(owner))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('a fix round that finds nothing to change keeps the head and goes back to review', () => {
    const driver = createDriver([owner]);
    let task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, review('abc'), engine);
    expect(driver.attempt(task, { type: 'unchanged', note: 'Nothing applies.' }, engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    task = driver.step(task, { type: 'unchanged', note: 'Nothing applies.' }, asAgent('builder'));
    expect(task).toMatchObject({ stage: 'reviewing', headSha: 'abc', reviews: {} });
    expect(driver.events()[0]).toEqual({
      type: 'build_unchanged',
      headSha: 'abc',
      note: 'Nothing applies.'
    });
  });

  test('a first round cannot finish unchanged, since it has built nothing', () => {
    const driver = createDriver([owner]);
    const task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    expect(
      driver.attempt(task, { type: 'unchanged', note: 'Nothing to do.' }, asAgent('builder'))
    ).toEqual({ ok: false, error: 'wrong_stage' });
  });

  test("a bot's comment on the pull request is recorded as a comment, not a review", () => {
    const driver = createDriver([owner]);
    const task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    driver.step(task, { ...review('abc'), source: { commentId: 31 }, overviewOnly: true }, engine);
    expect(driver.events()[0]).toMatchObject({ githubCommentId: 31, overviewOnly: true });
    expect(driver.events()[0]).not.toHaveProperty('githubReviewId');
  });
});

describe('failing checks on GitHub', () => {
  const failed = (headSha: string) =>
    ({ type: 'ci_failed', headSha, details: 'GitHub Actions: failure' }) as const;

  test('send the work back from review, planning and verification, not only from merging', () => {
    const driver = createDriver([owner]);
    const reviewing = driver.step(
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 40
      },
      asAgent('builder')
    );
    const choosing = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    const verifying = driver.step(
      choosing,
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    for (const task of [reviewing, choosing, verifying]) {
      expect(driver.step(task, failed('abc'), engine)).toMatchObject({
        stage: 'building',
        fixRounds: 1
      });
      expect(driver.events()[0]).toEqual(failed('abc'));
    }
  });

  test('on an earlier head, while building, or from anyone but the engine, change nothing', () => {
    const driver = createDriver([owner]);
    const building = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    expect(driver.attempt(building, failed('abc'), engine)).toEqual({
      ok: false,
      error: 'wrong_stage'
    });
    const choosing = buildAndReview(driver, building, 'abc', PAGE_PATHS);
    expect(driver.attempt(choosing, failed('old'), engine)).toEqual({
      ok: false,
      error: 'stale_head'
    });
    expect(driver.attempt(choosing, failed('abc'), asMember(owner))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });
});

describe('pushes from outside Officina', () => {
  const outside = (headSha: string, changedPaths: readonly string[] = PAGE_PATHS) =>
    ({
      type: 'outside_push',
      headSha,
      changedPaths,
      addedPaths: [],
      catalogPages: {},
      diffLines: 50
    }) as const;

  test('a new head is reviewed, planned and verified again, without a fix round', () => {
    const driver = createDriver([owner]);
    let task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(task, outside('fix1'), engine);
    expect(task).toMatchObject({ stage: 'reviewing', headSha: 'fix1', reviews: {}, fixRounds: 0 });
    expect(driver.events()).toEqual([
      { type: 'stage_changed', from: 'verifying', to: 'building' },
      {
        type: 'pushed',
        headSha: 'fix1',
        changedPaths: PAGE_PATHS,
        diffLines: 50,
        outside: true
      },
      { type: 'stage_changed', from: 'building', to: 'reviewing' }
    ]);
    // Approving needs a plan for the new head, so nothing verified for the old one carries over.
    task = driver.step(
      task,
      { type: 'review', verdict: 'approve', notes: '' },
      asAgent('reviewer_spec')
    );
    task = driver.step(
      task,
      { type: 'review', verdict: 'approve', notes: '' },
      asAgent('reviewer_correctness')
    );
    expect(task.approvalPlans.verifying?.subject).toBe('sha:abc');
    expect(
      driver.attempt({ ...task, stage: 'verifying' }, { type: 'approve' }, asMember(owner))
    ).toEqual({ ok: false, error: 'not_planned' });
  });

  test('a head that reaches paths agents may not change holds the task for the owner', () => {
    const driver = createDriver([owner]);
    const task = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    const held = driver.step(
      task,
      outside('bot1', [...PAGE_PATHS, '.github/workflows/ci.yml']),
      engine
    );
    expect(held).toMatchObject({ stage: 'ready', lane: 'red', assignee: null });
    expect(held.blocked?.question).toContain('.github/workflows/ci.yml');
  });

  test('the head Officina already holds, a build in progress, or anyone but the engine, change nothing', () => {
    const driver = createDriver([owner]);
    const building = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    expect(driver.attempt(building, outside('abc'), engine)).toEqual({
      ok: false,
      error: 'wrong_stage'
    });
    const choosing = buildAndReview(driver, building, 'abc', PAGE_PATHS);
    expect(driver.attempt(choosing, outside('abc'), engine)).toEqual({
      ok: false,
      error: 'stale_head'
    });
    expect(driver.attempt(choosing, outside('fix1'), asAgent('builder'))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });
});

describe('onboarding', () => {
  const onboardingAt = (stage: Task['stage']): Task => ({
    ...newTask('t9', owner.id, 'onboarding'),
    stage,
    lane: 'standard',
    specVersion: 1
  });
  const dispatch = (role: 'builder' | 'onboarder') => ({
    type: 'dispatch' as const,
    assignee: { kind: 'agent' as const, role },
    openInLane: 0
  });
  /** A driver for a project whose onboarding task is still open. */
  const gated = () => createDriver([owner], loadConfig(), { onboardingOpen: true });

  test('no request is dispatched while the project has an open onboarding task', () => {
    const driver = gated();
    const task = toReady(driver, PAGE_PATHS);
    expect(driver.attempt(task, dispatch('builder'), engine)).toEqual({
      ok: false,
      error: 'awaiting_onboarding'
    });
    expect(createDriver([owner]).step(task, dispatch('builder'), engine).stage).toBe('building');
    // People still decide: a maintainer can claim the work by hand.
    expect(driver.step(task, { type: 'claim' }, asMember(owner)).stage).toBe('building');
  });

  test('the onboarding task goes to the onboarder, never to the builder', () => {
    const driver = gated();
    const task = onboardingAt('ready');
    expect(driver.attempt(task, dispatch('builder'), engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const building = driver.step(task, dispatch('onboarder'), engine);
    expect(nextAgentRoles(building)).toEqual(['onboarder']);
    expect(
      driver.attempt(
        building,
        {
          type: 'push',
          headSha: 'abc',
          changedPaths: ['AGENTS.md'],
          addedPaths: [],
          catalogPages: {},
          diffLines: 10
        },
        asAgent('builder')
      )
    ).toEqual({ ok: false, error: 'not_allowed' });
  });

  test('the gate never holds the onboarding task itself, from dispatch to merge', () => {
    const driver = gated();
    const docs = ['AGENTS.md', 'docs/ai/README.md'];
    let task = driver.step(onboardingAt('ready'), dispatch('onboarder'), engine);
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: docs,
        addedPaths: [],
        catalogPages: {},
        diffLines: 120
      },
      asAgent('onboarder')
    );
    for (const role of ['reviewer_spec', 'reviewer_correctness'] as const)
      task = driver.step(task, { type: 'review', verdict: 'approve', notes: '' }, asAgent(role));
    // A review that asks for changes is a fix round for the onboarder, never a new dispatch.
    const fixing = driver.step(
      { ...task, stage: 'reviewing', reviews: {} },
      { type: 'review', verdict: 'changes', notes: 'name the real paths' },
      asAgent('reviewer_correctness')
    );
    expect(fixing).toMatchObject({ stage: 'building', assignee: { role: 'onboarder' } });
    expect(nextAgentRoles(fixing)).toEqual(['onboarder']);
    task = driver.step(
      task,
      { type: 'choose', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(task.stage).toBe('verifying');
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('merging');
    task = driver.step(task, { type: 'merged' }, engine);
    expect(task.stage).toBe('done');
  });

  test('a pull request closed without a merge sends the task back, held for a maintainer', () => {
    const driver = gated();
    const building = driver.step(onboardingAt('ready'), dispatch('onboarder'), engine);
    // Before the first push there is no pull request to close.
    expect(
      driver.attempt(building, { type: 'pull_request_closed', pullRequest: 7 }, engine)
    ).toEqual({ ok: false, error: 'wrong_stage' });
    const reviewing = driver.step(
      building,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: ['AGENTS.md'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 10
      },
      asAgent('onboarder')
    );
    expect(
      driver.attempt(reviewing, { type: 'pull_request_closed', pullRequest: 7 }, asMember(owner))
    ).toEqual({ ok: false, error: 'not_allowed' });
    const held = driver.step(reviewing, { type: 'pull_request_closed', pullRequest: 7 }, engine);
    expect(held).toMatchObject({ stage: 'ready', assignee: null, headSha: null, fixRounds: 0 });
    expect(held.blocked?.question).toContain('#7');
    expect(held.blocked?.askedOf).toEqual({ role: 'maintainer' });
    expect(driver.events()).toContainEqual({ type: 'pull_request_closed', pullRequest: 7 });
    // Answering lets the engine dispatch it again as a first round; cancelling lifts the gate.
    const answered = driver.step(held, { type: 'answer', text: 'build it again' }, asMember(owner));
    expect(driver.step(answered, dispatch('onboarder'), engine).stage).toBe('building');
    expect(driver.step(held, { type: 'cancel', reason: 'not now' }, asMember(owner)).stage).toBe(
      'cancelled'
    );
  });

  test('the engine may close an onboarding task whose pages exist, never a request', () => {
    const driver = gated();
    const reason = 'every required agent docs page is on the default branch already';
    expect(driver.step(onboardingAt('ready'), { type: 'cancel', reason }, engine).stage).toBe(
      'cancelled'
    );
    const request = toReady(driver, PAGE_PATHS);
    expect(driver.attempt(request, { type: 'cancel', reason }, engine)).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test('the onboarder may change the agent docs and nothing else', () => {
    const driver = gated();
    const building = driver.step(onboardingAt('ready'), dispatch('onboarder'), engine);
    const docs = ['AGENTS.md', 'CLAUDE.md', 'docs/ai/README.md', 'docs/ai/workflows/add-a-page.md'];
    const reviewed = driver.step(
      building,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: docs,
        addedPaths: [],
        catalogPages: {},
        diffLines: 300
      },
      asAgent('onboarder')
    );
    expect(reviewed.stage).toBe('reviewing');

    const stopped = driver.step(
      building,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: [...docs, 'src/app.ts'],
        addedPaths: [],
        catalogPages: {},
        diffLines: 310
      },
      asAgent('onboarder')
    );
    expect(stopped).toMatchObject({ stage: 'ready', assignee: null });
    expect(stopped.blocked?.question).toContain('src/app.ts');
    expect(driver.events()).toContainEqual({
      type: 'guardrail_tripped',
      guardrail: 'outside_agent_docs',
      details: 'src/app.ts'
    });
  });
});

describe('sub-tasks and their order', () => {
  const dispatch: Command = {
    type: 'dispatch',
    assignee: { kind: 'agent', role: 'builder' },
    openInLane: 0
  };
  /** A driver for a task that waits for task 3 to be merged. */
  const waiting = () =>
    createDriver([owner], loadConfig(), { buildWait: { kind: 'after', numbers: [3] } });

  test('a ready task that waits for other tasks is neither dispatched nor claimed', () => {
    const driver = waiting();
    const task = toReady(driver, PAGE_PATHS);
    for (const [command, actor] of [
      [dispatch, engine],
      [{ type: 'claim' }, asMember(owner)]
    ] as const)
      expect(driver.attempt(task, command, actor)).toEqual({ ok: false, error: 'awaiting_tasks' });
    const free = createDriver([owner], loadConfig(), { buildWait: null });
    expect(free.step(task, dispatch, engine).stage).toBe('building');
    expect(free.step(task, { type: 'claim' }, asMember(owner)).stage).toBe('building');
  });

  test('taking over a build already under way is not held', () => {
    const building = dispatchAgent(
      createDriver([owner]),
      toReady(createDriver([owner]), PAGE_PATHS)
    );
    const taken = waiting().step(building, { type: 'claim' }, asMember(owner));
    expect(taken.assignee).toEqual({ kind: 'member', memberId: owner.id });
  });

  test('the engine closes a parent once its sub-tasks merged, even while it is held', () => {
    const driver = createDriver([owner]);
    const held = driver.step(
      toReady(driver, PAGE_PATHS),
      { type: 'block', question: 'Which locale?', askedOf: { role: 'maintainer' } },
      asMember(owner)
    );
    const closed = driver.step(held, { type: 'close_parent', subtasks: [3, 4] }, engine);
    expect(closed).toMatchObject({ stage: 'done', assignee: null, blocked: null });
    expect(driver.events()).toEqual([
      { type: 'subtasks_merged', subtasks: [3, 4] },
      { type: 'stage_changed', from: 'ready', to: 'done' }
    ]);
  });

  test('only the engine closes a parent, and never a closed one', () => {
    const driver = createDriver([owner]);
    const task = toReady(driver, PAGE_PATHS);
    const close: Command = { type: 'close_parent', subtasks: [3] };
    expect(driver.attempt(task, close, asMember(owner))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    const done = driver.step(task, close, engine);
    expect(driver.attempt(done, close, engine)).toEqual({ ok: false, error: 'terminal' });
  });
});

describe('catalog check', () => {
  const withCatalog = loadConfig(
    CONFIG_YAML.replace(
      'docs: { entry: AGENTS.md }',
      "docs: { entry: AGENTS.md, catalogs: { 'src/lib/components/**': reusability.md } }"
    )
  );
  const NEW_COMPONENT = 'src/lib/components/Chip.svelte';

  test('a new shared file the catalog does not name goes back to the builder, head kept', () => {
    const driver = createDriver([owner], withCatalog);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    // The page was edited in the same push, but still says nothing about the new file.
    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: [...PAGE_PATHS, NEW_COMPONENT, 'docs/ai/reusability.md'],
        addedPaths: [NEW_COMPONENT],
        catalogPages: { 'docs/ai/reusability.md': '# Reusability\n\n- `$lib/Button.svelte`\n' },
        diffLines: 40
      },
      asAgent('builder')
    );
    expect(task).toMatchObject({ stage: 'building', headSha: 'abc', fixRounds: 1, blocked: null });
    expect(nextAgentRoles(task)).toEqual(['builder']);
    const finding = driver.events().find((event) => event.type === 'guardrail_tripped');
    expect(finding).toMatchObject({ guardrail: 'unlisted_files' });
    expect(JSON.stringify(finding)).toContain('docs/ai/reusability.md');

    task = driver.step(
      task,
      {
        type: 'push',
        headSha: 'def',
        changedPaths: [...PAGE_PATHS, NEW_COMPONENT, 'docs/ai/reusability.md'],
        addedPaths: [NEW_COMPONENT],
        catalogPages: {
          'docs/ai/reusability.md': '# Reusability\n\n- `$lib/components/Chip.svelte`: a chip\n'
        },
        diffLines: 44
      },
      asAgent('builder')
    );
    expect(task.stage).toBe('reviewing');
  });

  test('past the fix rounds the finding holds the task for a maintainer', () => {
    const driver = createDriver([owner], withCatalog);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    const push = {
      type: 'push' as const,
      headSha: 'abc',
      changedPaths: [NEW_COMPONENT],
      addedPaths: [NEW_COMPONENT],
      catalogPages: {},
      diffLines: 10
    };
    task = driver.step(task, push, asAgent('builder'));
    task = driver.step(task, push, asAgent('builder'));
    task = driver.step(task, push, asAgent('builder'));
    expect(task).toMatchObject({ stage: 'ready', assignee: null });
    expect(task.blocked?.askedOf).toEqual({ role: 'maintainer' });
  });
});

describe('the requester is not assumed to approve their own task', () => {
  const marco = { id: 'marco', role: 'maintainer', domains: [] } as const;
  const SEPARATE = `${CONFIG_YAML}approvals:\n  self_approval: false\n`;

  const plannedSpec = (driver: Driver): Task => {
    let task = newTask('t1', marco.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(marco));
    task = driver.step(task, { type: 'accept' }, asMember(marco));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: COPY_PATHS, userVisible: false },
      asAgent('spec')
    );
    return driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
  };

  test('by default a maintainer who asked can also approve the plan', () => {
    const driver = createDriver([owner, marco]);
    const task = driver.step(plannedSpec(driver), { type: 'approve' }, asMember(marco));
    // The green lane needs the requester and a product approver (nobody holds it: waived).
    expect(task.stage).toBe('ready');
  });

  test('with self_approval off, someone else must meet the maintainer floor', () => {
    const driver = createDriver([owner, marco], loadConfig(SEPARATE));
    let task = driver.step(plannedSpec(driver), { type: 'approve' }, asMember(marco));
    expect(task.stage).toBe('spec_review');
    expect(driver.events()).toContainEqual(
      expect.objectContaining({ type: 'approval_recorded', pending: [{ role: 'maintainer' }] })
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('ready');
  });

  test('with self_approval off, a requester alone in the project is never stuck', () => {
    const driver = createDriver([marco], loadConfig(SEPARATE));
    expect(driver.step(plannedSpec(driver), { type: 'approve' }, asMember(marco)).stage).toBe(
      'ready'
    );
  });
});

describe('work agents cannot or should not do goes to a person', () => {
  const developerPlan: PlanInput = {
    ...PLAN,
    build: 'person',
    buildReason: 'A large port of the static design.'
  };

  test('a plan that asks for a developer keeps agents off the build until a maintainer claims it', () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: developerPlan },
      asAgent('chooser')
    );
    // A later plan cannot hand the build back to the agent.
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(task.approvalPlans.spec_review).toMatchObject({
      build: 'person',
      buildReason: 'A large port of the static design.'
    });
    expect(humanBuildReason(driver.config, task)).toBe('A large port of the static design.');
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(task.stage).toBe('ready');

    const agent = { kind: 'agent', role: 'builder' } as const;
    expect(
      driver.attempt(task, { type: 'dispatch', assignee: agent, openInLane: 0 }, engine)
    ).toEqual({ ok: false, error: 'needs_developer' });
    expect(driver.attempt(task, { type: 'claim' }, asMember(productContributor)).ok).toBe(false);
    expect(driver.step(task, { type: 'claim' }, asMember(owner))).toMatchObject({
      stage: 'building',
      assignee: { kind: 'member', memberId: owner.id }
    });
  });

  test('a contributor with the developer domain claims it, but not from another person', () => {
    const dev = { id: 'dev', role: 'contributor', domains: ['developer'] } as const;
    const other = { id: 'other', role: 'contributor', domains: ['developer'] } as const;
    const driver = createDriver([owner, dev, other]);
    let task = toReady(driver, PAGE_PATHS);
    task = driver.step(task, { type: 'claim' }, asMember(dev));
    expect(task).toMatchObject({
      stage: 'building',
      assignee: { kind: 'member', memberId: 'dev' }
    });
    expect(driver.attempt(task, { type: 'claim' }, asMember(other))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(task, { type: 'claim' }, asMember(owner)).assignee).toEqual({
      kind: 'member',
      memberId: owner.id
    });
  });

  test('a person hands in only while they may still build the task they claimed', () => {
    const dev: Member = { id: 'dev', role: 'contributor', domains: ['developer'] };
    const driver = createDriver([owner, dev]);
    const claimed = driver.step(toReady(driver, PAGE_PATHS), { type: 'claim' }, asMember(dev));
    const push = {
      type: 'push',
      headSha: 'abc',
      changedPaths: PAGE_PATHS,
      addedPaths: [],
      catalogPages: {},
      diffLines: 10
    } as const;
    const refused = { ok: false, error: 'not_allowed' } as const;
    // Demoted to a watcher, or no longer a developer.
    const since: Member[] = [
      { ...dev, role: 'watcher' },
      { ...dev, domains: [] }
    ];
    for (const now of since)
      expect(createDriver([owner, now]).attempt(claimed, push, asMember(dev))).toEqual(refused);
    // The task became confidential, which they may not read.
    expect(driver.attempt({ ...claimed, guards: ['confidential'] }, push, asMember(dev))).toEqual(
      refused
    );
    expect(driver.attempt(claimed, push, asMember(dev)).ok).toBe(true);
  });

  test('only an agent result hands a task to a person; a member asks an ordinary question', () => {
    const driver = createDriver([owner]);
    const task = newTask('t1', owner.id);
    const handoff = { needs: ['secrets' as const] };
    const byAgent = driver.step(
      task,
      { type: 'block', question: 'Needs a key.', askedOf: { role: 'owner' }, handoff },
      asAgent('interviewer')
    );
    expect(byAgent.blocked).toEqual({
      question: 'Needs a key.',
      askedOf: { role: 'owner' },
      handoff
    });
    const byMember = driver.step(
      task,
      { type: 'block', question: 'Which one?', askedOf: { role: 'owner' }, handoff },
      asMember(owner)
    );
    expect(byMember.blocked).not.toHaveProperty('handoff');
  });
});

describe('guarded tasks', () => {
  const GUARDED = `${CONFIG_YAML}guards:\n  confidential: ['room/**']\n  publishing: ['CNAME']\n`;

  test('a push that adds a secret file never reaches review and goes to the owner', () => {
    const driver = createDriver([owner]);
    const task = dispatchAgent(driver, toReady(driver, PAGE_PATHS));
    const next = driver.step(
      task,
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: ['src/routes/+page.svelte', '.env'],
        addedPaths: ['.env'],
        catalogPages: {},
        diffLines: 10
      },
      asAgent('builder')
    );
    expect(next).toMatchObject({ stage: 'ready', assignee: null });
    expect(next.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(driver.events()).toContainEqual({
      type: 'guardrail_tripped',
      guardrail: 'secret_files',
      details: '.env'
    });
  });

  test('a change that publishes needs the owner, never skips people and never auto-merges', () => {
    const driver = createDriver([owner], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['CNAME', ...COPY_PATHS], userVisible: false },
      asAgent('spec')
    );
    expect(task.guards).toEqual(['publishing']);
    expect(driver.events()).toContainEqual({ type: 'guards_changed', guards: ['publishing'] });
    expect(effectivePolicy(driver.config, task, 'spec_review')).toContainEqual({ role: 'owner' });
    expect(canAutoVerify(driver.config, { ...task, lane: 'green' })).toBe(false);
  });

  test('a lane that already asks for the owner gets one owner requirement from a publishing guard', () => {
    const maintainer: Member = { id: 'marco', role: 'maintainer', domains: [] };
    const driver = createDriver([owner, maintainer], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['CNAME', ...PAGE_PATHS], userVisible: false },
      asAgent('spec')
    );
    expect(task).toMatchObject({ lane: 'standard', guards: ['publishing'] });
    for (const gate of ['spec_review', 'verifying'] as const) {
      const policy = effectivePolicy(driver.config, task, gate);
      expect(policy.filter((requirement) => 'role' in requirement)).toEqual([{ role: 'owner' }]);
      const byMaintainer = evaluatePolicy(policy, [{ memberId: maintainer.id, subject: 's' }], {
        gate,
        members: [owner, maintainer],
        requesterId: owner.id,
        userVisible: false,
        subject: 's',
        selfApproval: true,
        guards: task.guards
      });
      expect(byMaintainer).toMatchObject({ satisfied: false, pending: [{ role: 'owner' }] });
    }
  });

  test('confidential content is approved only by members who may see it', () => {
    const ceo = { id: 'tim', role: 'contributor', domains: ['product', 'confidential'] } as const;
    const driver = createDriver([owner, productContributor, ceo], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['room/investors.md'], userVisible: true },
      asAgent('spec')
    );
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: true,
        plan: { ...PLAN, extra: [{ requirement: { domain: 'product' }, reason: 'Copy.' }] }
      },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    task = driver.step(task, { type: 'approve' }, asMember(productContributor));
    // Gio holds product but may not see confidential content: his approval meets nothing.
    expect(task.stage).toBe('spec_review');
    expect(driver.step(task, { type: 'approve' }, asMember(ceo)).stage).toBe('ready');
  });

  test('nobody claims the build of a confidential task they may not read', () => {
    const dev = { id: 'dev', role: 'contributor', domains: ['developer'] } as const;
    const trusted = {
      id: 'eva',
      role: 'contributor',
      domains: ['developer', 'confidential']
    } as const;
    const driver = createDriver([owner, dev, trusted], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['room/deck.md'], userVisible: false },
      asAgent('spec')
    );
    task = driver.step(
      task,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    task = driver.step(task, { type: 'approve' }, asMember(owner));
    expect(driver.attempt(task, { type: 'claim' }, asMember(dev))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(task, { type: 'claim' }, asMember(trusted)).stage).toBe('building');
  });

  test('nobody sends back or answers on a confidential task they may not read', () => {
    const ceo = { id: 'tim', role: 'contributor', domains: ['product', 'confidential'] } as const;
    const driver = createDriver([owner, productContributor, ceo], loadConfig(GUARDED));
    let task = newTask('t1', owner.id);
    task = driver.step(task, { type: 'submit_request' }, asMember(owner));
    task = driver.step(task, { type: 'accept' }, asMember(owner));
    task = driver.step(
      task,
      { type: 'post_spec', predictedPaths: ['room/investors.md'], userVisible: true },
      asAgent('spec')
    );
    task = driver.step(
      task,
      {
        type: 'plan_approval',
        userVisible: true,
        plan: { ...PLAN, extra: [{ requirement: { domain: 'product' }, reason: 'Copy.' }] }
      },
      asAgent('chooser')
    );
    const changes = { type: 'request_changes', note: 'no' } as const;
    expect(driver.attempt(task, changes, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(task, changes, asMember(ceo)).stage).toBe('speccing');

    const asked = driver.step(
      task,
      { type: 'block', question: 'Which deck?', askedOf: { role: 'contributor' } },
      asAgent('spec')
    );
    const answer = { type: 'answer', text: 'The new one.' } as const;
    expect(driver.attempt(asked, answer, asMember(productContributor))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
    expect(driver.step(asked, answer, asMember(ceo)).blocked).toBeNull();
  });

  test('submitting as is cannot skip a hold for the owner', () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', productContributor.id);
    task = driver.step(
      task,
      { type: 'block', question: 'About secrets.', askedOf: { role: 'owner' } },
      engine
    );
    expect(driver.attempt(task, { type: 'submit_request' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'blocked'
    });
    task = driver.step(task, { type: 'answer', text: 'Go ahead.' }, asMember(owner));
    expect(driver.step(task, { type: 'submit_request' }, asMember(productContributor)).stage).toBe(
      'triage'
    );
  });

  test("Officina's added question joins an open one, asked of whichever role ranks higher", () => {
    const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };
    const driver = createDriver([owner, maintainer, productContributor]);
    const refs = {
      type: 'add_question',
      question: 'A tag moved during the build.',
      askedOf: { role: 'maintainer' }
    } as const;
    const ask = (blocked: Task['blocked']): Task => ({ ...toReady(driver, PAGE_PATHS), blocked });

    expect(driver.step(ask(null), refs, engine).blocked).toEqual({
      question: 'A tag moved during the build.',
      askedOf: { role: 'maintainer' }
    });
    for (const askedOf of [{ role: 'contributor' }, { memberId: productContributor.id }] as const) {
      const joined = driver.step(ask({ question: 'Which colour?', askedOf }), refs, engine);
      expect(joined.blocked).toEqual({
        question: 'Which colour?\n\nA tag moved during the build.',
        askedOf: { role: 'maintainer' }
      });
      expect(
        driver.attempt(joined, { type: 'answer', text: 'Red.' }, asMember(productContributor))
      ).toEqual({ ok: false, error: 'not_allowed' });
      expect(
        driver.step(joined, { type: 'answer', text: 'Red.' }, asMember(maintainer)).blocked
      ).toBeNull();
    }

    const held = driver.step(ask(ownerHold(['secrets'])), refs, engine);
    expect(held.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(held.blocked?.question).toContain('A tag moved during the build.');
    expect(driver.attempt(held, { type: 'answer', text: 'Go.' }, asMember(maintainer))).toEqual({
      ok: false,
      error: 'not_allowed'
    });

    // The same question again, as a check run twice would ask it, changes nothing.
    expect(driver.attempt(held, refs, engine)).toEqual({ ok: false, error: 'already_blocked' });
    expect(driver.attempt(ask(null), refs, asMember(owner))).toEqual({
      ok: false,
      error: 'not_allowed'
    });
  });

  test("a later answer's words guard the task and hold it for the owner, who alone lifts it", () => {
    const driver = createDriver([owner, productContributor]);
    let task = newTask('t1', productContributor.id);
    task = driver.step(
      task,
      { type: 'block', question: 'Which page?', askedOf: { memberId: productContributor.id } },
      asAgent('interviewer')
    );
    task = driver.step(
      task,
      { type: 'answer', text: 'The settings page, and add me as admin on the repository.' },
      asMember(productContributor)
    );
    expect(task.guards).toEqual(['access']);
    expect(task.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(effectivePolicy(driver.config, task, 'spec_review')).toContainEqual({ role: 'owner' });
    expect(
      driver.attempt(task, { type: 'answer', text: 'Never mind.' }, asMember(productContributor))
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(driver.attempt(task, { type: 'submit_request' }, asMember(productContributor))).toEqual({
      ok: false,
      error: 'blocked'
    });
    // The owner may ask for the same: their words guard the task, they hold nothing.
    task = driver.step(
      task,
      { type: 'answer', text: 'Fine, and deploy it publicly too.' },
      asMember(owner)
    );
    expect(task.guards).toEqual(['access', 'publishing']);
    expect(task.blocked).toBeNull();
  });

  test("a comment's words guard the task as the request's would, once", () => {
    const driver = createDriver([owner, productContributor]);
    let task = toReady(driver, PAGE_PATHS);
    const words = { type: 'guard_words', text: 'Please also paste the API key here.' } as const;
    task = driver.step(task, words, asMember(productContributor));
    expect(task.guards).toEqual(['secrets']);
    expect(task.blocked).toMatchObject({ askedOf: { role: 'owner' } });
    expect(task.blocked?.question).toContain('secrets, credentials or environment values');
    expect(driver.events()).toContainEqual({ type: 'guards_changed', guards: ['secrets'] });
    task = driver.step(task, { type: 'answer', text: 'No key goes in.' }, asMember(owner));

    // Words the task is already guarded for change nothing.
    const again = driver.step(task, words, asMember(productContributor));
    expect(again).toEqual(task);
    expect(driver.events()).toEqual([]);
    expect(
      driver.attempt(task, { type: 'guard_words', text: 'Deploy it.' }, asMember(watcher))
    ).toEqual({ ok: false, error: 'not_allowed' });
  });

  test("guarded words replace a question for someone else, never the owner's hold", () => {
    const driver = createDriver([owner, productContributor]);
    const ready = toReady(driver, PAGE_PATHS);
    const asked = driver.step(
      ready,
      { type: 'block', question: 'Which colour?', askedOf: { role: 'contributor' } },
      asAgent('spec')
    );
    const held = driver.step(
      asked,
      { type: 'guard_words', text: 'Make it public tonight.' },
      asMember(productContributor)
    );
    expect(held.blocked?.askedOf).toEqual({ role: 'owner' });
    const ownersQuestion = driver.step(
      ready,
      { type: 'block', question: 'Which host?', askedOf: { role: 'owner' } },
      engine
    );
    const kept = driver.step(
      ownersQuestion,
      { type: 'guard_words', text: 'Make it public tonight.' },
      asMember(productContributor)
    );
    expect(kept.blocked?.question).toBe('Which host?');
    expect(kept.guards).toEqual(['publishing']);
  });

  test("a pull request closed while the task is held for the owner keeps the owner's hold", () => {
    const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };
    const driver = createDriver([owner, maintainer, productContributor]);
    const reviewing = driver.step(
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 10
      },
      asAgent('builder')
    );
    const held = driver.step(
      reviewing,
      { type: 'guard_words', text: 'Make it public tonight.' },
      asMember(productContributor)
    );
    expect(held.blocked?.askedOf).toEqual({ role: 'owner' });
    const closed = driver.step(held, { type: 'pull_request_closed', pullRequest: 7 }, engine);
    expect(closed).toMatchObject({ stage: 'ready', assignee: null, headSha: null });
    expect(closed.blocked).toEqual(held.blocked);
    expect(driver.events()).not.toContainEqual(expect.objectContaining({ type: 'blocked' }));
    expect(
      driver.attempt(closed, { type: 'answer', text: 'build it again' }, asMember(maintainer))
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      driver.step(closed, { type: 'answer', text: 'Not public.' }, asMember(owner)).blocked
    ).toBeNull();
  });

  test('a handoff for a secret, access or publishing guards the task like asking for it', () => {
    const driver = createDriver([owner]);
    const task = driver.step(
      toReady(driver, PAGE_PATHS),
      {
        type: 'block',
        question: 'The deploy needs a token.\n\nNeeded:\n- A deploy token',
        askedOf: { role: 'owner' },
        handoff: { needs: ['secrets', 'publishing', 'dns'] }
      },
      engine
    );
    expect(task.guards).toEqual(['secrets', 'publishing']);
    expect(driver.events()).toContainEqual({
      type: 'guards_changed',
      guards: ['secrets', 'publishing']
    });
    expect(effectivePolicy(driver.config, task, 'verifying')).toContainEqual({ role: 'owner' });
  });

  test("a change request's words guard the task and hold it for the owner, as an answer's would", () => {
    const driver = createDriver([owner, productContributor]);
    let verifying = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    verifying = buildAndReview(driver, verifying, 'abc', PAGE_PATHS);
    verifying = driver.step(
      verifying,
      { type: 'choose', userVisible: true, plan: PLAN },
      asAgent('chooser')
    );
    const sent = driver.step(
      verifying,
      { type: 'request_changes', note: 'Print the API key on the page.' },
      asMember(productContributor)
    );
    expect(sent).toMatchObject({ stage: 'building', guards: ['secrets'] });
    expect(sent.blocked?.askedOf).toEqual({ role: 'owner' });
    expect(driver.events()).toContainEqual({ type: 'guards_changed', guards: ['secrets'] });

    // The owner's own words guard the task and hold nothing.
    const specReview = driver.step(
      driver.step(
        driver.step(newTask('t2', owner.id), { type: 'submit_request' }, asMember(owner)),
        { type: 'accept' },
        asMember(owner)
      ),
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    const respec = driver.step(
      specReview,
      { type: 'request_changes', note: 'Deploy it publicly once merged.' },
      asMember(owner)
    );
    expect(respec).toMatchObject({ stage: 'speccing', guards: ['publishing'], blocked: null });
  });

  test('a change request naming a confidential term makes the task confidential', () => {
    const config = loadConfig(`${CONFIG_YAML}guards:\n  confidential_terms: ['Falcon']\n`);
    const driver = createDriver([owner, productContributor], config);
    let task = dispatchAgent(driver, toReady(driver, PAGE_PATHS, true));
    task = buildAndReview(driver, task, 'abc', PAGE_PATHS);
    task = driver.step(task, { type: 'choose', userVisible: true, plan: PLAN }, asAgent('chooser'));
    task = driver.step(
      task,
      { type: 'request_changes', note: 'Use the Falcon numbers.' },
      asMember(productContributor)
    );
    expect(task.guards).toEqual(['confidential']);
    expect(task.blocked?.askedOf).toEqual({ role: 'owner' });
  });

  test("a maintainer's review notes guard the task, and the owner's hold outlasts the fix-round limit", () => {
    const maintainer: Member = { id: 'marta', role: 'maintainer', domains: [] };
    const driver = createDriver([owner, maintainer]);
    const reviewing = driver.step(
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      {
        type: 'push',
        headSha: 'abc',
        changedPaths: PAGE_PATHS,
        addedPaths: [],
        catalogPages: {},
        diffLines: 40
      },
      asAgent('builder')
    );
    const review = {
      type: 'review',
      verdict: 'changes',
      notes: 'Make it public and grant me admin access.'
    } as const;
    const sent = driver.step(reviewing, review, asMember(maintainer));
    expect(sent).toMatchObject({ stage: 'building', guards: ['access', 'publishing'] });
    expect(sent.blocked?.askedOf).toEqual({ role: 'owner' });

    const exhausted = driver.step(
      { ...reviewing, fixRounds: driver.config.lanes.standard.fixRounds },
      review,
      asMember(maintainer)
    );
    expect(exhausted.stage).toBe('ready');
    expect(exhausted.blocked?.askedOf).toEqual({ role: 'owner' });
  });
});

describe('commands the task is not in a state for', () => {
  test("a second question never replaces an open one, the owner's hold included", () => {
    const driver = createDriver([owner, productContributor]);
    const held = driver.step(
      toReady(driver, PAGE_PATHS),
      { type: 'guard_words', text: 'Make it public tonight.' },
      asMember(productContributor)
    );
    expect(held.blocked?.askedOf).toEqual({ role: 'owner' });
    const question = {
      type: 'block',
      question: 'Which colour?',
      askedOf: { role: 'contributor' }
    } as const;
    for (const actor of [asAgent('spec'), engine, asMember(productContributor)]) {
      expect(driver.attempt(held, question, actor)).toEqual({
        ok: false,
        error: 'already_blocked'
      });
    }
    expect(
      driver.attempt(held, { type: 'answer', text: 'Blue.' }, asMember(productContributor))
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      driver.step(held, { type: 'answer', text: 'Not tonight.' }, asMember(owner)).blocked
    ).toBeNull();
  });

  test('an answer to a task with no open question is refused', () => {
    const driver = createDriver([owner]);
    expect(
      driver.attempt(newTask('t1', owner.id), { type: 'answer', text: 'it' }, asMember(owner))
    ).toEqual({ ok: false, error: 'not_blocked' });
  });

  test('a task with no lane is neither approved nor dispatched', () => {
    const driver = createDriver([owner]);
    let planned = newTask('t1', owner.id);
    planned = driver.step(planned, { type: 'submit_request' }, asMember(owner));
    planned = driver.step(planned, { type: 'accept' }, asMember(owner));
    planned = driver.step(
      planned,
      { type: 'post_spec', predictedPaths: PAGE_PATHS, userVisible: false },
      asAgent('spec')
    );
    planned = driver.step(
      planned,
      { type: 'plan_approval', userVisible: false, plan: PLAN },
      asAgent('chooser')
    );
    expect(planned.stage).toBe('spec_review');
    expect(
      driver.attempt({ ...planned, lane: null }, { type: 'approve' }, asMember(owner))
    ).toEqual({ ok: false, error: 'no_lane' });

    const ready = driver.step(planned, { type: 'approve' }, asMember(owner));
    const dispatch = {
      type: 'dispatch',
      assignee: { kind: 'agent', role: 'builder' },
      openInLane: 0
    } as const;
    expect(driver.attempt({ ...ready, lane: null }, dispatch, engine)).toEqual({
      ok: false,
      error: 'no_lane'
    });
  });

  test('a result is neither planned nor approved without a pushed head', () => {
    const driver = createDriver([owner]);
    const choosing = buildAndReview(
      driver,
      dispatchAgent(driver, toReady(driver, PAGE_PATHS)),
      'abc',
      PAGE_PATHS
    );
    const choose = { type: 'choose', userVisible: false, plan: PLAN } as const;
    expect(driver.attempt({ ...choosing, headSha: null }, choose, asAgent('chooser'))).toEqual({
      ok: false,
      error: 'no_head'
    });

    const verifying = driver.step(choosing, choose, asAgent('chooser'));
    expect(verifying.stage).toBe('verifying');
    expect(
      driver.attempt({ ...verifying, headSha: null }, { type: 'approve' }, asMember(owner))
    ).toEqual({ ok: false, error: 'no_head' });
  });
});
